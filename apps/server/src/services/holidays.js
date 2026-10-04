/**
 * The company holiday calendar.
 *
 * A shift counts as holiday work when it starts on a holiday - the same rule
 * that decides which day's pay rate applies to it - so one shift is never
 * half holiday and half not, and a timesheet reads the same way payroll does.
 */

import { db } from '../lib/db.js';
import { toDateString } from '../lib/http.js';

export const presentHoliday = (h) =>
  h && {
    id: h.id,
    day: h.day,
    name: h.name,
    pay_multiplier: Number(h.pay_multiplier),
    bill_multiplier: Number(h.bill_multiplier),
  };

/** Holidays from one calendar day to another, inclusive, keyed by day. */
export async function holidaysBetween(fromDay, toDay) {
  const rows = await db
    .prepare(`SELECT * FROM holidays WHERE day >= ? AND day <= ? ORDER BY day`)
    .all(fromDay, toDay);
  return new Map(rows.map((h) => [h.day, presentHoliday(h)]));
}

/** Holidays covering a span of instants, by the local calendar days they touch. */
export async function holidaysForSpan(from, to) {
  return holidaysBetween(toDateString(new Date(from)), toDateString(new Date(to)));
}

/** The next holidays from today, for the cards that warn ahead. */
export async function upcomingHolidays(limit = 4, today = toDateString(new Date())) {
  const rows = await db.prepare(`SELECT * FROM holidays WHERE day >= ? ORDER BY day LIMIT ?`).all(today, limit);
  return rows.map(presentHoliday);
}
