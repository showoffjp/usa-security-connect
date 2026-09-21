import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, sqlToIso, isoFields } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import {
  RULES,
  FLAG_TYPES,
  evaluateGeofence,
  minutesBetween,
} from '../shared.js';
import {
  toSql,
  raiseFlag,
  scheduleNextCheckIn,
  currentCheckIn,
  answerCheckIn,
} from '../services/compliance.js';

export const timeclockRouter = Router();
timeclockRouter.use(requireAuth);

const ENTRY_TIMES = ['clock_in_at', 'clock_out_at', 'created_at'];

const geoSchema = z.object({
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  accuracy: z.number().nonnegative().nullable().optional(),
});

function openEntryFor(userId) {
  return db
    .prepare(
      `SELECT te.*, p.name AS post_name, p.instructions, p.check_in_interval_min,
              p.latitude AS post_lat, p.longitude AS post_lng, p.geofence_radius_m,
              p.post_code, s.name AS site_name, s.address, s.city, s.state,
              sh.starts_at AS shift_starts_at, sh.ends_at AS shift_ends_at
       FROM time_entries te
       JOIN posts p ON p.id = te.post_id
       JOIN sites s ON s.id = p.site_id
       LEFT JOIN shifts sh ON sh.id = te.shift_id
       WHERE te.user_id = ? AND te.clock_out_at IS NULL
       ORDER BY te.clock_in_at DESC LIMIT 1`
    )
    .get(userId);
}

/**
 * The shift an officer is expected to work right now: the closest scheduled
 * shift whose start is within the early-clock-in window, or one already running.
 */
function currentShiftFor(userId) {
  const now = new Date();
  const from = toSql(new Date(now.getTime() - 12 * 60 * 60000));
  const to = toSql(new Date(now.getTime() + RULES.earlyClockInMinutes * 60000));
  return db
    .prepare(
      `SELECT sh.*, p.name AS post_name, p.post_code, p.instructions,
              p.latitude AS post_lat, p.longitude AS post_lng,
              p.geofence_radius_m, p.check_in_interval_min, p.requires_gps,
              s.name AS site_name, s.address, s.city, s.state
       FROM shifts sh
       JOIN posts p ON p.id = sh.post_id
       JOIN sites s ON s.id = p.site_id
       WHERE sh.user_id = ?
         AND sh.status IN ('scheduled','in_progress')
         AND sh.starts_at BETWEEN ? AND ?
       ORDER BY ABS(strftime('%s', sh.starts_at) - strftime('%s', ?))
       LIMIT 1`
    )
    .get(userId, from, to, toSql(now));
}

/* ------------------------------------------------------------- dashboard --- */

