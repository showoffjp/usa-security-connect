/**
 * Live operations: where every officer is, what they are meant to be doing,
 * and every punch they have made.
 *
 * Nothing here is typed in by anybody. It is read from the rows the officer
 * app already writes - time entries, breaks, check-ins and location pings - so
 * the live board and the punch log can never disagree with the timesheet.
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { HttpError, wrap, isoFields, sqlToIso, parseDay, toDateString, limitParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import {
  ROLES,
  RULES,
  LIVE_STATUS,
  LIVE_STATUS_LABEL,
  liveStatus,
  minutesBetween,
  distanceMeters,
  payrollWeekOf,
  toHours,
} from '../shared.js';
import { toSql, sweep } from '../services/compliance.js';

export const liveRouter = Router();
liveRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

export const punchesRouter = Router();
punchesRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

const minutesAgo = (value, now) => (value ? minutesBetween(sqlToIso(value), now.toISOString()) : null);

/* ============================================================ live board === */

liveRouter.get(
  '/',
  wrap(async (req, res) => {
    await sweep();
    const now = new Date();
    const windowEnd = toSql(new Date(now.getTime() + 12 * 3600000));

    const people = await db
      .prepare(
        `SELECT id, employee_code, first_name, last_name, role, phone, employment_type,
                pay_type, license_type, default_site_id
         FROM users WHERE status = 'active' ORDER BY last_name, first_name`
      )
      .all();

    const open = await db
      .prepare(
        `SELECT te.id, te.user_id, te.shift_id, te.clock_in_at, te.clock_in_lat, te.clock_in_lng,
                te.clock_in_geofence, te.clock_in_distance_m, te.late_minutes, te.method,
                p.id AS post_id, p.name AS post_name, p.post_code, p.armed,
                p.latitude AS post_lat, p.longitude AS post_lng, p.geofence_radius_m,
                s.id AS site_id, s.name AS site_name, s.client_name, s.address, s.city, s.state, s.postal_code,
                sh.starts_at AS shift_starts_at, sh.ends_at AS shift_ends_at,
                (SELECT COUNT(*) FROM status_checks sc
                  WHERE sc.time_entry_id = te.id AND sc.status = 'missed') AS missed_checks,
                (SELECT MIN(due_at) FROM status_checks sc
                  WHERE sc.time_entry_id = te.id AND sc.status = 'pending') AS next_check_due
         FROM time_entries te
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         LEFT JOIN shifts sh ON sh.id = te.shift_id
         WHERE te.clock_out_at IS NULL`
      )
      .all();
    const openByUser = new Map(open.map((e) => [e.user_id, e]));

    // The newest position for everyone currently on the clock. DISTINCT ON is
    // Postgres, and both drivers are Postgres.
    const pings = await db
      .prepare(
        `SELECT DISTINCT ON (lp.user_id)
                lp.user_id, lp.recorded_at, lp.latitude, lp.longitude, lp.accuracy,
                lp.speed_mps, lp.geofence, lp.distance_m, lp.source
         FROM location_pings lp
         JOIN time_entries te ON te.id = lp.time_entry_id AND te.clock_out_at IS NULL
         ORDER BY lp.user_id, lp.recorded_at DESC`
      )
      .all();
    const pingByUser = new Map(pings.map((p) => [p.user_id, p]));

    const breaks = await db
      .prepare(`SELECT user_id, type, started_at FROM breaks WHERE ended_at IS NULL`)
      .all();
    const breakByUser = new Map(breaks.map((b) => [b.user_id, b]));

    const alerts = await db
      .prepare(
        `SELECT id, user_id, triggered_at, latitude, longitude, status
         FROM panic_alerts WHERE status IN ('active','acknowledged')`
      )
      .all();
    const alertByUser = new Map(alerts.map((a) => [a.user_id, a]));

    // Anyone not on the clock is judged against the shift they should be on:
    // one already under way, or else the next one to start.
    const shifts = await db
      .prepare(
        `SELECT sh.id, sh.user_id, sh.starts_at, sh.ends_at, sh.status,
                p.id AS post_id, p.name AS post_name, p.post_code, p.armed,
                p.latitude AS post_lat, p.longitude AS post_lng, p.geofence_radius_m,
                s.id AS site_id, s.name AS site_name, s.client_name, s.address, s.city, s.state, s.postal_code
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE sh.status IN ('scheduled','missed')
           AND sh.ends_at > ? AND sh.starts_at < ?
         ORDER BY sh.starts_at`
      )
      .all(toSql(now), windowEnd);

    const shiftByUser = new Map();
    const uncovered = [];
    for (const s of shifts) {
      if (!s.user_id) {
        if (new Date(sqlToIso(s.starts_at)) <= now) uncovered.push(s);
        continue;
      }
      const existing = shiftByUser.get(s.user_id);
      // Rows arrive by start time, so the first one seen is the earliest - a
      // shift already running beats one later today.
      if (!existing) shiftByUser.set(s.user_id, s);
    }

    // Hours today and this payroll week, including the shift still running.
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = parseDay(payrollWeekOf(now));
    const worked = await db
      .prepare(
        `SELECT user_id,
                SUM(CASE WHEN clock_in_at >= ? THEN COALESCE(minutes_worked, 0) ELSE 0 END) AS today,
                SUM(COALESCE(minutes_worked, 0)) AS week
         FROM time_entries
         WHERE clock_in_at >= ? AND clock_out_at IS NOT NULL
         GROUP BY user_id`
      )
      .all(toSql(todayStart), toSql(weekStart));
    const workedByUser = new Map(worked.map((w) => [w.user_id, w]));

    const officers = [];
    for (const person of people) {
      const entry = openByUser.get(person.id);
      const ping = pingByUser.get(person.id);
      const brk = breakByUser.get(person.id);
      const alert = alertByUser.get(person.id);
      const shift = entry ? null : shiftByUser.get(person.id);

      const lastFence = entry ? ping?.geofence ?? entry.clock_in_geofence : null;
      const started = shift && new Date(sqlToIso(shift.starts_at)) <= now;
      const status = liveStatus({
        duress: Boolean(alert),
        onDuty: Boolean(entry),
        onBreak: Boolean(brk),
        lastFence,
        shiftStartsAt: shift ? sqlToIso(shift.starts_at) : null,
        now,
      });

      // Admins and supervisors with nothing on today would only be noise.
      if (status === 'off_duty' && person.role !== 'officer' && !shift) continue;

      const job = entry || shift;
      const lastSeenMinutes = entry ? minutesAgo(ping?.recorded_at ?? entry.clock_in_at, now) : null;
      const running = entry ? Math.max(0, minutesAgo(entry.clock_in_at, now)) : 0;
      const w = workedByUser.get(person.id) || { today: 0, week: 0 };

      officers.push({
        user_id: person.id,
        employee_code: person.employee_code,
        name: `${person.first_name} ${person.last_name}`,
        role: person.role,
        phone: person.phone,
        employment_type: person.employment_type,
        license_type: person.license_type,
        status,
        status_label: LIVE_STATUS_LABEL[status],
        gps_stale: Boolean(entry) && (lastSeenMinutes == null || lastSeenMinutes > RULES.gpsStaleMinutes),
        job: job
          ? {
              shift_id: entry ? entry.shift_id : shift.id,
              post_id: job.post_id,
              post_name: job.post_name,
              post_code: job.post_code,
              armed: Boolean(job.armed),
              site_id: job.site_id,
              site_name: job.site_name,
              client_name: job.client_name,
              address: [job.address, job.city, job.state, job.postal_code].filter(Boolean).join(', '),
              latitude: job.post_lat,
              longitude: job.post_lng,
              radius_m: job.geofence_radius_m,
              starts_at: sqlToIso(entry ? entry.shift_starts_at : shift.starts_at),
              ends_at: sqlToIso(entry ? entry.shift_ends_at : shift.ends_at),
              starts_in_minutes: shift && !started ? -minutesAgo(shift.starts_at, now) : null,
              late_by_minutes: shift && started ? minutesAgo(shift.starts_at, now) : null,
            }
          : null,
        entry: entry
          ? {
              id: entry.id,
              clock_in_at: sqlToIso(entry.clock_in_at),
              clock_in_geofence: entry.clock_in_geofence,
              clock_in_distance_m: entry.clock_in_distance_m,
              late_minutes: entry.late_minutes,
              method: entry.method,
              minutes_on_post: running,
              missed_checks: Number(entry.missed_checks) || 0,
              next_check_due: sqlToIso(entry.next_check_due),
            }
          : null,
        location: ping
          ? {
              latitude: ping.latitude,
              longitude: ping.longitude,
              accuracy: ping.accuracy,
              speed_mps: ping.speed_mps,
              geofence: ping.geofence,
              distance_m: ping.distance_m,
              recorded_at: sqlToIso(ping.recorded_at),
              minutes_ago: lastSeenMinutes,
              source: ping.source,
            }
          : entry && entry.clock_in_lat != null
            ? {
                latitude: entry.clock_in_lat,
                longitude: entry.clock_in_lng,
                accuracy: null,
                geofence: entry.clock_in_geofence,
                distance_m: entry.clock_in_distance_m,
                recorded_at: sqlToIso(entry.clock_in_at),
                minutes_ago: lastSeenMinutes,
                source: 'clock_in',
              }
            : null,
        on_break: brk ? { type: brk.type, started_at: sqlToIso(brk.started_at), minutes: minutesAgo(brk.started_at, now) } : null,
        alert: alert ? isoFields(alert, ['triggered_at']) : null,
        hours_today: toHours(Number(w.today) + (entry && new Date(sqlToIso(entry.clock_in_at)) >= todayStart ? running : 0)),
        hours_week: toHours(Number(w.week) + running),
      });
    }

    const rank = Object.fromEntries(LIVE_STATUS.map((s, i) => [s, i]));
    officers.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));

    const counts = Object.fromEntries(LIVE_STATUS.map((s) => [s, 0]));
    for (const o of officers) counts[o.status] += 1;
    counts.gps_stale = officers.filter((o) => o.gps_stale).length;
    counts.on_duty = officers.filter((o) => o.entry).length;
    counts.uncovered = uncovered.length;

    const posts = await db
      .prepare(
        `SELECT p.id, p.name, p.post_code, p.latitude, p.longitude, p.geofence_radius_m, p.armed,
                s.id AS site_id, s.name AS site_name, s.address, s.city, s.state
         FROM posts p JOIN sites s ON s.id = p.site_id
         WHERE p.active = 1 AND s.active = 1 AND p.latitude IS NOT NULL
         ORDER BY s.name, p.name`
      )
      .all();

    res.json({
      generated_at: now.toISOString(),
      rules: { gpsStaleMinutes: RULES.gpsStaleMinutes, locationPingSeconds: RULES.locationPingSeconds },
      counts,
      officers,
      posts,
      uncovered: uncovered.map((s) => ({
        shift_id: s.id,
        post_name: s.post_name,
        site_name: s.site_name,
        starts_at: sqlToIso(s.starts_at),
        ends_at: sqlToIso(s.ends_at),
      })),
    });
  })
);

