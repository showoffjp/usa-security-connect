/**
 * Changing a punch after the fact.
 *
 * One path for every correction, whether an administrator types it in or
 * approves an officer's request: the original times are kept on the entry the
 * first time it changes, the minutes are recomputed, and an entry in a closed
 * pay period - or one being moved into one - is refused, because those hours
 * are what was paid.
 */

import { db, audit } from '../lib/db.js';
import { HttpError, sqlToIso } from '../lib/http.js';
import { minutesBetween } from '../shared.js';
import { toSql } from './compliance.js';
import { assertHoursOpen } from './payPeriods.js';

/**
 * Resolve the times a correction would leave on an entry: a missing value
 * keeps what the entry has, `null` for clock-out clears it.
 */
export function resolveTimes(entry, { clockInAt, clockOutAt }) {
  const clockIn = clockInAt ? new Date(clockInAt) : new Date(sqlToIso(entry.clock_in_at));
  const clockOut =
    clockOutAt === undefined
      ? entry.clock_out_at
        ? new Date(sqlToIso(entry.clock_out_at))
        : null
      : clockOutAt
        ? new Date(clockOutAt)
        : null;
  if (Number.isNaN(clockIn.getTime()) || (clockOut && Number.isNaN(clockOut.getTime()))) {
    throw new HttpError(422, 'Those times are not valid.');
  }
  if (clockOut && clockOut <= clockIn) throw new HttpError(422, 'Clock-out must be after clock-in.');
  return { clockIn, clockOut };
}

export async function adjustEntry(entry, { clockInAt, clockOutAt, reason, userId, ip = null }) {
  const { clockIn, clockOut } = resolveTimes(entry, { clockInAt, clockOutAt });
  await assertHoursOpen(entry.clock_in_at, 'correct a punch');
  await assertHoursOpen(clockIn, 'correct a punch');

  await db
    .prepare(
      `UPDATE time_entries
       SET clock_in_at = ?, clock_out_at = ?, minutes_worked = ?,
           original_clock_in_at = COALESCE(original_clock_in_at, ?),
           original_clock_out_at = COALESCE(original_clock_out_at, ?),
           adjusted_by = ?, adjustment_reason = ?
       WHERE id = ?`
    )
    .run(
      toSql(clockIn),
      clockOut ? toSql(clockOut) : null,
      clockOut ? minutesBetween(clockIn.toISOString(), clockOut.toISOString()) : null,
      entry.clock_in_at,
      entry.clock_out_at,
      userId,
      reason,
      entry.id
    );
  await audit(userId, 'time_entry.adjusted', 'time_entry', entry.id, { reason }, ip);
  return db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(entry.id);
}