/** Everything the officer's home screen needs, in one round trip. */
timeclockRouter.get(
  '/status',
  wrap(async (req, res) => {
    const openEntry = openEntryFor(req.user.id);
    const shift = currentShiftFor(req.user.id);

    const nextShift = db
      .prepare(
        `SELECT sh.*, p.name AS post_name, s.name AS site_name, s.address
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE sh.user_id = ? AND sh.starts_at > ? AND sh.status = 'scheduled'
         ORDER BY sh.starts_at LIMIT 1`
      )
      .get(req.user.id, toSql(new Date()));

    const lastEntry = db
      .prepare(
        `SELECT te.*, p.name AS post_name FROM time_entries te
         JOIN posts p ON p.id = te.post_id
         WHERE te.user_id = ? AND te.clock_out_at IS NOT NULL
         ORDER BY te.clock_out_at DESC LIMIT 1`
      )
      .get(req.user.id);

    let checkIn = null;
    let minutesOnPost = null;
    if (openEntry) {
      const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(openEntry.post_id);
      scheduleNextCheckIn(openEntry, post);
      checkIn = currentCheckIn(openEntry.id);
      minutesOnPost = minutesBetween(sqlToIso(openEntry.clock_in_at), new Date().toISOString());
    }

    // Weekly hours so far (payroll week starts Monday).
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const week = db
      .prepare(
        `SELECT COALESCE(SUM(minutes_worked),0) AS minutes
         FROM time_entries WHERE user_id = ? AND clock_in_at >= ?`
      )
      .get(req.user.id, toSql(weekStart));

    const unread = db
      .prepare(
        `SELECT COUNT(*) AS n FROM broadcasts b
         WHERE (b.expires_at IS NULL OR b.expires_at > datetime('now'))
           AND (b.audience_role IS NULL OR b.audience_role = ?)
           AND NOT EXISTS (
             SELECT 1 FROM broadcast_receipts r
             WHERE r.broadcast_id = b.id AND r.user_id = ? AND r.read_at IS NOT NULL)`
      )
      .get(req.user.role, req.user.id);

    const trainingDue = db
      .prepare(
        `SELECT COUNT(*) AS n FROM trainings t
         WHERE t.required = 1
           AND (t.audience_role IS NULL OR t.audience_role = ?)
           AND NOT EXISTS (
             SELECT 1 FROM training_progress tp
             WHERE tp.training_id = t.id AND tp.user_id = ? AND tp.completed_at IS NOT NULL)`
      )
      .get(req.user.role, req.user.id);

    res.json({
      onDuty: Boolean(openEntry),
      entry: openEntry
        ? {
            ...isoFields(openEntry, [...ENTRY_TIMES, 'shift_starts_at', 'shift_ends_at']),
            minutes_on_post: minutesOnPost,
          }
        : null,
      shift: shift ? isoFields(shift, ['starts_at', 'ends_at']) : null,
      nextShift: nextShift ? isoFields(nextShift, ['starts_at', 'ends_at']) : null,
      lastEntry: lastEntry ? isoFields(lastEntry, ENTRY_TIMES) : null,
      checkIn,
      weekMinutes: week.minutes,
      unreadBroadcasts: unread.n,
      trainingDue: trainingDue.n,
      rules: {
        earlyClockInMinutes: RULES.earlyClockInMinutes,
        lateGraceMinutes: RULES.lateGraceMinutes,
      },
    });
  })
);

/* ------------------------------------------------------------- clock in --- */

const clockInSchema = geoSchema.extend({
  postId: z.number().int().positive().optional(),
  shiftId: z.number().int().positive().optional(),
  deviceId: z.string().max(128).optional(),
  method: z.enum(['gps', 'pin', 'nfc', 'manual']).default('gps'),
  /** Set by the client after the officer confirms an out-of-geofence clock-in. */
  overrideReason: z.string().max(500).optional(),
});