/**
 * One officer's movements for a day: every position, every shift worked, the
 * posts they were meant to be at, and a summary a supervisor can read in one
 * glance.
 */
liveRouter.get(
  '/track/:userId',
  wrap(async (req, res) => {
    const userId = Number(req.params.userId);
    const person = await db
      .prepare(`SELECT id, employee_code, first_name, last_name, phone, role FROM users WHERE id = ?`)
      .get(userId);
    if (!person) throw new HttpError(404, 'Employee not found.');

    const day = parseDay(req.query.date);
    if (!day) throw new HttpError(422, 'Use a date like 2026-09-25.');
    const next = new Date(day);
    next.setDate(next.getDate() + 1);

    // Entries that overlap the day, so an overnight shift is not cut in half.
    const entries = await db
      .prepare(
        `SELECT te.id, te.clock_in_at, te.clock_out_at, te.clock_in_lat, te.clock_in_lng,
                te.clock_out_lat, te.clock_out_lng, te.clock_in_geofence, te.clock_out_geofence,
                te.minutes_worked, te.late_minutes, te.auto_closed,
                p.id AS post_id, p.name AS post_name, p.latitude AS post_lat, p.longitude AS post_lng,
                p.geofence_radius_m, s.name AS site_name, s.address, s.city
         FROM time_entries te
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.user_id = ? AND te.clock_in_at < ? AND COALESCE(te.clock_out_at, now()) >= ?
         ORDER BY te.clock_in_at`
      )
      .all(userId, toSql(next), toSql(day));

    const pings = await db
      .prepare(
        `SELECT id, time_entry_id, recorded_at, latitude, longitude, accuracy, speed_mps,
                geofence, distance_m, source
         FROM location_pings
         WHERE user_id = ? AND recorded_at >= ? AND recorded_at < ?
         ORDER BY recorded_at`
      )
      .all(userId, toSql(day), toSql(next));

    let walked = 0;
    for (let i = 1; i < pings.length; i++) {
      if (pings[i].time_entry_id !== pings[i - 1].time_entry_id) continue;
      walked += distanceMeters(pings[i - 1].latitude, pings[i - 1].longitude, pings[i].latitude, pings[i].longitude) || 0;
    }
    const judged = pings.filter((p) => p.geofence === 'inside' || p.geofence === 'outside');
    const inside = judged.filter((p) => p.geofence === 'inside').length;
    let offPostEvents = 0;
    for (let i = 0; i < pings.length; i++) {
      if (pings[i].geofence === 'outside' && (i === 0 || pings[i - 1].geofence !== 'outside')) offPostEvents += 1;
    }

    res.json({
      date: toDateString(day),
      officer: { ...person, name: `${person.first_name} ${person.last_name}` },
      entries: entries.map((e) => isoFields(e, ['clock_in_at', 'clock_out_at'])),
      pings: pings.map((p) => isoFields(p, ['recorded_at'])),
      summary: {
        pings: pings.length,
        inside_percent: judged.length ? Math.round((inside / judged.length) * 1000) / 10 : null,
        off_post_events: offPostEvents,
        max_distance_m: pings.reduce((m, p) => Math.max(m, p.distance_m || 0), 0),
        distance_walked_m: Math.round(walked),
        // A shift still running counts up to now, so today's track is not 0m.
        minutes_worked: entries.reduce(
          (n, e) =>
            n + (e.clock_out_at ? e.minutes_worked || 0 : Math.max(0, minutesBetween(sqlToIso(e.clock_in_at), new Date().toISOString()))),
          0
        ),
      },
    });
  })
);

