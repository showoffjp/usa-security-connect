/**
 * The post's own logs: who came through, and what one shift tells the next.
 *
 * Both are written by the officer standing on the post, so both hang off the
 * officer's open time entry - the post they are clocked in at is the only one
 * they can write to. A visitor can be signed out by any officer on the same
 * site (people leave by a different door), and supervisors can read and tidy
 * every site's log.
 *
 * Pass-down notes can be read before the shift starts: an officer due on a
 * post in the next few hours sees what the last shift left for them, and
 * acknowledges each note so the supervisor knows it was read.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, parseDay } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, atLeast } from '../shared.js';
import { toSql } from '../services/compliance.js';

export const postLogRouter = Router();
postLogRouter.use(requireAuth);

export const VISITOR_KINDS = ['visitor', 'contractor', 'delivery', 'vendor', 'other'];
const VISITOR_TIMES = ['arrived_at', 'departed_at', 'created_at'];
const NOTE_TIMES = ['created_at', 'acked_at'];

/** How far back an officer's pass-down view reaches. */
const PASSDOWN_DAYS = 7;
/** How soon before a shift its officer can read the post's pass-down. */
const PASSDOWN_LEAD_HOURS = 12;

/** The post the officer is clocked in at, if any. */
async function dutyPost(userId) {
  return db
    .prepare(
      `SELECT te.id AS time_entry_id, p.id AS post_id, p.name AS post_name, p.post_code,
              s.id AS site_id, s.name AS site_name
       FROM time_entries te
       JOIN posts p ON p.id = te.post_id
       JOIN sites s ON s.id = p.site_id
       WHERE te.user_id = ? AND te.clock_out_at IS NULL
       ORDER BY te.clock_in_at DESC LIMIT 1`
    )
    .get(userId);
}

/**
 * The post whose pass-down the officer should be reading: where they are on
 * duty, or else where their next shift in the coming hours is.
 */
async function readingPost(userId) {
  const onDuty = await dutyPost(userId);
  if (onDuty) return { ...onDuty, onDuty: true };
  const now = new Date();
  const next = await db
    .prepare(
      `SELECT p.id AS post_id, p.name AS post_name, p.post_code, s.id AS site_id, s.name AS site_name,
              sh.starts_at
       FROM shifts sh
       JOIN posts p ON p.id = sh.post_id
       JOIN sites s ON s.id = p.site_id
       WHERE sh.user_id = ? AND sh.status IN ('scheduled','in_progress')
         AND sh.ends_at > ? AND sh.starts_at < ?
       ORDER BY sh.starts_at LIMIT 1`
    )
    .get(userId, toSql(now), toSql(new Date(now.getTime() + PASSDOWN_LEAD_HOURS * 3600000)));
  return next ? { ...isoFields(next, ['starts_at']), onDuty: false } : null;
}

async function requireDuty(req) {
  const post = await dutyPost(req.user.id);
  if (!post) throw new HttpError(409, 'Clock in at your post first - the log belongs to the post you are on.');
  return post;
}

/* ================================================================ visitors == */

const visitorSelect = `
  SELECT v.*, s.name AS site_name, p.name AS post_name,
         lb.first_name || ' ' || lb.last_name AS logged_by_name,
         db2.first_name || ' ' || db2.last_name AS departed_by_name
  FROM visitor_log v
  JOIN sites s ON s.id = v.site_id
  LEFT JOIN posts p ON p.id = v.post_id
  LEFT JOIN users lb ON lb.id = v.logged_by
  LEFT JOIN users db2 ON db2.id = v.departed_by`;

const presentVisitor = (v) => isoFields(v, VISITOR_TIMES);

const visitorSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the visitor\'s name.').max(120),
  company: z.string().trim().max(120).optional().nullable(),
  purpose: z.string().trim().min(2, 'Say what they are here for.').max(200),
  host: z.string().trim().max(120).optional().nullable(),
  kind: z.enum(VISITOR_KINDS).default('visitor'),
  vehiclePlate: z
    .string()
    .trim()
    .max(16)
    .optional()
    .nullable()
    .transform((v) => (v ? v.toUpperCase().replace(/\s+/g, ' ') : null)),
  vehicleDesc: z.string().trim().max(80).optional().nullable(),
  badgeNumber: z.string().trim().max(20).optional().nullable(),
  notes: z.string().trim().max(300).optional().nullable(),
});

