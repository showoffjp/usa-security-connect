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
import { sqlToIso, pruneRateLimits } from '../lib/http.js';
import { RULES, FLAG_TYPES, FLAG_SEVERITY, minutesBetween } from '../shared.js';
import { notifyDueCheckIns, notifyNewFlags } from './push.js';

/** Store timestamps the way SQLite's datetime() does, so comparisons line up. */
/**
 * Timestamp for binding into a query.
 *
 * Always a full ISO string with the Z: a naive 'YYYY-MM-DD HH:MM:SS' would be
 * read in the server's session timezone rather than UTC, which shifts every
 * clock event by the offset.
 */
export const toSql = (d = new Date()) => new Date(d).toISOString();
export const fromSql = sqlToIso;

export async function raiseFlag({ userId, type, occurredAt, refType, refId, detail, severity }) {
  return (await db
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
      // detail is a jsonb column, so a bare string has to be encoded too. The
      // branch that passed one through raw could only ever produce invalid
      // JSON and fail the insert; it survived because every caller happens to
      // pass an object, which makes it a trap rather than a live fault.
      detail === undefined || detail === null ? null : JSON.stringify(detail)
    ));
}

/* ------------------------------------------------------------ check-ins --- */

/**
 * Queue the next status check-in for an open shift.
 * Officers must acknowledge within `window_minutes` or the check is missed.
 */
export async function scheduleNextCheckIn(timeEntry, post) {
  const interval = post?.check_in_interval_min || RULES.defaultCheckInIntervalMinutes;
  if (!interval || interval <= 0) return null;

  const open = (await db
    .prepare(
      `SELECT * FROM status_checks
       WHERE time_entry_id = ? AND status = 'pending'
       ORDER BY due_at LIMIT 1`
    )
    .get(timeEntry.id));
  if (open) return open;

  const last = (await db
    .prepare(`SELECT MAX(due_at) AS last_due FROM status_checks WHERE time_entry_id = ?`)
    .get(timeEntry.id))?.last_due;

  const from = last ? new Date(fromSql(last)) : new Date(fromSql(timeEntry.clock_in_at));
  const due = new Date(from.getTime() + interval * 60000);

  const info = (await db
    .prepare(
      `INSERT INTO status_checks (time_entry_id, user_id, due_at, window_minutes)
       VALUES (?,?,?,?)`
    )
    .run(timeEntry.id, timeEntry.user_id, toSql(due), RULES.checkInWindowMinutes));

  return (await db.prepare(`SELECT * FROM status_checks WHERE id = ?`).get(info.lastInsertRowid));
}