/* ============================================================= punch log === */

const PUNCH_TYPES = ['clock_in', 'clock_out', 'break_start', 'break_end', 'check_in', 'check_missed'];

export const PUNCH_LABEL = {
  clock_in: 'Clock in',
  clock_out: 'Clock out',
  break_start: 'Break start',
  break_end: 'Break end',
  check_in: 'Status check-in',
  check_missed: 'Missed check-in',
};

/** Every punch in a date range, newest first, from every table that holds one. */
export async function loadPunches(query) {
  const from = parseDay(query.from || toDateString(new Date(Date.now() - 6 * 86400000)));
  const toDay = parseDay(query.to);
  if (!from || !toDay) throw new HttpError(422, 'Use dates like 2026-09-25.');
  const to = new Date(toDay);
  to.setDate(to.getDate() + 1);
  if (to <= from) throw new HttpError(422, 'The end date is before the start date.');
  if ((to - from) / 86400000 > 93) throw new HttpError(422, 'Pick at most three months at a time.');

  const types = query.type ? String(query.type).split(',').filter((t) => PUNCH_TYPES.includes(t)) : PUNCH_TYPES;
  const userId = query.userId ? Number(query.userId) : null;
  const siteId = query.siteId ? Number(query.siteId) : null;
  // Validated as integers because they are written into the SQL below.
  if ((userId !== null && !Number.isInteger(userId)) || (siteId !== null && !Number.isInteger(siteId))) {
    throw new HttpError(422, 'Unknown officer or site filter.');
  }

  const filters = (alias = 'te') =>
    `${userId ? `AND ${alias}.user_id = ${userId}` : ''} ${siteId ? `AND s.id = ${siteId}` : ''}`;

  const base = `
    FROM time_entries te
    JOIN users u ON u.id = te.user_id
    JOIN posts p ON p.id = te.post_id
    JOIN sites s ON s.id = p.site_id`;
  const who = `u.id AS user_id, u.employee_code, u.first_name || ' ' || u.last_name AS officer,
               u.employment_type, p.name AS post_name, s.id AS site_id, s.name AS site_name, te.id AS entry_id`;

  const out = [];
  const range = [toSql(from), toSql(to)];

  if (types.includes('clock_in')) {
    const rows = await db
      .prepare(
        `SELECT ${who}, te.clock_in_at AS at, te.clock_in_lat AS latitude, te.clock_in_lng AS longitude,
                te.clock_in_accuracy AS accuracy, te.clock_in_geofence AS geofence,
                te.clock_in_distance_m AS distance_m, te.method, te.device_id, te.late_minutes,
                te.original_clock_in_at, te.adjustment_reason
         ${base} WHERE te.clock_in_at >= ? AND te.clock_in_at < ? ${filters()}`
      )
      .all(...range);
    for (const r of rows) {
      const notes = [];
      if (r.late_minutes > 0) notes.push(`${r.late_minutes} min late`);
      if (r.original_clock_in_at) notes.push(`adjusted: ${r.adjustment_reason || 'no reason given'}`);
      out.push({ ...r, type: 'clock_in', note: notes.join('; ') || null });
    }
  }

  if (types.includes('clock_out')) {
    const rows = await db
      .prepare(
        `SELECT ${who}, te.clock_out_at AS at, te.clock_out_lat AS latitude, te.clock_out_lng AS longitude,
                te.clock_out_accuracy AS accuracy, te.clock_out_geofence AS geofence,
                te.method, te.device_id, te.minutes_worked, te.auto_closed, te.unpaid_break_minutes
         ${base} WHERE te.clock_out_at >= ? AND te.clock_out_at < ? ${filters()}`
      )
      .all(...range);
    for (const r of rows) {
      const notes = [`${toHours(r.minutes_worked)}h worked`];
      if (r.unpaid_break_minutes) notes.push(`${r.unpaid_break_minutes} min unpaid break`);
      if (r.auto_closed) notes.push('auto-closed: officer never clocked out');
      out.push({ ...r, type: 'clock_out', distance_m: null, note: notes.join('; ') });
    }
  }

  if (types.includes('break_start') || types.includes('break_end')) {
    const rows = await db
      .prepare(
        `SELECT ${who}, b.id AS break_id, b.type AS break_type, b.paid, b.started_at, b.ended_at,
                b.minutes, b.start_lat, b.start_lng
         FROM breaks b
         JOIN time_entries te ON te.id = b.time_entry_id
         JOIN users u ON u.id = te.user_id
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE ((b.started_at >= ? AND b.started_at < ?) OR (b.ended_at >= ? AND b.ended_at < ?)) ${filters()}`
      )
      .all(...range, ...range);
    for (const r of rows) {
      const inRange = (v) => v && new Date(sqlToIso(v)) >= from && new Date(sqlToIso(v)) < to;
      const kind = `${r.break_type} break (${r.paid ? 'paid' : 'unpaid'})`;
      if (types.includes('break_start') && inRange(r.started_at)) {
        out.push({ ...r, type: 'break_start', at: r.started_at, latitude: r.start_lat, longitude: r.start_lng, note: kind });
      }
      if (types.includes('break_end') && inRange(r.ended_at)) {
        out.push({ ...r, type: 'break_end', at: r.ended_at, latitude: null, longitude: null, note: `${kind}, ${r.minutes} min` });
      }
    }
  }

  if (types.includes('check_in') || types.includes('check_missed')) {
    const rows = await db
      .prepare(
        `SELECT ${who}, sc.id AS check_id, sc.status AS check_status, sc.due_at, sc.responded_at,
                sc.latitude, sc.longitude, sc.note AS check_note
         FROM status_checks sc
         JOIN time_entries te ON te.id = sc.time_entry_id
         JOIN users u ON u.id = te.user_id
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE sc.status IN ('ok','late','missed') AND sc.due_at >= ? AND sc.due_at < ? ${filters()}`
      )
      .all(...range);
    for (const r of rows) {
      if (r.check_status === 'missed') {
        if (types.includes('check_missed')) {
          out.push({ ...r, type: 'check_missed', at: r.due_at, note: 'No answer inside the window' });
        }
      } else if (types.includes('check_in')) {
        out.push({
          ...r,
          type: 'check_in',
          at: r.responded_at,
          note: r.check_status === 'late' ? 'Answered late' : r.check_note || null,
        });
      }
    }
  }

  const punches = out
    .map((r) => ({
      id: `${r.type}-${r.check_id ?? r.break_id ?? r.entry_id}`,
      type: r.type,
      label: PUNCH_LABEL[r.type],
      at: sqlToIso(r.at),
      user_id: r.user_id,
      employee_code: r.employee_code,
      officer: r.officer,
      employment_type: r.employment_type,
      site_id: r.site_id,
      site_name: r.site_name,
      post_name: r.post_name,
      entry_id: r.entry_id,
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
      accuracy: r.accuracy ?? null,
      geofence: r.geofence ?? null,
      distance_m: r.distance_m ?? null,
      method: r.method ?? null,
      device_id: r.device_id ?? null,
      note: r.note ?? null,
    }))
    .sort((a, b) => new Date(b.at) - new Date(a.at));

  return { from: toDateString(from), to: toDateString(toDay), punches };
}