/** Sign someone in at the post the officer is standing on. */
postLogRouter.post(
  '/visitors',
  wrap(async (req, res) => {
    const body = parse(visitorSchema, req.body);
    const post = await requireDuty(req);

    const already = await db
      .prepare(`SELECT id FROM visitor_log WHERE site_id = ? AND departed_at IS NULL AND lower(full_name) = lower(?)`)
      .get(post.site_id, body.fullName);
    if (already) {
      throw new HttpError(409, `${body.fullName} is already signed in here. Sign them out first, or check the name.`);
    }

    const info = await db
      .prepare(
        `INSERT INTO visitor_log (site_id, post_id, full_name, company, purpose, host, kind, vehicle_plate,
           vehicle_desc, badge_number, notes, logged_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        post.site_id, post.post_id, body.fullName, body.company || null, body.purpose, body.host || null, body.kind,
        body.vehiclePlate, body.vehicleDesc || null, body.badgeNumber || null, body.notes || null, req.user.id
      );
    await audit(req.user.id, 'visitor.signed_in', 'visitor_log', info.lastInsertRowid, { siteId: post.site_id }, req.ip);
    const row = await db.prepare(`${visitorSelect} WHERE v.id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ visitor: presentVisitor(row) });
  })
);

/**
 * Sign someone out. Any officer on duty at the same site can - people leave by
 * the other door - and a supervisor can close off anyone left signed in.
 */
postLogRouter.post(
  '/visitors/:id/depart',
  wrap(async (req, res) => {
    const visitor = await db.prepare(`SELECT * FROM visitor_log WHERE id = ?`).get(Number(req.params.id));
    if (!visitor) throw new HttpError(404, 'Visitor not found.');
    if (!atLeast(req.user.role, ROLES.SUPERVISOR)) {
      const post = await requireDuty(req);
      if (post.site_id !== visitor.site_id) throw new HttpError(404, 'Visitor not found.');
    }
    if (visitor.departed_at) throw new HttpError(409, 'Already signed out.');
    await db
      .prepare(`UPDATE visitor_log SET departed_at = now(), departed_by = ? WHERE id = ?`)
      .run(req.user.id, visitor.id);
    await audit(req.user.id, 'visitor.signed_out', 'visitor_log', visitor.id, null, req.ip);
    const row = await db.prepare(`${visitorSelect} WHERE v.id = ?`).get(visitor.id);
    res.json({ visitor: presentVisitor(row) });
  })
);

/* ============================================================== pass-down == */

async function notesFor(postId, userId) {
  const since = toSql(new Date(Date.now() - PASSDOWN_DAYS * 86400000));
  const rows = await db
    .prepare(
      `SELECT n.*, u.first_name || ' ' || u.last_name AS author_name,
              (SELECT a.acked_at FROM passdown_acks a WHERE a.note_id = n.id AND a.user_id = ?) AS acked_at
       FROM passdown_notes n
       LEFT JOIN users u ON u.id = n.author_id
       WHERE n.post_id = ? AND n.created_at >= ?
       ORDER BY n.created_at DESC
       LIMIT 50`
    )
    .all(userId, postId, since);
  return rows.map((n) => ({ ...isoFields(n, NOTE_TIMES), mine: n.author_id === userId }));
}

/** Everything the officer's post log screen needs. */
postLogRouter.get(
  '/',
  wrap(async (req, res) => {
    const post = await readingPost(req.user.id);
    if (!post) return res.json({ post: null, onDuty: false, visitors: null, passdown: [], unacked: 0 });

    const passdown = await notesFor(post.post_id, req.user.id);
    const unacked = passdown.filter((n) => !n.mine && !n.acked_at).length;

    let visitors = null;
    if (post.onDuty) {
      const since = toSql(new Date(Date.now() - 24 * 3600000));
      const rows = await db
        .prepare(
          `${visitorSelect}
           WHERE v.site_id = ? AND (v.departed_at IS NULL OR v.arrived_at >= ?)
           ORDER BY CASE WHEN v.departed_at IS NULL THEN 0 ELSE 1 END, v.arrived_at DESC
           LIMIT 100`
        )
        .all(post.site_id, since);
      visitors = {
        onSite: rows.filter((v) => !v.departed_at).map(presentVisitor),
        earlier: rows.filter((v) => v.departed_at).map(presentVisitor),
      };
    }

    res.json({ post, onDuty: post.onDuty, visitors, passdown, unacked, kinds: VISITOR_KINDS });
  })
);

const noteSchema = z.object({
  body: z.string().trim().min(5, 'Write enough for the next officer to act on.').max(1000),
  priority: z.enum(['normal', 'important']).default('normal'),
});

