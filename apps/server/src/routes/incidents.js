import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, idParam, limitParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { INCIDENT_CATEGORIES, INCIDENT_SEVERITY, ROLES, atLeast } from '../shared.js';
import { toSql } from '../services/compliance.js';
import * as storage from '../services/storage.js';
import { generateFilename } from '../services/storage.js';
import { notifySeriousIncident } from '../services/clientNotify.js';

export const incidentsRouter = Router();
incidentsRouter.use(requireAuth);

const TIMES = ['occurred_at', 'created_at', 'reviewed_at'];

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

// Buffered in memory, then handed to the storage service. A serverless
// function has no durable disk, so writing straight to one is not an option.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(new HttpError(422, 'Photos must be JPEG, PNG, WebP or HEIC.'));
    }
    cb(null, true);
  },
});

/** USC-2026-0041 style reference, unique per year. */
async function nextRefNumber() {
  const year = new Date().getFullYear();
  const row = (await db
    .prepare(`SELECT COUNT(*) AS n FROM incidents WHERE ref_number LIKE ?`)
    .get(`USC-${year}-%`));
  return `USC-${year}-${String(row.n + 1).padStart(4, '0')}`;
}

const incidentSchema = z.object({
  officerName: z.string().trim().max(120).optional(),
  callbackNumber: z.string().trim().max(40).optional(),
  category: z.enum(INCIDENT_CATEGORIES).optional(),
  severity: z.enum(INCIDENT_SEVERITY).default('low'),
  siteId: z.coerce.number().int().positive().optional(),
  postId: z.coerce.number().int().positive().optional(),
  tourRunId: z.coerce.number().int().positive().optional(),
  checkpointId: z.coerce.number().int().positive().optional(),
  occurredAt: z.string().min(1, 'Tell us when it happened.'),
  locationText: z.string().trim().max(300).optional(),
  whatHappened: z.string().trim().min(10, 'Describe what happened in at least a sentence.').max(5000),
  resolution: z.string().trim().max(5000).optional(),
  otherDetails: z.string().trim().max(5000).optional(),
  peopleInvolved: z.string().trim().max(1000).optional(),
  peopleNotified: z.string().trim().max(1000).optional(),
  policeNotified: z.coerce.boolean().optional(),
  policeReportNumber: z.string().trim().max(60).optional(),
  costRecovery: z.coerce.number().nonnegative().max(1_000_000).optional(),
});

/* ------------------------------------------------------------ create --- */