timeclockRouter.post(
  '/clock-in',
  wrap(async (req, res) => {
    const body = parse(clockInSchema, req.body);

    if (openEntryFor(req.user.id)) {
      throw new HttpError(409, 'You are already clocked in. Clock out before starting a new shift.');
    }

    const shift = body.shiftId
      ? db.prepare(`SELECT * FROM shifts WHERE id = ? AND user_id = ?`).get(body.shiftId, req.user.id)
      : currentShiftFor(req.user.id);

    const postId = body.postId || shift?.post_id || req.user.default_site_id;
    if (!postId) {
      throw new HttpError(400, 'No post assigned. Ask dispatch to add you to a shift before clocking in.');
    }

    const post = db.prepare(`SELECT * FROM posts WHERE id = ? AND active = 1`).get(postId);
    if (!post) throw new HttpError(404, 'That post is not available.');

    const now = new Date();

    // Too early? Officers cannot start the clock hours before their shift.
    if (shift) {
      const startsAt = new Date(sqlToIso(shift.starts_at));
      const earliest = new Date(startsAt.getTime() - RULES.earlyClockInMinutes * 60000);
      if (now < earliest) {
        throw new HttpError(
          400,
          `Too early. You can clock in from ${earliest.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
        );
      }
    }

    const fence = evaluateGeofence({
      lat: body.latitude ?? null,
      lng: body.longitude ?? null,
      accuracy: body.accuracy ?? null,
      post,
    });

    // A GPS-required post refuses a clock-in from outside the fence unless the
    // officer supplies a reason, which lands in front of a supervisor.
    if (post.requires_gps && fence.status === 'outside' && !body.overrideReason) {
      throw new HttpError(409, `You are ${fence.distance}m from ${post.name} (limit ${fence.radius}m). Move closer, or add a reason to clock in anyway.`, {
        code: 'outside_geofence',
        distance: fence.distance,
        radius: fence.radius,
      });
    }
    if (post.requires_gps && fence.status === 'no_fix' && body.method === 'gps' && !body.overrideReason) {
      throw new HttpError(409, 'No GPS fix yet. Wait for location, or add a reason to clock in without it.', {
        code: 'no_fix',
      });
    }

    const lateMinutes = shift
      ? Math.max(0, minutesBetween(sqlToIso(shift.starts_at), now.toISOString()) - RULES.lateGraceMinutes)
      : 0;

    const info = db
      .prepare(
        `INSERT INTO time_entries
         (user_id, shift_id, post_id, clock_in_at, clock_in_lat, clock_in_lng,
          clock_in_accuracy, clock_in_geofence, clock_in_distance_m,
          method, device_id, late_minutes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        req.user.id,
        shift?.id ?? null,
        post.id,
        toSql(now),
        body.latitude ?? null,
        body.longitude ?? null,
        body.accuracy ?? null,
        fence.status,
        fence.distance ?? null,
        body.method,
        body.deviceId ?? null,
        lateMinutes
      );

    const entry = db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(info.lastInsertRowid);

    if (shift) {
      db.prepare(`UPDATE shifts SET status = 'in_progress' WHERE id = ?`).run(shift.id);
    } else {
      raiseFlag({
        userId: req.user.id,
        type: FLAG_TYPES.UNSCHEDULED_SHIFT,
        occurredAt: now,
        refType: 'time_entry',
        refId: entry.id,
        severity: 'info',
        detail: { post: post.name },
      });
    }

    if (lateMinutes > 0) {
      raiseFlag({
        userId: req.user.id,
        type: FLAG_TYPES.LATE_CLOCK_IN,
        occurredAt: now,
        refType: 'time_entry',
        refId: entry.id,
        detail: { late_minutes: lateMinutes, scheduled_start: sqlToIso(shift.starts_at) },
      });
    }

    if (fence.status === 'outside' || (body.overrideReason && fence.status !== 'inside')) {
      raiseFlag({
        userId: req.user.id,
        type: FLAG_TYPES.GEOFENCE_VIOLATION,
        occurredAt: now,
        refType: 'time_entry',
        refId: entry.id,
        detail: {
          distance_m: fence.distance,
          radius_m: fence.radius,
          status: fence.status,
          reason: body.overrideReason || null,
        },
      });
    }

    scheduleNextCheckIn(entry, post);
    audit(req.user.id, 'timeclock.in', 'time_entry', entry.id, { post: post.name, fence: fence.status }, req.ip);

    res.status(201).json({
      entry: isoFields(entry, ENTRY_TIMES),
      post: { id: post.id, name: post.name, instructions: post.instructions },
      geofence: fence,
      lateMinutes,
      checkIn: currentCheckIn(entry.id),
    });
  })
);

/* ------------------------------------------------------------ clock out --- */

const clockOutSchema = geoSchema.extend({
  notes: z.string().max(1000).optional(),
});

timeclockRouter.post(
  '/clock-out',
  wrap(async (req, res) => {
    const body = parse(clockOutSchema, req.body);
    const entry = openEntryFor(req.user.id);
    if (!entry) throw new HttpError(409, 'You are not currently clocked in.');

    const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(entry.post_id);
    const now = new Date();
    const fence = evaluateGeofence({
      lat: body.latitude ?? null,
      lng: body.longitude ?? null,
      accuracy: body.accuracy ?? null,
      post,
    });

    const minutes = Math.max(0, minutesBetween(sqlToIso(entry.clock_in_at), now.toISOString()));

    db.prepare(
      `UPDATE time_entries
       SET clock_out_at = ?, clock_out_lat = ?, clock_out_lng = ?, clock_out_accuracy = ?,
           clock_out_geofence = ?, minutes_worked = ?
       WHERE id = ?`
    ).run(
      toSql(now),
      body.latitude ?? null,
      body.longitude ?? null,
      body.accuracy ?? null,
      fence.status,
      minutes,
      entry.id
    );

    // Any check-in still queued for this shift is no longer owed.
    db.prepare(
      `UPDATE status_checks SET status = 'cancelled' WHERE time_entry_id = ? AND status = 'pending'`
    ).run(entry.id);

    if (entry.shift_id) {
      db.prepare(`UPDATE shifts SET status = 'completed' WHERE id = ?`).run(entry.shift_id);

      const endsAt = new Date(sqlToIso(entry.shift_ends_at));
      const earlyBy = minutesBetween(now.toISOString(), endsAt.toISOString());
      if (earlyBy > RULES.earlyDepartureMinutes) {
        raiseFlag({
          userId: req.user.id,
          type: FLAG_TYPES.EARLY_DEPARTURE,
          occurredAt: now,
          refType: 'time_entry',
          refId: entry.id,
          detail: { early_by_minutes: earlyBy, scheduled_end: endsAt.toISOString() },
        });
      }
    }

    // An unfinished tour is closed out so it does not hang around forever.
    db.prepare(
      `UPDATE tour_runs SET status = 'abandoned', completed_at = ?
       WHERE time_entry_id = ? AND status = 'in_progress'`
    ).run(toSql(now), entry.id);

    audit(req.user.id, 'timeclock.out', 'time_entry', entry.id, { minutes }, req.ip);

    const updated = db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(entry.id);
    res.json({
      entry: isoFields(updated, ENTRY_TIMES),
      minutesWorked: minutes,
      geofence: fence,
    });
  })
);

/* ------------------------------------------------------------- check-in --- */

timeclockRouter.get(
  '/check-in',
  wrap(async (req, res) => {
    const entry = openEntryFor(req.user.id);
    if (!entry) return res.json({ checkIn: null });
    const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(entry.post_id);
    scheduleNextCheckIn(entry, post);
    res.json({ checkIn: currentCheckIn(entry.id) });
  })
);

const checkInSchema = geoSchema.extend({
  checkId: z.number().int().positive(),
  note: z.string().max(500).optional(),
});

timeclockRouter.post(
  '/check-in',
  wrap(async (req, res) => {
    const body = parse(checkInSchema, req.body);
    const result = answerCheckIn({
      checkId: body.checkId,
      userId: req.user.id,
      lat: body.latitude ?? null,
      lng: body.longitude ?? null,
      note: body.note,
    });
    if (!result) throw new HttpError(409, 'That check-in has already been answered or is no longer active.');

    audit(req.user.id, 'checkin.answered', 'status_check', body.checkId, { status: result.status }, req.ip);

    const entry = openEntryFor(req.user.id);
    res.json({
      status: result.status,
      respondedAt: result.responded_at,
      next: entry ? currentCheckIn(entry.id) : null,
    });
  })
);

/* -------------------------------------------------------------- history --- */

timeclockRouter.get(
  '/entries',
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const rows = db
      .prepare(
        `SELECT te.*, p.name AS post_name, s.name AS site_name
         FROM time_entries te
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.user_id = ?
         ORDER BY te.clock_in_at DESC LIMIT ?`
      )
      .all(req.user.id, limit);

    const checks = db
      .prepare(
        `SELECT time_entry_id,
                SUM(status = 'missed') AS missed,
                SUM(status IN ('ok','late')) AS answered
         FROM status_checks WHERE user_id = ? GROUP BY time_entry_id`
      )
      .all(req.user.id);
    const byEntry = Object.fromEntries(checks.map((c) => [c.time_entry_id, c]));

    res.json({
      entries: rows.map((r) => ({
        ...isoFields(r, ENTRY_TIMES),
        checks: byEntry[r.id] || { missed: 0, answered: 0 },
      })),
    });
  })
);