punchesRouter.get(
  '/',
  wrap(async (req, res) => {
    const { from, to, punches } = await loadPunches(req.query);
    const limit = limitParam(req.query.limit, 1000, 5000);
    const counts = Object.fromEntries(PUNCH_TYPES.map((t) => [t, 0]));
    for (const p of punches) counts[p.type] += 1;
    res.json({
      range: { from, to },
      total: punches.length,
      counts,
      outsideGeofence: punches.filter((p) => p.geofence === 'outside').length,
      punches: punches.slice(0, limit),
    });
  })
);

const csvCell = (v) => {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  // A leading = + - @ is a formula to a spreadsheet; neutralise it.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

punchesRouter.get(
  '/export.csv',
  wrap(async (req, res) => {
    const { from, to, punches } = await loadPunches(req.query);
    const header = [
      'When (UTC)', 'Punch', 'Employee code', 'Officer', 'Classification', 'Site', 'Post',
      'Latitude', 'Longitude', 'Accuracy (m)', 'Geofence', 'Distance from post (m)', 'Method', 'Device', 'Note',
    ];
    const lines = [header.join(',')];
    for (const p of punches) {
      lines.push(
        [
          p.at, p.label, p.employee_code, p.officer, p.employment_type === '1099' ? '1099' : 'W-2',
          p.site_name, p.post_name, p.latitude, p.longitude, p.accuracy, p.geofence, p.distance_m,
          p.method, p.device_id, p.note,
        ]
          .map(csvCell)
          .join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="punches-${from}-to-${to}.csv"`);
    res.send(lines.join('\n'));
  })
);