incidentsRouter.post(
  '/',
  upload.array('photos', 8),
  wrap(async (req, res) => {
    // multipart bodies arrive as strings; zod coercion handles the numbers.
    const body = parse(incidentSchema, req.body);
    const ref = await nextRefNumber();

    const postId = body.postId || null;
    const siteId =
      body.siteId ||
      (postId ? (await db.prepare(`SELECT site_id FROM posts WHERE id = ?`).get(postId))?.site_id : null) ||
      req.user.default_site_id ||
      null;

    const info = (await db
      .prepare(
        `INSERT INTO incidents
         (ref_number, user_id, site_id, post_id, tour_run_id, checkpoint_id, officer_name,
          callback_number, category, severity, occurred_at, location_text, what_happened,
          resolution, other_details, people_involved, people_notified, police_notified,
          police_report_number, cost_recovery_cents)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        ref,
        req.user.id,
        siteId,
        postId,
        body.tourRunId ?? null,
        body.checkpointId ?? null,
        body.officerName || `${req.user.first_name} ${req.user.last_name}`,
        body.callbackNumber || req.user.phone || null,
        body.category ?? null,
        body.severity,
        toSql(new Date(body.occurredAt)),
        body.locationText ?? null,
        body.whatHappened,
        body.resolution ?? null,
        body.otherDetails ?? null,
        body.peopleInvolved ?? null,
        body.peopleNotified ?? null,
        body.policeNotified ? 1 : 0,
        body.policeReportNumber ?? null,
        body.costRecovery != null ? Math.round(body.costRecovery * 100) : null
      ));

    const incidentId = Number(info.lastInsertRowid);

    for (const file of req.files || []) {
      const filename = generateFilename(file.originalname);
      const stored = await storage.put({
        buffer: file.buffer,
        filename,
        mimeType: file.mimetype,
      });

      await db
        .prepare(
          `INSERT INTO incident_photos (incident_id, filename, storage_url, original_name, mime_type, size_bytes)
           VALUES (?,?,?,?,?,?)`
        )
        .run(incidentId, stored.filename, stored.storageUrl, file.originalname, file.mimetype, file.size);
    }

    await audit(req.user.id, 'incident.created', 'incident', incidentId, { ref, severity: body.severity }, req.ip);
    // A serious incident is emailed to the property's contacts straight away.
    await notifySeriousIncident(incidentId).catch((err) => console.error('[usc] incident alert failed', err.message));

    const row = (await db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(incidentId));
    res.status(201).json({ incident: isoFields(row, TIMES), refNumber: ref, photos: (req.files || []).length });
  })
);

/* -------------------------------------------------------------- list --- */

incidentsRouter.get(
  '/',
  wrap(async (req, res) => {
    const mine = req.query.scope !== 'all' || !atLeast(req.user.role, ROLES.SUPERVISOR);
    const limit = limitParam(req.query.limit, 50, 200);

    const where = [];
    const params = [];
    if (mine) {
      where.push('i.user_id = ?');
      params.push(req.user.id);
    }
    if (req.query.status) {
      where.push('i.status = ?');
      params.push(req.query.status);
    }
    if (req.query.severity) {
      where.push('i.severity = ?');
      params.push(req.query.severity);
    }
    if (req.query.siteId) {
      where.push('i.site_id = ?');
      params.push(idParam(req.query.siteId, 'site'));
    }
    if (req.query.search) {
      where.push('(i.what_happened LIKE ? OR i.ref_number LIKE ? OR i.location_text LIKE ?)');
      const q = `%${req.query.search}%`;
      params.push(q, q, q);
    }

    const rows = (await db
      .prepare(
        `SELECT i.*, s.name AS site_name, p.name AS post_name,
                u.first_name || ' ' || u.last_name AS reported_by,
                (SELECT COUNT(*) FROM incident_photos ip WHERE ip.incident_id = i.id) AS photo_count
         FROM incidents i
         LEFT JOIN sites s ON s.id = i.site_id
         LEFT JOIN posts p ON p.id = i.post_id
         JOIN users u ON u.id = i.user_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY i.occurred_at DESC LIMIT ?`
      )
      .all(...params, limit));

    res.json({ incidents: rows.map((r) => isoFields(r, TIMES)) });
  })
);

/* ------------------------------------------------------- follow-ups --- */

const actionSelect = `
  SELECT a.*, o.first_name || ' ' || o.last_name AS owner_name,
         d.first_name || ' ' || d.last_name AS done_by_name,
         i.ref_number, i.category, i.severity, s.name AS site_name
  FROM incident_actions a
  JOIN incidents i ON i.id = a.incident_id
  LEFT JOIN sites s ON s.id = i.site_id
  LEFT JOIN users o ON o.id = a.owner_id
  LEFT JOIN users d ON d.id = a.done_by`;
const today = () => new Date().toISOString().slice(0, 10);
export const presentAction = (a) => {
  const due = a.due_on ? String(a.due_on).slice(0, 10) : null;
  return {
    ...isoFields(a, ['done_at', 'created_at']),
    due_on: due,
    overdue: a.status === 'open' && Boolean(due) && due < today(),
  };
};

async function actionsFor(incidentId) {
  return (await db.prepare(`${actionSelect} WHERE a.incident_id = ? ORDER BY a.status = 'done', a.due_on NULLS LAST, a.id`).all(incidentId)).map(presentAction);
}

/**
 * Every follow-up across incidents: the open ones first, soonest due first.
 * ?show=mine for the caller's own, ?show=overdue, or ?show=all (with done).
 */
incidentsRouter.get(
  '/follow-ups',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const show = ['mine', 'overdue', 'all', 'open'].includes(req.query.show) ? req.query.show : 'open';
    const where = [];
    const params = [];
    if (show !== 'all') where.push(`a.status = 'open'`);
    if (show === 'mine') {
      where.push('a.owner_id = ?');
      params.push(req.user.id);
    }
    if (show === 'overdue') {
      where.push('a.due_on < ?');
      params.push(today());
    }
    const rows = await db
      .prepare(`${actionSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.status = 'done', a.due_on NULLS LAST, a.id LIMIT 300`)
      .all(...params);
    const counts = await db
      .prepare(
        `SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN status = 'open' AND due_on < ? THEN 1 ELSE 0 END) AS overdue,
                SUM(CASE WHEN status = 'open' AND owner_id = ? THEN 1 ELSE 0 END) AS mine
         FROM incident_actions`
      )
      .get(today(), req.user.id);
    res.json({
      actions: rows.map(presentAction),
      counts: { open: Number(counts.open || 0), overdue: Number(counts.overdue || 0), mine: Number(counts.mine || 0) },
    });
  })
);

const actionSchema = z.object({
  title: z.string().trim().min(5, 'Say what needs doing.').max(300),
  ownerId: z.number().int().positive().optional().nullable(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a due date.').optional().nullable(),
  clientVisible: z.boolean().default(true),
});

/** Add a follow-up to an incident. The owner has to be a supervisor or administrator. */
incidentsRouter.post(
  '/:id/actions',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const incident = await db.prepare(`SELECT id FROM incidents WHERE id = ?`).get(idParam(req.params.id, 'incident'));
    if (!incident) throw new HttpError(404, 'Incident not found.');
    const body = parse(actionSchema, req.body);
    if (body.ownerId) {
      const owner = await db.prepare(`SELECT role, status FROM users WHERE id = ?`).get(body.ownerId);
      if (!owner || owner.status !== 'active' || !atLeast(owner.role, ROLES.SUPERVISOR)) {
        throw new HttpError(422, 'A follow-up is owned by a supervisor or administrator.', [
          { field: 'ownerId', message: 'Pick a supervisor or administrator.' },
        ]);
      }
    }
    const info = await db
      .prepare(`INSERT INTO incident_actions (incident_id, title, owner_id, due_on, client_visible, created_by) VALUES (?,?,?,?,?,?)`)
      .run(incident.id, body.title, body.ownerId ?? null, body.dueOn ?? null, body.clientVisible, req.user.id);
    await audit(req.user.id, 'incident_action.created', 'incident_action', info.lastInsertRowid, { incidentId: incident.id }, req.ip);
    res.status(201).json({ actions: await actionsFor(incident.id) });
  })
);

/** Mark a follow-up done (with what was done) or reopen it. */
incidentsRouter.patch(
  '/actions/:actionId',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const action = await db.prepare(`SELECT * FROM incident_actions WHERE id = ?`).get(idParam(req.params.actionId, 'follow-up'));
    if (!action) throw new HttpError(404, 'Follow-up not found.');
    const body = parse(
      z.object({
        status: z.enum(['open', 'done']),
        note: z.string().trim().max(1000).optional().nullable(),
      }),
      req.body
    );
    if (body.status === 'done') {
      if (!body.note || body.note.length < 3) {
        throw new HttpError(422, 'Say what was done.', [{ field: 'note', message: 'Say what was done.' }]);
      }
      await db
        .prepare(`UPDATE incident_actions SET status = 'done', done_note = ?, done_at = now(), done_by = ? WHERE id = ?`)
        .run(body.note, req.user.id, action.id);
    } else {
      await db.prepare(`UPDATE incident_actions SET status = 'open', done_note = NULL, done_at = NULL, done_by = NULL WHERE id = ?`).run(action.id);
    }
    await audit(req.user.id, `incident_action.${body.status === 'done' ? 'done' : 'reopened'}`, 'incident_action', action.id, null, req.ip);
    res.json({ actions: await actionsFor(action.incident_id) });
  })
);

incidentsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const row = (await db
      .prepare(
        `SELECT i.*, s.name AS site_name, p.name AS post_name,
                u.first_name || ' ' || u.last_name AS reported_by,
                r.first_name || ' ' || r.last_name AS reviewed_by_name
         FROM incidents i
         LEFT JOIN sites s ON s.id = i.site_id
         LEFT JOIN posts p ON p.id = i.post_id
         JOIN users u ON u.id = i.user_id
         LEFT JOIN users r ON r.id = i.reviewed_by
         WHERE i.id = ?`
      )
      .get(req.params.id));

    if (!row) throw new HttpError(404, 'Incident not found.');
    if (row.user_id !== req.user.id && !atLeast(req.user.role, ROLES.SUPERVISOR)) {
      throw new HttpError(403, 'You can only open your own reports.');
    }

    const photos = (await db
      .prepare(`SELECT id, filename, original_name, caption FROM incident_photos WHERE incident_id = ?`)
      .all(row.id));

    // Follow-ups carry internal notes, so the officer who filed it does not get them.
    const actions = atLeast(req.user.role, ROLES.SUPERVISOR) ? await actionsFor(row.id) : [];
    res.json({ incident: isoFields(row, TIMES), photos, actions });
  })
);

/** Photos are served through the API so they stay behind authentication. */
incidentsRouter.get(
  '/:id/photos/:photoId',
  wrap(async (req, res) => {
    const incident = (await db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(req.params.id));
    if (!incident) throw new HttpError(404, 'Incident not found.');
    if (incident.user_id !== req.user.id && !atLeast(req.user.role, ROLES.SUPERVISOR)) {
      throw new HttpError(403, 'Not permitted.');
    }
    const photo = (await db
      .prepare(`SELECT * FROM incident_photos WHERE id = ? AND incident_id = ?`)
      .get(req.params.photoId, req.params.id));
    if (!photo) throw new HttpError(404, 'Photo not found.');

    // The bytes are proxied rather than redirecting to the storage URL, so the
    // photo stays behind this endpoint's authentication and ownership checks.
    let buffer;
    try {
      buffer = await storage.read(photo);
    } catch (err) {
      throw new HttpError(404, err.message || 'Photo file is missing.');
    }

    res.type(photo.mime_type || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  })
);

/* ------------------------------------------------------------ review --- */

const reviewSchema = z.object({
  status: z.enum(['submitted', 'under_review', 'closed']),
  reviewNotes: z.string().max(3000).optional(),
  severity: z.enum(INCIDENT_SEVERITY).optional(),
});

incidentsRouter.patch(
  '/:id/review',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const body = parse(reviewSchema, req.body);
    const incident = (await db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(req.params.id));
    if (!incident) throw new HttpError(404, 'Incident not found.');

    (await db.prepare(
      `UPDATE incidents
       SET status = ?, review_notes = ?, severity = COALESCE(?, severity),
           reviewed_by = ?, reviewed_at = datetime('now')
       WHERE id = ?`
    ).run(body.status, body.reviewNotes ?? null, body.severity ?? null, req.user.id, incident.id));

    await audit(req.user.id, 'incident.reviewed', 'incident', incident.id, { status: body.status }, req.ip);
    // Raised to serious on review: the client hears about it now, once.
    await notifySeriousIncident(incident.id).catch((err) => console.error('[usc] incident alert failed', err.message));
    res.json({ incident: isoFields((await db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(incident.id)), TIMES) });
  })
);

/* -------------------------------------------------- supervisor visits --- */

export const visitsRouter = Router();
visitsRouter.use(requireAuth);

const visitSchema = z.object({
  officerId: z.number().int().positive().optional(),
  siteId: z.number().int().positive().optional(),
  postId: z.number().int().positive().optional(),
  visitedAt: z.string().optional(),
  uniformOk: z.boolean().optional(),
  postOrdersReviewed: z.boolean().optional(),
  equipmentOk: z.boolean().optional(),
  siteSecure: z.boolean().optional(),
  rating: z.number().int().min(1).max(5).optional(),
  notes: z.string().max(3000).optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
});

visitsRouter.post(
  '/',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const body = parse(visitSchema, req.body);
    const bit = (v) => (v == null ? null : v ? 1 : 0);

    const info = (await db
      .prepare(
        `INSERT INTO supervisor_visits
         (supervisor_id, officer_id, site_id, post_id, visited_at, uniform_ok,
          post_orders_reviewed, equipment_ok, site_secure, rating, notes, latitude, longitude)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        req.user.id,
        body.officerId ?? null,
        body.siteId ?? null,
        body.postId ?? null,
        toSql(body.visitedAt ? new Date(body.visitedAt) : new Date()),
        bit(body.uniformOk),
        bit(body.postOrdersReviewed),
        bit(body.equipmentOk),
        bit(body.siteSecure),
        body.rating ?? null,
        body.notes ?? null,
        body.latitude ?? null,
        body.longitude ?? null
      ));

    await audit(req.user.id, 'visit.logged', 'supervisor_visit', Number(info.lastInsertRowid), null, req.ip);
    res.status(201).json({ visit: (await db.prepare(`SELECT * FROM supervisor_visits WHERE id = ?`).get(info.lastInsertRowid)) });
  })
);

visitsRouter.get(
  '/',
  wrap(async (req, res) => {
    const limit = limitParam(req.query.limit, 50, 200);
    const supervisorOnly = !atLeast(req.user.role, ROLES.ADMIN);
    const rows = (await db
      .prepare(
        `SELECT v.*, s.name AS site_name, p.name AS post_name,
                sup.first_name || ' ' || sup.last_name AS supervisor_name,
                o.first_name || ' ' || o.last_name AS officer_name
         FROM supervisor_visits v
         LEFT JOIN sites s ON s.id = v.site_id
         LEFT JOIN posts p ON p.id = v.post_id
         JOIN users sup ON sup.id = v.supervisor_id
         LEFT JOIN users o ON o.id = v.officer_id
         ${supervisorOnly ? 'WHERE v.supervisor_id = ? OR v.officer_id = ?' : ''}
         ORDER BY v.visited_at DESC LIMIT ?`
      )
      .all(...(supervisorOnly ? [req.user.id, req.user.id] : []), limit));

    res.json({ visits: rows.map((r) => isoFields(r, ['visited_at', 'created_at'])) });
  })
);
