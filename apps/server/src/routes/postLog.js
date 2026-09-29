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
export const WATCH_ACTIONS = ['deny_entry', 'call_police', 'notify_supervisor', 'escort'];
export const WATCH_RISKS = ['low', 'medium', 'high'];
export const VIOLATIONS = ['fire_lane', 'no_permit', 'accessible', 'blocking', 'abandoned', 'reserved', 'other'];
export const VIOLATION_ACTIONS = ['warning', 'tagged', 'booted', 'towed'];
/** How far back a plate's history counts towards "repeat offender". */
const REPEAT_WINDOW_DAYS = 180;
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

/* =============================================================== watchlist == */

const normName = (v) => String(v || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
export const normPlate = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Entries that apply at a site today: its own, and the company-wide ones. */
async function watchlistFor(siteId) {
  const rows = await db
    .prepare(
      `SELECT w.*, s.name AS site_name, u.first_name || ' ' || u.last_name AS added_by_name
       FROM watchlist w
       LEFT JOIN sites s ON s.id = w.site_id
       LEFT JOIN users u ON u.id = w.added_by
       WHERE w.active = true AND (w.expires_on IS NULL OR w.expires_on >= current_date)
         AND (w.site_id IS NULL OR w.site_id = ?)
       ORDER BY CASE w.risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, w.full_name`
    )
    .all(siteId);
  return rows.map(presentWatch);
}

const presentWatch = (w) => ({ ...isoFields(w, ['created_at']), active: Boolean(w.active) });

/**
 * Does a name or plate match anyone on the site's watchlist? Names match on
 * the whole name or any alias, ignoring case and punctuation; plates ignore
 * spaces and dashes. Exact rather than fuzzy on purpose: a false alarm at the
 * desk is an argument with an innocent visitor.
 */
export async function watchlistMatches(siteId, { fullName, plate }) {
  const name = normName(fullName);
  const tag = normPlate(plate);
  const entries = await watchlistFor(siteId);
  return entries.filter((w) => {
    const names = [w.full_name, ...String(w.aliases || '').split(',')].map(normName).filter(Boolean);
    return (name && names.includes(name)) || (tag && w.vehicle_plate && normPlate(w.vehicle_plate) === tag);
  });
}

/* ================================================================ visitors == */

const visitorSelect = `
  SELECT v.*, s.name AS site_name, p.name AS post_name,
         lb.first_name || ' ' || lb.last_name AS logged_by_name,
         db2.first_name || ' ' || db2.last_name AS departed_by_name,
         w.full_name AS watchlist_name, w.action AS watchlist_action
  FROM visitor_log v
  JOIN sites s ON s.id = v.site_id
  LEFT JOIN posts p ON p.id = v.post_id
  LEFT JOIN watchlist w ON w.id = v.watchlist_id
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
  /** Sign in despite a watchlist match: which entry, and why. */
  override: z
    .object({
      watchlistId: z.number().int().positive(),
      reason: z.string().trim().min(5, 'Say why they are being let in - a supervisor will read this.').max(300),
    })
    .optional()
    .nullable(),
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

    // Checked on every sign-in. A match stops it and tells the officer what
    // to do; they can still let the person in - the wrong John Smith - but
    // only by naming the entry and giving a reason, which is kept.
    const matches = await watchlistMatches(post.site_id, { fullName: body.fullName, plate: body.vehiclePlate });
    let watchlistId = null;
    let notes = body.notes || null;
    if (matches.length) {
      const chosen = body.override && matches.find((m) => m.id === body.override.watchlistId);
      if (!chosen) {
        throw new HttpError(409, `${body.fullName} matches the watchlist for this site. Follow the instruction on the entry before signing them in.`, {
          code: 'watchlist_match',
          matches,
        });
      }
      watchlistId = chosen.id;
      notes = `Watchlist match overridden: ${body.override.reason}${notes ? ` | ${notes}` : ''}`;
    }

    const info = await db
      .prepare(
        `INSERT INTO visitor_log (site_id, post_id, full_name, company, purpose, host, kind, vehicle_plate,
           vehicle_desc, badge_number, notes, logged_by, watchlist_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        post.site_id, post.post_id, body.fullName, body.company || null, body.purpose, body.host || null, body.kind,
        body.vehiclePlate, body.vehicleDesc || null, body.badgeNumber || null, notes, req.user.id, watchlistId
      );
    await audit(req.user.id, watchlistId ? 'visitor.watchlist_override' : 'visitor.signed_in', 'visitor_log',
      info.lastInsertRowid, { siteId: post.site_id, watchlistId, reason: body.override?.reason }, req.ip);
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

    const watchlist = await watchlistFor(post.site_id);
    let vehicles = null;
    if (post.onDuty) {
      vehicles = (
        await db
          .prepare(
            `${violationSelect} WHERE vv.site_id = ? AND vv.occurred_at >= ? ORDER BY vv.occurred_at DESC LIMIT 50`
          )
          .all(REPEAT_WINDOW_DAYS, post.site_id, toSql(new Date(Date.now() - 7 * 86400000)))
      ).map(presentViolation);
    }

    res.json({
      post, onDuty: post.onDuty, visitors, passdown, unacked, watchlist, vehicles,
      kinds: VISITOR_KINDS, violations: VIOLATIONS, violationActions: VIOLATION_ACTIONS,
    });
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

/* =============================================================== vehicles == */

// Each row carries how many violations its plate has had anywhere in the
// window before it, so "third time this month" is visible on the row itself.
const violationSelect = `
  SELECT vv.*, s.name AS site_name, p.name AS post_name,
         u.first_name || ' ' || u.last_name AS logged_by_name,
         (SELECT COUNT(*) FROM vehicle_violations o
           WHERE o.plate = vv.plate AND o.occurred_at <= vv.occurred_at
             AND o.occurred_at > vv.occurred_at - make_interval(days => ?)) AS plate_count
  FROM vehicle_violations vv
  JOIN sites s ON s.id = vv.site_id
  LEFT JOIN posts p ON p.id = vv.post_id
  LEFT JOIN users u ON u.id = vv.logged_by`;

const presentViolation = (v) => ({ ...isoFields(v, ['occurred_at', 'created_at']), plate_count: Number(v.plate_count) });

const violationSchema = z.object({
  plate: z
    .string()
    .trim()
    .min(2, 'Enter the plate.')
    .max(16)
    .transform((v) => normPlate(v))
    .refine((v) => v.length >= 2, 'Enter the plate.'),
  plateState: z.string().trim().max(4).optional().nullable(),
  vehicleDesc: z.string().trim().max(80).optional().nullable(),
  locationText: z.string().trim().max(120).optional().nullable(),
  violation: z.enum(VIOLATIONS),
  action: z.enum(VIOLATION_ACTIONS).default('warning'),
  notes: z.string().trim().max(500).optional().nullable(),
});

/** Log a violation at the post the officer is on. */
postLogRouter.post(
  '/vehicles',
  wrap(async (req, res) => {
    const body = parse(violationSchema, req.body);
    const post = await requireDuty(req);
    const info = await db
      .prepare(
        `INSERT INTO vehicle_violations (site_id, post_id, plate, plate_state, vehicle_desc, location_text, violation,
           action, notes, logged_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        post.site_id, post.post_id, body.plate, body.plateState ? body.plateState.toUpperCase() : null, body.vehicleDesc || null,
        body.locationText || null, body.violation, body.action, body.notes || null, req.user.id
      );
    await audit(req.user.id, 'vehicle.violation', 'vehicle_violation', info.lastInsertRowid, { plate: body.plate, action: body.action }, req.ip);
    const row = await db.prepare(`${violationSelect} WHERE vv.id = ?`).get(REPEAT_WINDOW_DAYS, info.lastInsertRowid);
    res.status(201).json({ violation: presentViolation(row) });
  })
);

/**
 * Everything known about a plate: its violations anywhere, the visits it came
 * with, and any watchlist entry. Asked before deciding between a warning and a
 * tow, so it is open to any officer on duty as well as supervisors.
 */
postLogRouter.get(
  '/vehicles/lookup',
  wrap(async (req, res) => {
    const plate = normPlate(req.query.plate);
    if (plate.length < 2) throw new HttpError(422, 'Enter at least two characters of the plate.');
    let siteId = null;
    if (!atLeast(req.user.role, ROLES.SUPERVISOR)) siteId = (await requireDuty(req)).site_id;

    const violations = (
      await db.prepare(`${violationSelect} WHERE vv.plate = ? ORDER BY vv.occurred_at DESC LIMIT 25`).all(REPEAT_WINDOW_DAYS, plate)
    ).map(presentViolation);
    const visits = (
      await db
        .prepare(
          `${visitorSelect} WHERE regexp_replace(upper(coalesce(v.vehicle_plate, '')), '[^A-Z0-9]', '', 'g') = ?
           ORDER BY v.arrived_at DESC LIMIT 10`
        )
        .all(plate)
    ).map(presentVisitor);
    const since = Date.now() - REPEAT_WINDOW_DAYS * 86400000;
    const recent = violations.filter((v) => new Date(v.occurred_at).getTime() > since).length;
    const watch = siteId
      ? await watchlistMatches(siteId, { plate })
      : (await db.prepare(`SELECT * FROM watchlist WHERE active = true`).all())
          .filter((w) => w.vehicle_plate && normPlate(w.vehicle_plate) === plate)
          .map(presentWatch);

    res.json({ plate, violations, visits, watchlist: watch, recentCount: recent, repeatOffender: recent >= 2, windowDays: REPEAT_WINDOW_DAYS });
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

/* ----------------------------------------------- supervisors: watchlist -- */

const watchSchema = z.object({
  siteId: z.number().int().positive().nullable().optional(),
  fullName: z.string().trim().min(2, 'Enter the name.').max(120),
  aliases: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().max(400).optional().nullable(),
  vehiclePlate: z.string().trim().max(16).optional().nullable(),
  reason: z.string().trim().min(5, 'Say why they are on the list - officers act on this.').max(500),
  action: z.enum(WATCH_ACTIONS).default('deny_entry'),
  risk: z.enum(WATCH_RISKS).default('medium'),
  expiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date.')
    .optional()
    .nullable(),
});

postLogRouter.get(
  '/admin/watchlist',
  supervisor,
  wrap(async (req, res) => {
    const all = req.query.all === '1';
    const siteId = req.query.siteId ? Number(req.query.siteId) : null;
    const rows = await db
      .prepare(
        `SELECT w.*, s.name AS site_name, u.first_name || ' ' || u.last_name AS added_by_name,
                (SELECT COUNT(*) FROM visitor_log v WHERE v.watchlist_id = w.id) AS overrides,
                (w.expires_on IS NOT NULL AND w.expires_on < current_date) AS expired
         FROM watchlist w
         LEFT JOIN sites s ON s.id = w.site_id
         LEFT JOIN users u ON u.id = w.added_by
         WHERE ${all ? 'true' : `w.active = true AND (w.expires_on IS NULL OR w.expires_on >= current_date)`}
           ${siteId ? 'AND (w.site_id = ? OR w.site_id IS NULL)' : ''}
         ORDER BY w.active DESC, CASE w.risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, w.full_name`
      )
      .all(...(siteId ? [siteId] : []));
    const hits = await db
      .prepare(
        `${visitorSelect} WHERE v.watchlist_id IS NOT NULL ORDER BY v.arrived_at DESC LIMIT 20`
      )
      .all();
    res.json({
      entries: rows.map((w) => ({ ...presentWatch(w), overrides: Number(w.overrides), expired: Boolean(w.expired) })),
      overrides: hits.map(presentVisitor),
      actions: WATCH_ACTIONS,
      risks: WATCH_RISKS,
    });
  })
);

postLogRouter.post(
  '/admin/watchlist',
  supervisor,
  wrap(async (req, res) => {
    const body = parse(watchSchema, req.body);
    if (body.siteId && !(await db.prepare(`SELECT id FROM sites WHERE id = ?`).get(body.siteId))) {
      throw new HttpError(422, 'That site does not exist.');
    }
    const info = await db
      .prepare(
        `INSERT INTO watchlist (site_id, full_name, aliases, description, vehicle_plate, reason, action, risk, expires_on, added_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        body.siteId || null, body.fullName, body.aliases || null, body.description || null,
        body.vehiclePlate ? body.vehiclePlate.toUpperCase() : null, body.reason, body.action, body.risk,
        body.expiresOn || null, req.user.id
      );
    await audit(req.user.id, 'watchlist.added', 'watchlist', info.lastInsertRowid, { siteId: body.siteId || null }, req.ip);
    const row = await db.prepare(`SELECT * FROM watchlist WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ entry: presentWatch(row) });
  })
);

/** Edit an entry, or take it off the list (active: false) - never deleted, the history matters. */
postLogRouter.patch(
  '/admin/watchlist/:id',
  supervisor,
  wrap(async (req, res) => {
    const entry = await db.prepare(`SELECT * FROM watchlist WHERE id = ?`).get(Number(req.params.id));
    if (!entry) throw new HttpError(404, 'Watchlist entry not found.');
    const body = parse(watchSchema.partial().extend({ active: z.boolean().optional() }), req.body);
    const map = {
      siteId: 'site_id', fullName: 'full_name', aliases: 'aliases', description: 'description', vehiclePlate: 'vehicle_plate',
      reason: 'reason', action: 'action', risk: 'risk', expiresOn: 'expires_on', active: 'active',
    };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) {
      if (body[k] === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(k === 'vehiclePlate' && body[k] ? body[k].toUpperCase() : body[k] === '' ? null : body[k]);
    }
    if (!sets.length) throw new HttpError(422, 'Nothing to change.');
    await db.prepare(`UPDATE watchlist SET ${sets.join(', ')} WHERE id = ?`).run(...params, entry.id);
    await audit(req.user.id, body.active === false ? 'watchlist.removed' : 'watchlist.updated', 'watchlist', entry.id, null, req.ip);
    const row = await db.prepare(`SELECT * FROM watchlist WHERE id = ?`).get(entry.id);
    res.json({ entry: presentWatch(row) });
  })
);

/* ------------------------------------------------ supervisors: vehicles -- */

postLogRouter.get(
  '/admin/vehicles',
  supervisor,
  wrap(async (req, res) => {
    const siteId = req.query.siteId ? Number(req.query.siteId) : null;
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = toSql(new Date(Date.now() - days * 86400000));
    const rows = await db
      .prepare(
        `${violationSelect} WHERE vv.occurred_at >= ? ${siteId ? 'AND vv.site_id = ?' : ''}
         ORDER BY vv.occurred_at DESC LIMIT 500`
      )
      .all(REPEAT_WINDOW_DAYS, since, ...(siteId ? [siteId] : []));
    const repeat = await db
      .prepare(
        `SELECT plate, COUNT(*) AS n, MAX(occurred_at) AS last_at,
                string_agg(DISTINCT violation, ',') AS kinds,
                SUM(CASE WHEN action = 'towed' THEN 1 ELSE 0 END) AS towed
         FROM vehicle_violations
         WHERE occurred_at >= ? ${siteId ? 'AND site_id = ?' : ''}
         GROUP BY plate HAVING COUNT(*) >= 2
         ORDER BY n DESC, last_at DESC LIMIT 20`
      )
      .all(toSql(new Date(Date.now() - REPEAT_WINDOW_DAYS * 86400000)), ...(siteId ? [siteId] : []));
    res.json({
      violations: rows.map(presentViolation),
      repeatOffenders: repeat.map((r) => ({ ...isoFields(r, ['last_at']), n: Number(r.n), towed: Number(r.towed) })),
      windowDays: REPEAT_WINDOW_DAYS,
    });
  })
);