/** The check-in the officer is being asked for right now, if any. */
export async function currentCheckIn(timeEntryId) {
  const row = (await db
    .prepare(
      `SELECT * FROM status_checks
       WHERE time_entry_id = ? AND status = 'pending'
       ORDER BY due_at LIMIT 1`
    )
    .get(timeEntryId));
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

export async function answerCheckIn({ checkId, userId, lat, lng, note }) {
  const row = (await db.prepare(`SELECT * FROM status_checks WHERE id = ? AND user_id = ?`).get(checkId, userId));
  if (!row || row.status !== 'pending') return null;

  const dueAt = new Date(fromSql(row.due_at));
  const now = new Date();
  // Answering after the window still counts, but it is recorded as late.
  const status = now > new Date(dueAt.getTime() + row.window_minutes * 60000) ? 'late' : 'ok';

  (await db.prepare(
    `UPDATE status_checks
     SET responded_at = ?, status = ?, latitude = ?, longitude = ?, note = ?
     WHERE id = ?`
  ).run(toSql(now), status, lat ?? null, lng ?? null, note ?? null, checkId));

  if (status === 'late') {
    await raiseFlag({
      userId,
      type: FLAG_TYPES.MISSED_CHECK_IN,
      occurredAt: dueAt,
      refType: 'status_check',
      refId: checkId,
      severity: 'warning',
      detail: { late_by_minutes: minutesBetween(dueAt.toISOString(), now.toISOString()), answered: true },
    });
  }

  const entry = (await db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(row.time_entry_id));
  if (entry && !entry.clock_out_at) {
    const post = (await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(entry.post_id));
    await scheduleNextCheckIn(entry, post);
  }

  return { ...row, status, responded_at: now.toISOString() };
}

/* --------------------------------------------------------------- sweeps --- */

/** Status check-ins whose window has fully elapsed with no answer. */
async function sweepMissedCheckIns(now) {
  const overdue = (await db
    .prepare(
      `SELECT sc.*, te.post_id
       FROM status_checks sc
       JOIN time_entries te ON te.id = sc.time_entry_id
       WHERE sc.status = 'pending'
         AND datetime(sc.due_at, '+' || sc.window_minutes || ' minutes') < ?`
    )
    .all(toSql(now)));

  for (const check of overdue) {
    (await db.prepare(`UPDATE status_checks SET status = 'missed' WHERE id = ?`).run(check.id));
    await raiseFlag({
      userId: check.user_id,
      type: FLAG_TYPES.MISSED_CHECK_IN,
      occurredAt: fromSql(check.due_at),
      refType: 'status_check',
      refId: check.id,
      detail: { due_at: fromSql(check.due_at), answered: false },
    });

    // Keep the cadence going so the officer still gets the next prompt.
    const entry = (await db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(check.time_entry_id));
    if (entry && !entry.clock_out_at) {
      const post = (await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(entry.post_id));
      await scheduleNextCheckIn(entry, post);
    }
  }
  return overdue.length;
}

/** Scheduled shifts nobody ever clocked into. */
async function sweepNoShows(now) {
  const cutoff = toSql(new Date(now.getTime() - RULES.noShowMinutes * 60000));
  const missed = (await db
    .prepare(
      `SELECT s.* FROM shifts s
       WHERE s.status = 'scheduled'
         AND s.user_id IS NOT NULL
         AND s.starts_at < ?
         AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.shift_id = s.id)`
    )
    .all(cutoff));

  for (const shift of missed) {
    (await db.prepare(`UPDATE shifts SET status = 'missed' WHERE id = ?`).run(shift.id));
    await raiseFlag({
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

/** An officer waiting for a late relief is held over for at most this long. */
const HOLDOVER_MAX_MINUTES = 8 * 60;

/**
 * The relief for a time entry's shift: the shift by another officer at the
 * same post starting around when this one ends, and when that officer
 * clocked in there, if they have.
 */
async function reliefFor(entry) {
  const end = toSql(new Date(fromSql(entry.ends_at)));
  const relief = await db
    .prepare(
      `SELECT n.id, n.user_id FROM shifts n
       WHERE n.post_id = ? AND n.id != ? AND n.status != 'cancelled'
         AND n.user_id IS NOT NULL AND n.user_id != ?
         AND n.starts_at BETWEEN ?::timestamptz - interval '60 minutes' AND ?::timestamptz + interval '60 minutes'
       ORDER BY abs(EXTRACT(EPOCH FROM (n.starts_at - ?::timestamptz))) LIMIT 1`
    )
    .get(entry.post_id, entry.shift_id, entry.user_id, end, end, end);
  if (!relief) return null;
  const arrived = await db
    .prepare(
      `SELECT MIN(clock_in_at) AS at FROM time_entries
       WHERE user_id = ? AND post_id = ? AND clock_in_at >= ?::timestamptz - interval '60 minutes'`
    )
    .get(relief.user_id, entry.post_id, end);
  return { arrivedAt: arrived?.at ? new Date(fromSql(arrived.at)) : null };
}

/**
 * Shifts still open long after they should have ended.
 *
 * An officer whose relief has not turned up is not abandoning the post: they
 * are held over, and keep being paid, for up to HOLDOVER_MAX_MINUTES. Once
 * the relief clocks in, an officer who forgot to clock out is closed at the
 * handover, not at the scheduled end, so the time they stood is paid.
 */
async function sweepAbandonedShifts(now) {
  const open = (await db
    .prepare(
      `SELECT te.*, s.ends_at, s.post_id AS shift_post_id
       FROM time_entries te
       LEFT JOIN shifts s ON s.id = te.shift_id
       WHERE te.clock_out_at IS NULL`
    )
    .all());

  let closed = 0;
  for (const entry of open) {
    let reference = entry.ends_at
      ? new Date(fromSql(entry.ends_at))
      : new Date(new Date(fromSql(entry.clock_in_at)).getTime() + 16 * 60 * 60000);
    let deadline = new Date(reference.getTime() + RULES.autoClockOutAfterMinutes * 60000);
    if (now <= deadline) continue;

    // Held over for a relief: wait for them, then close at the handover.
    let note = 'Officer did not clock out; entry auto-closed at the scheduled shift end.';
    if (entry.ends_at && entry.shift_id) {
      const relief = await reliefFor({ ...entry, post_id: entry.post_id || entry.shift_post_id });
      const latest = new Date(reference.getTime() + HOLDOVER_MAX_MINUTES * 60000);
      if (relief && !relief.arrivedAt && now <= latest) continue;
      if (relief?.arrivedAt && relief.arrivedAt > reference) {
        reference = relief.arrivedAt < latest ? relief.arrivedAt : latest;
        deadline = new Date(reference.getTime() + RULES.autoClockOutAfterMinutes * 60000);
        if (now <= deadline) continue;
        note = 'Officer did not clock out after a holdover; entry auto-closed when their relief clocked in.';
      }
    }

    const minutes = minutesBetween(fromSql(entry.clock_in_at), reference.toISOString());
    (await db.prepare(
      `UPDATE time_entries
       SET clock_out_at = ?, minutes_worked = ?, auto_closed = 1
       WHERE id = ?`
    ).run(toSql(reference), Math.max(0, minutes), entry.id));

    if (entry.shift_id) {
      (await db.prepare(`UPDATE shifts SET status = 'completed' WHERE id = ?`).run(entry.shift_id));
    }

    await raiseFlag({
      userId: entry.user_id,
      type: FLAG_TYPES.MISSED_CLOCK_OUT,
      occurredAt: reference,
      refType: 'time_entry',
      refId: entry.id,
      detail: {
        auto_closed_at: reference.toISOString(),
        note,
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
/**
 * Keys, radios and weapons that went home in somebody's pocket.
 *
 * Written here with its own SQL rather than by calling the equipment service,
 * because that service already imports raiseFlag from this file and importing
 * it back would close a cycle. One direction is worth a dozen lines of query.
 *
 * Only items marked return_by_end_of_shift count, and only once the officer has
 * actually clocked out - an officer mid-shift is supposed to be holding their
 * radio.
 */
async function sweepUnreturnedEquipment() {
  const outstanding = (await db
    .prepare(
      `SELECT ea.id AS assignment_id, ea.user_id, ea.issued_at,
              e.category, e.label, e.identifier, s.name AS site_name
       FROM equipment_assignments ea
       JOIN equipment e ON e.id = ea.equipment_id
       LEFT JOIN sites s ON s.id = e.site_id
       WHERE ea.returned_at IS NULL
         AND e.return_by_end_of_shift = true
         AND NOT EXISTS (
           SELECT 1 FROM time_entries te
           WHERE te.user_id = ea.user_id AND te.clock_out_at IS NULL
         )`
    )
    .all());

  for (const item of outstanding) {
    await raiseFlag({
      userId: item.user_id,
      type: FLAG_TYPES.EQUIPMENT_NOT_RETURNED,
      occurredAt: fromSql(item.issued_at),
      refType: 'equipment_assignment',
      refId: item.assignment_id,
      detail: {
        category: item.category,
        label: item.label,
        identifier: item.identifier,
        site: item.site_name,
        issued_at: fromSql(item.issued_at),
      },
    });
  }
  return outstanding.length;
}

export async function sweep(now = new Date()) {
  const result = { missedCheckIns: 0, noShows: 0, autoClosed: 0, equipmentOut: 0, notified: 0, alerted: 0 };
  await db.transaction(async () => {
    result.missedCheckIns = await sweepMissedCheckIns(now);
    result.noShows = await sweepNoShows(now);
    result.autoClosed = await sweepAbandonedShifts(now);
    // After the auto-close, so a shift closed in this same pass is counted.
    result.equipmentOut = await sweepUnreturnedEquipment();
  })();

  // Notifications run outside the transaction: they call out to a third-party
  // service, and a slow or failing push must never hold a database write open.
  try {
    result.notified = await notifyDueCheckIns(now);
    result.alerted = await notifyNewFlags();
  } catch (err) {
    console.error('[usc] notification pass failed', err.message);
  }

  // Late arrivals and no-shows, to the supervisors who asked by text and push.
  // Imported lazily: attendance.js imports this module for toSql.
  try {
    const { sweepAttendance } = await import('./attendance.js');
    result.attendance = await sweepAttendance(now);
  } catch (err) {
    console.error('[usc] late and no-show alerts failed', err.message);
  }

  // Imported lazily: confirmations.js imports this module for toSql.
  try {
    const { sendConfirmReminders } = await import('./confirmations.js');
    result.confirmReminders = await sendConfirmReminders(now);
  } catch (err) {
    console.error('[usc] shift confirmation reminders failed', err.message);
  }

  // Spent rate-limit counters. Housekeeping rather than compliance, but this
  // is the only thing that runs on a timer.
  try {
    result.rateLimitsPruned = await pruneRateLimits();
  } catch (err) {
    console.error('[usc] rate limit prune failed', err.message);
  }

  // Imported lazily: tracking.js imports this module for raiseFlag.
  try {
    const { pruneLocationPings } = await import('./tracking.js');
    result.locationPingsPruned = await pruneLocationPings(now);
  } catch (err) {
    console.error('[usc] location retention sweep failed', err.message);
  }

  return result;
}

/** Background timer. Returns a stop function. */
export async function startComplianceWorker(intervalMs = 60000) {
  const tick = async () => {
    try {
      await sweep();
    } catch (err) {
      console.error('[usc] compliance sweep failed', err);
    }
  };
  await tick();
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
