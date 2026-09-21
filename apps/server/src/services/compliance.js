/**
 * Compliance engine.
 *
 * Everything that turns raw clock/check-in data into the supervisor-facing
 * signals - late arrivals, missed status check-ins, no-shows, officers who
 * clocked in from outside the geofence, and shifts left open overnight.
 *
 * `sweep()` is idempotent: the `flags` table has a UNIQUE(type, ref_type, ref_id)
 * constraint, so running it repeatedly never duplicates an alert.
 */

import { db } from '../lib/db.js';
import { sqlToIso } from '../lib/http.js';
import { RULES, FLAG_TYPES, FLAG_SEVERITY, minutesBetween } from '../shared.js';

/** Store timestamps the way SQLite's datetime() does, so comparisons line up. */
export const toSql = (d = new Date()) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);
export const fromSql = sqlToIso;

export function raiseFlag({ userId, type, occurredAt, refType, refId, detail, severity }) {
  return db
    .prepare(
      `INSERT INTO flags (user_id, type, severity, occurred_at, ref_type, ref_id, detail)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(type, ref_type, ref_id) DO NOTHING`
    )
    .run(
      userId,
      type,
      severity || FLAG_SEVERITY[type] || 'warning',
      toSql(occurredAt || new Date()),
      refType ?? null,
      refId ?? null,
      detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null
    );
}

/* ------------------------------------------------------------ check-ins --- */

/**
 * Queue the next status check-in for an open shift.
 * Officers must acknowledge within `window_minutes` or the check is missed.
 */
export function scheduleNextCheckIn(timeEntry, post) {
  const interval = post?.check_in_interval_min || RULES.defaultCheckInIntervalMinutes;
  if (!interval || interval <= 0) return null;

  const open = db
    .prepare(
      `SELECT * FROM status_checks
       WHERE time_entry_id = ? AND status = 'pending'
       ORDER BY due_at LIMIT 1`
    )
    .get(timeEntry.id);
  if (open) return open;

  const last = db
    .prepare(`SELECT MAX(due_at) AS last_due FROM status_checks WHERE time_entry_id = ?`)
    .get(timeEntry.id)?.last_due;

  const from = last ? new Date(fromSql(last)) : new Date(fromSql(timeEntry.clock_in_at));
  const due = new Date(from.getTime() + interval * 60000);

  const info = db
    .prepare(
      `INSERT INTO status_checks (time_entry_id, user_id, due_at, window_minutes)
       VALUES (?,?,?,?)`
    )
    .run(timeEntry.id, timeEntry.user_id, toSql(due), RULES.checkInWindowMinutes);

  return db.prepare(`SELECT * FROM status_checks WHERE id = ?`).get(info.lastInsertRowid);
}

/** The check-in the officer is being asked for right now, if any. */
export function currentCheckIn(timeEntryId) {
  const row = db
    .prepare(
      `SELECT * FROM status_checks
       WHERE time_entry_id = ? AND status = 'pending'
       ORDER BY due_at LIMIT 1`
    )
    .get(timeEntryId);
  if (!row) return null;

  const dueAt = new Date(fromSql(row.due_at));
  const expiresAt = new Date(dueAt.getTime() + row.window_minutes * 60000);
  const now = new Date();

  return {
    ...row,
    due_at: fromSql(row.due_at),
    expires_at: expiresAt.toISOString(),
    /** Officers can answer a little early; the prompt opens 5 minutes ahead. */
    is_open: now >= new Date(dueAt.getTime() - 5 * 60000),
    is_overdue: now > dueAt,
    seconds_remaining: Math.max(0, Math.round((expiresAt - now) / 1000)),
  };
}

export function answerCheckIn({ checkId, userId, lat, lng, note }) {
  const row = db.prepare(`SELECT * FROM status_checks WHERE id = ? AND user_id = ?`).get(checkId, userId);
  if (!row || row.status !== 'pending') return null;

  const dueAt = new Date(fromSql(row.due_at));
  const now = new Date();
  // Answering after the window still counts, but it is recorded as late.
  const status = now > new Date(dueAt.getTime() + row.window_minutes * 60000) ? 'late' : 'ok';

  db.prepare(
    `UPDATE status_checks
     SET responded_at = ?, status = ?, latitude = ?, longitude = ?, note = ?
     WHERE id = ?`
  ).run(toSql(now), status, lat ?? null, lng ?? null, note ?? null, checkId);

  if (status === 'late') {
    raiseFlag({
      userId,
      type: FLAG_TYPES.MISSED_CHECK_IN,
      occurredAt: dueAt,
      refType: 'status_check',
      refId: checkId,
      severity: 'warning',
      detail: { late_by_minutes: minutesBetween(dueAt.toISOString(), now.toISOString()), answered: true },
    });
  }

  const entry = db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(row.time_entry_id);
  if (entry && !entry.clock_out_at) {
    const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(entry.post_id);
    scheduleNextCheckIn(entry, post);
  }

  return { ...row, status, responded_at: now.toISOString() };
}