postLogRouter.post(
  '/passdown',
  wrap(async (req, res) => {
    const body = parse(noteSchema, req.body);
    const post = await requireDuty(req);
    const info = await db
      .prepare(`INSERT INTO passdown_notes (post_id, author_id, time_entry_id, body, priority) VALUES (?,?,?,?,?)`)
      .run(post.post_id, req.user.id, post.time_entry_id, body.body, body.priority);
    await audit(req.user.id, 'passdown.written', 'passdown_note', info.lastInsertRowid, { postId: post.post_id }, req.ip);
    const note = (await notesFor(post.post_id, req.user.id)).find((n) => n.id === info.lastInsertRowid);
    res.status(201).json({ note });
  })
);

/** "Read it." Only for the post the officer is on, or about to be. */
postLogRouter.post(
  '/passdown/:id/ack',
  wrap(async (req, res) => {
    const note = await db.prepare(`SELECT * FROM passdown_notes WHERE id = ?`).get(Number(req.params.id));
    const post = await readingPost(req.user.id);
    if (!note || !post || note.post_id !== post.post_id) throw new HttpError(404, 'Note not found.');
    if (note.author_id === req.user.id) throw new HttpError(422, 'That note is your own.');
    await db
      .prepare(`INSERT INTO passdown_acks (note_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING`)
      .run(note.id, req.user.id);
    res.json({ ok: true });
  })
);

/* ============================================================ supervisors == */

const supervisor = requireRole(ROLES.SUPERVISOR);

/** Every site's visitors for a day, or everyone still on site anywhere. */
postLogRouter.get(
  '/admin/visitors',
  supervisor,
  wrap(async (req, res) => {
    const siteId = req.query.siteId ? Number(req.query.siteId) : null;
    const onSite = req.query.onSite === '1' || req.query.onSite === 'true';
    const start = parseDay(req.query.date);
    if (!start) throw new HttpError(422, 'That date is not valid.');
    const end = new Date(start.getTime() + 86400000);

    const where = [];
    const params = [];
    if (siteId) {
      where.push('v.site_id = ?');
      params.push(siteId);
    }
    if (onSite) where.push('v.departed_at IS NULL');
    else {
      // A day's log is everyone who arrived that day, plus anyone who arrived
      // earlier and was still inside when it began.
      where.push('(v.arrived_at >= ? AND v.arrived_at < ?) OR (v.arrived_at < ? AND (v.departed_at IS NULL OR v.departed_at >= ?))');
      params.push(toSql(start), toSql(end), toSql(start), toSql(start));
    }
    const rows = await db
      .prepare(`${visitorSelect} WHERE ${where.map((w) => `(${w})`).join(' AND ')} ORDER BY v.arrived_at DESC LIMIT 500`)
      .all(...params);

    const counts = await db
      .prepare(
        `SELECT s.id, s.name, COUNT(v.id) AS on_site
         FROM sites s LEFT JOIN visitor_log v ON v.site_id = s.id AND v.departed_at IS NULL
         WHERE s.active = 1 GROUP BY s.id, s.name ORDER BY s.name`
      )
      .all();

    res.json({
      visitors: rows.map(presentVisitor),
      sites: counts,
      onSiteTotal: counts.reduce((n, s) => n + Number(s.on_site), 0),
    });
  })
);

/** Pass-down across posts, with who has read each note. */
postLogRouter.get(
  '/admin/passdown',
  supervisor,
  wrap(async (req, res) => {
    const siteId = req.query.siteId ? Number(req.query.siteId) : null;
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
    const since = toSql(new Date(Date.now() - days * 86400000));
    const notes = await db
      .prepare(
        `SELECT n.*, u.first_name || ' ' || u.last_name AS author_name, p.name AS post_name,
                s.id AS site_id, s.name AS site_name
         FROM passdown_notes n
         JOIN posts p ON p.id = n.post_id
         JOIN sites s ON s.id = p.site_id
         LEFT JOIN users u ON u.id = n.author_id
         WHERE n.created_at >= ? ${siteId ? 'AND s.id = ?' : ''}
         ORDER BY n.created_at DESC LIMIT 300`
      )
      .all(since, ...(siteId ? [siteId] : []));
    const acks = notes.length
      ? await db
          .prepare(
            `SELECT a.note_id, a.acked_at, u.first_name || ' ' || u.last_name AS name
             FROM passdown_acks a JOIN users u ON u.id = a.user_id
             WHERE a.note_id IN (${notes.map(() => '?').join(',')}) ORDER BY a.acked_at`
          )
          .all(...notes.map((n) => n.id))
      : [];
    res.json({
      notes: notes.map((n) => ({
        ...isoFields(n, NOTE_TIMES),
        acks: acks.filter((a) => a.note_id === n.id).map((a) => isoFields(a, ['acked_at'])),
      })),
    });
  })
);
