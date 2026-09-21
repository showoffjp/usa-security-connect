import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, audit, UPLOAD_DIR } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { INCIDENT_CATEGORIES, INCIDENT_SEVERITY, ROLES, atLeast } from '../shared.js';
import { toSql } from '../services/compliance.js';

export const incidentsRouter = Router();
incidentsRouter.use(requireAuth);

const TIMES = ['occurred_at', 'created_at', 'reviewed_at'];

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10).replace(/[^.\w]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(new HttpError(422, 'Photos must be JPEG, PNG, WebP or HEIC.'));
    }
    cb(null, true);
  },
});

/** USC-2026-0041 style reference, unique per year. */
function nextRefNumber() {
  const year = new Date().getFullYear();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM incidents WHERE ref_number LIKE ?`)
    .get(`USC-${year}-%`);
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
    const ref = nextRefNumber();

    const postId = body.postId || null;
    const siteId =
      body.siteId ||
      (postId ? db.prepare(`SELECT site_id FROM posts WHERE id = ?`).get(postId)?.site_id : null) ||
      req.user.default_site_id ||
      null;

    const info = db
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
      );

    const incidentId = Number(info.lastInsertRowid);

    for (const file of req.files || []) {
      db.prepare(
        `INSERT INTO incident_photos (incident_id, filename, original_name, mime_type, size_bytes)
         VALUES (?,?,?,?,?)`
      ).run(incidentId, file.filename, file.originalname, file.mimetype, file.size);
    }

    audit(req.user.id, 'incident.created', 'incident', incidentId, { ref, severity: body.severity }, req.ip);

    const row = db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(incidentId);
    res.status(201).json({ incident: isoFields(row, TIMES), refNumber: ref, photos: (req.files || []).length });
  })
);

/* -------------------------------------------------------------- list --- */

incidentsRouter.get(
  '/',
  wrap(async (req, res) => {
    const mine = req.query.scope !== 'all' || !atLeast(req.user.role, ROLES.SUPERVISOR);
    const limit = Math.min(Number(req.query.limit) || 50, 200);

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
      params.push(Number(req.query.siteId));
    }
    if (req.query.search) {
      where.push('(i.what_happened LIKE ? OR i.ref_number LIKE ? OR i.location_text LIKE ?)');
      const q = `%${req.query.search}%`;
      params.push(q, q, q);
    }

    const rows = db
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
      .all(...params, limit);

    res.json({ incidents: rows.map((r) => isoFields(r, TIMES)) });
  })
);

incidentsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const row = db
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
      .get(req.params.id);

    if (!row) throw new HttpError(404, 'Incident not found.');
    if (row.user_id !== req.user.id && !atLeast(req.user.role, ROLES.SUPERVISOR)) {
      throw new HttpError(403, 'You can only open your own reports.');
    }

    const photos = db
      .prepare(`SELECT id, filename, original_name, caption FROM incident_photos WHERE incident_id = ?`)
      .all(row.id);

    res.json({ incident: isoFields(row, TIMES), photos });
  })
);

/** Photos are served through the API so they stay behind authentication. */
incidentsRouter.get(
  '/:id/photos/:photoId',
  wrap(async (req, res) => {
    const incident = db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(req.params.id);
    if (!incident) throw new HttpError(404, 'Incident not found.');
    if (incident.user_id !== req.user.id && !atLeast(req.user.role, ROLES.SUPERVISOR)) {
      throw new HttpError(403, 'Not permitted.');
    }
    const photo = db
      .prepare(`SELECT * FROM incident_photos WHERE id = ? AND incident_id = ?`)
      .get(req.params.photoId, req.params.id);
    if (!photo) throw new HttpError(404, 'Photo not found.');

    const filePath = path.join(UPLOAD_DIR, photo.filename);
    // Guard against a crafted filename escaping the upload directory.
    if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) {
      throw new HttpError(404, 'Photo file is missing.');
    }
    res.type(photo.mime_type || 'image/jpeg').sendFile(filePath);
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
    const incident = db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(req.params.id);
    if (!incident) throw new HttpError(404, 'Incident not found.');

    db.prepare(
      `UPDATE incidents
       SET status = ?, review_notes = ?, severity = COALESCE(?, severity),
           reviewed_by = ?, reviewed_at = datetime('now')
       WHERE id = ?`
    ).run(body.status, body.reviewNotes ?? null, body.severity ?? null, req.user.id, incident.id);

    audit(req.user.id, 'incident.reviewed', 'incident', incident.id, { status: body.status }, req.ip);
    res.json({ incident: isoFields(db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(incident.id), TIMES) });
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

    const info = db
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
      );

    audit(req.user.id, 'visit.logged', 'supervisor_visit', Number(info.lastInsertRowid), null, req.ip);
    res.status(201).json({ visit: db.prepare(`SELECT * FROM supervisor_visits WHERE id = ?`).get(info.lastInsertRowid) });
  })
);

visitsRouter.get(
  '/',
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const supervisorOnly = !atLeast(req.user.role, ROLES.ADMIN);
    const rows = db
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
      .all(...(supervisorOnly ? [req.user.id, req.user.id] : []), limit);

    res.json({ visits: rows.map((r) => isoFields(r, ['visited_at', 'created_at'])) });
  })
);