/* --------------------------------------------------------------- sweeps --- */

/** Status check-ins whose window has fully elapsed with no answer. */
function sweepMissedCheckIns(now) {
  const overdue = db
    .prepare(
      `SELECT sc.*, te.post_id
       FROM status_checks sc
       JOIN time_entries te ON te.id = sc.time_entry_id
       WHERE sc.status = 'pending'
         AND datetime(sc.due_at, '+' || sc.window_minutes || ' minutes') < ?`
    )
    .all(toSql(now));

  for (const check of overdue) {
    db.prepare(`UPDATE status_checks SET status = 'missed' WHERE id = ?`).run(check.id);
    raiseFlag({
      userId: check.user_id,
      type: FLAG_TYPES.MISSED_CHECK_IN,
      occurredAt: fromSql(check.due_at),
      refType: 'status_check',
      refId: check.id,
      detail: { due_at: fromSql(check.due_at), answered: false },
    });

    // Keep the cadence going so the officer still gets the next prompt.
    const entry = db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(check.time_entry_id);
    if (entry && !entry.clock_out_at) {
      const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(entry.post_id);
      scheduleNextCheckIn(entry, post);
    }
  }
  return overdue.length;
}

/** Scheduled shifts nobody ever clocked into. */
function sweepNoShows(now) {
  const cutoff = toSql(new Date(now.getTime() - RULES.noShowMinutes * 60000));
  const missed = db
    .prepare(
      `SELECT s.* FROM shifts s
       WHERE s.status = 'scheduled'
         AND s.user_id IS NOT NULL
         AND s.starts_at < ?
         AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.shift_id = s.id)`
    )
    .all(cutoff);

  for (const shift of missed) {
    db.prepare(`UPDATE shifts SET status = 'missed' WHERE id = ?`).run(shift.id);
    raiseFlag({
      userId: shift.user_id,
      type: FLAG_TYPES.NO_SHOW,
      occurredAt: fromSql(shift.starts_at),
      refType: 'shift',
      refId: shift.id,
      detail: { scheduled_start: fromSql(shift.starts_at) },
    });
  }
  return missed.length;
}

/** Shifts still open long after they should have ended. */
function sweepAbandonedShifts(now) {
  const open = db
    .prepare(
      `SELECT te.*, s.ends_at
       FROM time_entries te
       LEFT JOIN shifts s ON s.id = te.shift_id
       WHERE te.clock_out_at IS NULL`
    )
    .all();

  let closed = 0;
  for (const entry of open) {
    const reference = entry.ends_at
      ? new Date(fromSql(entry.ends_at))
      : new Date(new Date(fromSql(entry.clock_in_at)).getTime() + 16 * 60 * 60000);
    const deadline = new Date(reference.getTime() + RULES.autoClockOutAfterMinutes * 60000);
    if (now <= deadline) continue;

    const minutes = minutesBetween(fromSql(entry.clock_in_at), reference.toISOString());
    db.prepare(
      `UPDATE time_entries
       SET clock_out_at = ?, minutes_worked = ?, auto_closed = 1
       WHERE id = ?`
    ).run(toSql(reference), Math.max(0, minutes), entry.id);

    if (entry.shift_id) {
      db.prepare(`UPDATE shifts SET status = 'completed' WHERE id = ?`).run(entry.shift_id);
    }

    raiseFlag({
      userId: entry.user_id,
      type: FLAG_TYPES.MISSED_CLOCK_OUT,
      occurredAt: reference,
      refType: 'time_entry',
      refId: entry.id,
      detail: {
        auto_closed_at: reference.toISOString(),
        note: 'Officer did not clock out; entry auto-closed at the scheduled shift end.',
      },
    });
    closed += 1;
  }
  return closed;
}

/**
 * Run every sweep. Called on a timer by the server and again on demand from
 * the admin dashboard so a supervisor never looks at stale numbers.
 */
export function sweep(now = new Date()) {
  const result = { missedCheckIns: 0, noShows: 0, autoClosed: 0 };
  db.transaction(() => {
    result.missedCheckIns = sweepMissedCheckIns(now);
    result.noShows = sweepNoShows(now);
    result.autoClosed = sweepAbandonedShifts(now);
  })();
  return result;
}

/** Background timer. Returns a stop function. */
export function startComplianceWorker(intervalMs = 60000) {
  const tick = () => {
    try {
      sweep();
    } catch (err) {
      console.error('[usc] compliance sweep failed', err);
    }
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
