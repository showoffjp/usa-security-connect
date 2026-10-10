import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, sqlToIso, isoFields, limitParam, idParam } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import {
  RULES,
  FLAG_TYPES,
  evaluateGeofence,
  locationOffset,
  minutesBetween,
  checkInLabel,
} from '../shared.js';
import { recordPing } from '../services/tracking.js';
import { checkInMinutesFor } from '../services/settings.js';
import { confirmable, withConfirmation } from '../services/confirmations.js';
import { flagOutstanding, outstandingForShift } from '../services/equipment.js';
import { releaseCallsOnClockOut, OPEN_SQL } from '../services/dispatch.js';
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

/** How often this officer checks in on this shift, and how the last one went. */
async function checkInPlan(entry, post) {
  const every = await checkInMinutesFor(post);
  const last = await db
    .prepare(
      `SELECT responded_at, status, geofence, distance_m, accuracy FROM status_checks
       WHERE time_entry_id = ? AND status IN ('ok','late') ORDER BY responded_at DESC LIMIT 1`
    )
    .get(entry.id);
  const n = await db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE status IN ('ok','late')) AS answered, COUNT(*) FILTER (WHERE status = 'missed') AS missed
       FROM status_checks WHERE time_entry_id = ?`
    )
    .get(entry.id);
  return {
    every_min: every,
    label: checkInLabel(every),
    last: last ? isoFields(last, ['responded_at']) : null,
    answered: Number(n.answered || 0),
    missed: Number(n.missed || 0),
  };
}

async function openEntryFor(userId) {
  return (await db
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
    .get(userId));
}

/**
 * The shift an officer is expected to work right now: the closest scheduled
 * shift whose start is within the early-clock-in window, or one already running.
 */
async function currentShiftFor(userId) {
  const now = new Date();
  const from = toSql(new Date(now.getTime() - 12 * 60 * 60000));
  const to = toSql(new Date(now.getTime() + RULES.earlyClockInMinutes * 60000));
  return (await db
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
    .get(userId, from, to, toSql(now)));
}

/* ------------------------------------------------------------- dashboard --- */

/** Everything the officer's home screen needs, in one round trip. */
timeclockRouter.get(
  '/status',
  wrap(async (req, res) => {
    const openEntry = await openEntryFor(req.user.id);
    const shift = await currentShiftFor(req.user.id);

    const nextShift = (await db
      .prepare(
        `SELECT sh.*, p.name AS post_name, p.post_code, s.name AS site_name, s.address, s.city, s.state,
                p.latitude AS post_lat, p.longitude AS post_lng, p.geofence_radius_m
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE sh.user_id = ? AND sh.starts_at > ? AND sh.status = 'scheduled'
         ORDER BY sh.starts_at LIMIT 1`
      )
      .get(req.user.id, toSql(new Date())));

    const lastEntry = (await db
      .prepare(
        `SELECT te.*, p.name AS post_name FROM time_entries te
         JOIN posts p ON p.id = te.post_id
         WHERE te.user_id = ? AND te.clock_out_at IS NOT NULL
         ORDER BY te.clock_out_at DESC LIMIT 1`
      )
      .get(req.user.id));

    let checkIn = null;
    let checkIns = null;
    let minutesOnPost = null;
    if (openEntry) {
      const post = (await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(openEntry.post_id));
      await scheduleNextCheckIn(openEntry, post);
      checkIn = await currentCheckIn(openEntry.id);
      checkIns = await checkInPlan(openEntry, post);
      minutesOnPost = minutesBetween(sqlToIso(openEntry.clock_in_at), new Date().toISOString());
    }

    // Weekly hours so far (payroll week starts Monday).
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const week = (await db
      .prepare(
        `SELECT COALESCE(SUM(minutes_worked),0) AS minutes
         FROM time_entries WHERE user_id = ? AND clock_in_at >= ?`
      )
      .get(req.user.id, toSql(weekStart)));

    const unread = (await db
      .prepare(
        `SELECT COUNT(*) AS n FROM broadcasts b
         WHERE (b.expires_at IS NULL OR b.expires_at > datetime('now'))
           AND (b.audience_role IS NULL OR b.audience_role = ?)
           AND NOT EXISTS (
             SELECT 1 FROM broadcast_receipts r
             WHERE r.broadcast_id = b.id AND r.user_id = ? AND r.read_at IS NOT NULL)`
      )
      .get(req.user.role, req.user.id));

    const trainingDue = (await db
      .prepare(
        `SELECT COUNT(*) AS n FROM trainings t
         WHERE t.required = 1
           AND (t.audience_role IS NULL OR t.audience_role = ?)
           AND NOT EXISTS (
             SELECT 1 FROM training_progress tp
             WHERE tp.training_id = t.id AND tp.user_id = ? AND tp.completed_at IS NOT NULL)`
      )
      .get(req.user.role, req.user.id));

    res.json({
      onDuty: Boolean(openEntry),
      entry: openEntry
        ? {
            ...isoFields(openEntry, [...ENTRY_TIMES, 'shift_starts_at', 'shift_ends_at']),
            minutes_on_post: minutesOnPost,
          }
        : null,
      shift: shift ? isoFields(shift, ['starts_at', 'ends_at']) : null,
      nextShift: nextShift
        ? {
            ...isoFields(withConfirmation(nextShift), ['starts_at', 'ends_at']),
            confirmable: confirmable(nextShift) && openEntry?.shift_id !== nextShift.id,
          }
        : null,
      lastEntry: lastEntry ? isoFields(lastEntry, ENTRY_TIMES) : null,
      checkIn,
      checkIns,
      weekMinutes: week.minutes,
      unreadBroadcasts: unread.n,
      trainingDue: trainingDue.n,
      rules: {
        earlyClockInMinutes: RULES.earlyClockInMinutes,
        lateGraceMinutes: RULES.lateGraceMinutes,
        locationPingSeconds: RULES.locationPingSeconds,
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

    if (await openEntryFor(req.user.id)) {
      throw new HttpError(409, 'You are already clocked in. Clock out before starting a new shift.');
    }

    const shift = body.shiftId
      ? (await db.prepare(`SELECT * FROM shifts WHERE id = ? AND user_id = ?`).get(body.shiftId, req.user.id))
      : await currentShiftFor(req.user.id);

    const postId = body.postId || shift?.post_id || req.user.default_site_id;
    if (!postId) {
      throw new HttpError(400, 'No post assigned. Ask dispatch to add you to a shift before clocking in.');
    }

    const post = (await db.prepare(`SELECT * FROM posts WHERE id = ? AND active = 1`).get(postId));
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

    const info = (await db
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
      ));

    const entry = (await db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(info.lastInsertRowid));

    if (shift) {
      (await db.prepare(`UPDATE shifts SET status = 'in_progress' WHERE id = ?`).run(shift.id));
    } else {
      await raiseFlag({
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
      await raiseFlag({
        userId: req.user.id,
        type: FLAG_TYPES.LATE_CLOCK_IN,
        occurredAt: now,
        refType: 'time_entry',
        refId: entry.id,
        detail: { late_minutes: lateMinutes, scheduled_start: sqlToIso(shift.starts_at) },
      });
    }

    if (fence.status === 'outside' || (body.overrideReason && fence.status !== 'inside')) {
      await raiseFlag({
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

    await scheduleNextCheckIn(entry, post);
    await recordPing({
      userId: req.user.id,
      entry,
      post,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      accuracy: body.accuracy ?? null,
      source: 'clock_in',
      at: now,
    });
    await audit(req.user.id, 'timeclock.in', 'time_entry', entry.id, { post: post.name, fence: fence.status }, req.ip);

    res.status(201).json({
      entry: isoFields(entry, ENTRY_TIMES),
      post: { id: post.id, name: post.name, instructions: post.instructions },
      geofence: fence,
      lateMinutes,
      checkIn: await currentCheckIn(entry.id),
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
    const entry = await openEntryFor(req.user.id);
    if (!entry) throw new HttpError(409, 'You are not currently clocked in.');

    const post = (await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(entry.post_id));
    const now = new Date();
    const fence = evaluateGeofence({
      lat: body.latitude ?? null,
      lng: body.longitude ?? null,
      accuracy: body.accuracy ?? null,
      post,
    });

    const minutes = Math.max(0, minutesBetween(sqlToIso(entry.clock_in_at), now.toISOString()));

    await recordPing({
      userId: req.user.id,
      entry,
      post,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      accuracy: body.accuracy ?? null,
      source: 'clock_out',
      at: now,
    });

    (await db.prepare(
      `UPDATE time_entries
       SET clock_out_at = ?, clock_out_lat = ?, clock_out_lng = ?, clock_out_accuracy = ?,
           clock_out_geofence = ?, clock_out_distance_m = ?, minutes_worked = ?
       WHERE id = ?`
    ).run(
      toSql(now),
      body.latitude ?? null,
      body.longitude ?? null,
      body.accuracy ?? null,
      fence.status,
      fence.distance ?? null,
      minutes,
      entry.id
    ));

    // Any check-in still queued for this shift is no longer owed.
    (await db.prepare(
      `UPDATE status_checks SET status = 'cancelled' WHERE time_entry_id = ? AND status = 'pending'`
    ).run(entry.id));

    if (entry.shift_id) {
      (await db.prepare(`UPDATE shifts SET status = 'completed' WHERE id = ?`).run(entry.shift_id));

      const endsAt = new Date(sqlToIso(entry.shift_ends_at));
      const earlyBy = minutesBetween(now.toISOString(), endsAt.toISOString());
      if (earlyBy > RULES.earlyDepartureMinutes) {
        await raiseFlag({
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
    (await db.prepare(
      `UPDATE tour_runs SET status = 'abandoned', completed_at = ?
       WHERE time_entry_id = ? AND status = 'in_progress'`
    ).run(toSql(now), entry.id));

    await audit(req.user.id, 'timeclock.out', 'time_entry', entry.id, { minutes }, req.ip);

    // A call cannot go home with the officer: back on the board for someone else.
    const callsReturned = await releaseCallsOnClockOut(req.user.id, now);

    // Anything that should have gone back in the locker. Flagged now rather
    // than waiting for the nightly sweep, and handed back in the response so
    // the officer is told before they walk away rather than the next morning.
    const stillHolding = await outstandingForShift(req.user.id);
    if (stillHolding.length) await flagOutstanding(req.user.id, { occurredAt: now });

    const updated = (await db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(entry.id));
    res.json({
      entry: isoFields(updated, ENTRY_TIMES),
      minutesWorked: minutes,
      geofence: fence,
      callsReturned,
      stillHolding: stillHolding.map((h) => ({
        id: h.id,
        category: h.category,
        label: h.label,
        identifier: h.identifier,
        site: h.site_name,
      })),
    });
  })
);

/* ------------------------------------------------------------- check-in --- */

timeclockRouter.get(
  '/check-in',
  wrap(async (req, res) => {
    const entry = await openEntryFor(req.user.id);
    if (!entry) return res.json({ checkIn: null });
    const post = (await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(entry.post_id));
    await scheduleNextCheckIn(entry, post);
    res.json({ checkIn: await currentCheckIn(entry.id), checkIns: await checkInPlan(entry, post) });
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
    const result = await answerCheckIn({
      checkId: body.checkId,
      userId: req.user.id,
      lat: body.latitude ?? null,
      lng: body.longitude ?? null,
      accuracy: body.accuracy ?? null,
      note: body.note,
    });
    if (!result) throw new HttpError(409, 'That check-in has already been answered or is no longer active.');

    await audit(req.user.id, 'checkin.answered', 'status_check', body.checkId, { status: result.status }, req.ip);

    const entry = await openEntryFor(req.user.id);
    if (entry) {
      await recordPing({
        userId: req.user.id,
        entry,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        source: 'check_in',
      });
    }
    const post = entry ? await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(entry.post_id) : null;
    res.json({
      status: result.status,
      respondedAt: result.responded_at,
      // Where they were, against the post: inside, outside (with how far), or
      // unverified when the phone's fix was too rough to judge.
      location: { geofence: result.geofence, distance_m: result.distance_m, radius_m: result.radius_m, accuracy: result.accuracy },
      next: entry ? await currentCheckIn(entry.id) : null,
      checkIns: entry ? await checkInPlan(entry, post) : null,
    });
  })
);

/* -------------------------------------------------------------- location --- */

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().nullable().optional(),
  speed: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),
});

/**
 * Where the officer is, compared with where they should be.
 *
 * On duty, the position is stored and judged against the post being worked.
 * Off duty nothing is stored - the answer is still useful ("your next post is
 * 4 km north-east") but the company has no business keeping where somebody
 * is when they are not being paid.
 */
timeclockRouter.post(
  '/location',
  wrap(async (req, res) => {
    const body = parse(locationSchema, req.body);
    const entry = await openEntryFor(req.user.id);

    if (entry) {
      const result = await recordPing({
        userId: req.user.id,
        entry,
        latitude: body.latitude,
        longitude: body.longitude,
        accuracy: body.accuracy ?? null,
        speed: body.speed ?? null,
        heading: body.heading ?? null,
        source: 'watch',
      });
      return res.json({
        onDuty: true,
        recorded: Boolean(result?.stored),
        target: {
          kind: 'current',
          post_id: entry.post_id,
          post_name: entry.post_name,
          post_code: entry.post_code,
          site_name: entry.site_name,
          address: entry.address,
          city: entry.city,
          state: entry.state,
          latitude: entry.post_lat,
          longitude: entry.post_lng,
          radius_m: entry.geofence_radius_m,
        },
        offset: result?.offset ?? null,
        nextPingSeconds: RULES.locationPingSeconds,
      });
    }

    const shift =
      (await currentShiftFor(req.user.id)) ||
      (await db
        .prepare(
          `SELECT sh.*, p.name AS post_name, p.post_code, p.latitude AS post_lat, p.longitude AS post_lng,
                  p.geofence_radius_m, s.name AS site_name, s.address, s.city, s.state
           FROM shifts sh
           JOIN posts p ON p.id = sh.post_id
           JOIN sites s ON s.id = p.site_id
           WHERE sh.user_id = ? AND sh.starts_at > ? AND sh.status = 'scheduled'
           ORDER BY sh.starts_at LIMIT 1`
        )
        .get(req.user.id, toSql(new Date())));

    const offset = shift
      ? locationOffset({
          lat: body.latitude,
          lng: body.longitude,
          accuracy: body.accuracy ?? null,
          post: { latitude: shift.post_lat, longitude: shift.post_lng, geofence_radius_m: shift.geofence_radius_m },
        })
      : null;

    res.json({
      onDuty: false,
      recorded: false,
      target: shift
        ? {
            kind: 'next',
            shift_id: shift.id,
            starts_at: sqlToIso(shift.starts_at),
            ends_at: sqlToIso(shift.ends_at),
            post_id: shift.post_id,
            post_name: shift.post_name,
            post_code: shift.post_code,
            site_name: shift.site_name,
            address: shift.address,
            city: shift.city,
            state: shift.state,
            latitude: shift.post_lat,
            longitude: shift.post_lng,
            radius_m: shift.geofence_radius_m,
          }
        : null,
      offset,
      nextPingSeconds: null,
    });
  })
);

/** The officer's own trail for the shift they are working. */
timeclockRouter.get(
  '/location/trail',
  wrap(async (req, res) => {
    const entry = await openEntryFor(req.user.id);
    if (!entry) return res.json({ pings: [] });
    const pings = await db
      .prepare(
        `SELECT recorded_at, latitude, longitude, accuracy, geofence, distance_m, source
         FROM location_pings WHERE time_entry_id = ? ORDER BY recorded_at`
      )
      .all(entry.id);
    res.json({ pings: pings.map((p) => isoFields(p, ['recorded_at'])) });
  })
);

/* -------------------------------------------------------------- history --- */

timeclockRouter.get(
  '/entries',
  wrap(async (req, res) => {
    const limit = limitParam(req.query.limit, 30, 200);
    const rows = (await db
      .prepare(
        `SELECT te.*, p.name AS post_name, s.name AS site_name
         FROM time_entries te
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.user_id = ?
         ORDER BY te.clock_in_at DESC LIMIT ?`
      )
      .all(req.user.id, limit));

    const checks = (await db
      .prepare(
        `SELECT time_entry_id,
                SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) AS missed,
                SUM(CASE WHEN status IN ('ok','late') THEN 1 ELSE 0 END) AS answered
         FROM status_checks WHERE user_id = ? GROUP BY time_entry_id`
      )
      .all(req.user.id));
    const byEntry = Object.fromEntries(checks.map((c) => [c.time_entry_id, c]));

    res.json({
      entries: rows.map((r) => ({
        ...isoFields(r, ENTRY_TIMES),
        checks: byEntry[r.id] || { missed: 0, answered: 0 },
      })),
    });
  })
);

/* --------------------------------------------------------- shift summary -- */

/**
 * What one shift did, for the officer: shown before they clock out (so far,
 * with a nudge to leave a pass-down note) and after (the whole shift).
 * Defaults to the shift they are on, or the last one they worked.
 */
timeclockRouter.get(
  '/shift-summary',
  wrap(async (req, res) => {
    const entryId = idParam(req.query.entryId, 'entry');
    const entry = entryId
      ? await db.prepare(`SELECT * FROM time_entries WHERE id = ? AND user_id = ?`).get(entryId, req.user.id)
      : await db
          .prepare(`SELECT * FROM time_entries WHERE user_id = ? ORDER BY (clock_out_at IS NULL) DESC, clock_in_at DESC LIMIT 1`)
          .get(req.user.id);
    if (!entry) throw new HttpError(404, 'No shift to summarise yet.');
    const post = await db
      .prepare(`SELECT p.name AS post_name, s.name AS site_name, s.id AS site_id FROM posts p JOIN sites s ON s.id = p.site_id WHERE p.id = ?`)
      .get(entry.post_id);
    const from = entry.clock_in_at;
    const to = entry.clock_out_at || toSql(new Date());
    const n = async (sql, ...params) => Number((await db.prepare(sql).get(...params))?.n || 0);
    const uid = req.user.id;

    const checks = await db
      .prepare(
        `SELECT SUM(CASE WHEN status IN ('ok','late') THEN 1 ELSE 0 END) AS answered,
                SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) AS missed
         FROM status_checks WHERE time_entry_id = ?`
      )
      .get(entry.id);
    const tours = await db
      .prepare(
        `SELECT COUNT(DISTINCT tr.id) AS runs,
                COUNT(DISTINCT CASE WHEN tr.status = 'completed' THEN tr.id END) AS completed,
                SUM(CASE WHEN trc.status = 'done' THEN 1 ELSE 0 END) AS scanned
         FROM tour_runs tr LEFT JOIN tour_run_checkpoints trc ON trc.tour_run_id = tr.id
         WHERE tr.user_id = ? AND tr.started_at >= ? AND tr.started_at <= ?`
      )
      .get(uid, from, to);
    const minutes = Math.max(0, Math.round((new Date(sqlToIso(to)) - new Date(sqlToIso(from))) / 60000));

    res.json({
      entry: {
        id: entry.id, post_name: post?.post_name, site_name: post?.site_name, open: !entry.clock_out_at, minutes,
        ...isoFields({ clock_in_at: entry.clock_in_at, clock_out_at: entry.clock_out_at }, ['clock_in_at', 'clock_out_at']),
      },
      visitorsIn: await n(`SELECT COUNT(*) AS n FROM visitor_log WHERE logged_by = ? AND arrived_at >= ? AND arrived_at <= ?`, uid, from, to),
      visitorsOut: await n(`SELECT COUNT(*) AS n FROM visitor_log WHERE departed_by = ? AND departed_at >= ? AND departed_at <= ?`, uid, from, to),
      activity: await n(`SELECT COUNT(*) AS n FROM activity_entries WHERE user_id = ? AND occurred_at >= ? AND occurred_at <= ?`, uid, from, to),
      violations: await n(`SELECT COUNT(*) AS n FROM vehicle_violations WHERE logged_by = ? AND occurred_at >= ? AND occurred_at <= ?`, uid, from, to),
      incidents: await n(`SELECT COUNT(*) AS n FROM incidents WHERE user_id = ? AND occurred_at >= ? AND occurred_at <= ?`, uid, from, to),
      tours: { runs: Number(tours.runs || 0), completed: Number(tours.completed || 0), checkpoints: Number(tours.scanned || 0) },
      checkIns: { answered: Number(checks.answered || 0), missed: Number(checks.missed || 0) },
      calls: {
        cleared: await n(`SELECT COUNT(*) AS n FROM service_calls WHERE assigned_to = ? AND status = 'cleared' AND cleared_at >= ? AND cleared_at <= ?`, uid, from, to),
        open: entry.clock_out_at ? 0 : await n(`SELECT COUNT(*) AS n FROM service_calls WHERE assigned_to = ? AND status IN (${OPEN_SQL})`, uid),
      },
      passdownWritten: await n(`SELECT COUNT(*) AS n FROM passdown_notes WHERE author_id = ? AND time_entry_id = ?`, uid, entry.id),
    });
  })
);
