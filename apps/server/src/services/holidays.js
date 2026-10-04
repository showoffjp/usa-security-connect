/**
 * The company holiday calendar.
 *
 * A shift counts as holiday work when it starts on a holiday - the same rule
 * that decides which day's pay rate applies to it - so one shift is never
 * half holiday and half not, and a timesheet reads the same way payroll does.
 */

import { db } from '../lib/db.js';
import { toDateString, parseDay, sqlToIso } from '../lib/http.js';
import { effectiveBillRate, toHours } from '../shared.js';
import { toSql } from './compliance.js';
import { isConfirmed } from './confirmations.js';

/** Open shifts on a holiday this close are raised in the alerts inbox. */
export const HOLIDAY_ALERT_DAYS = 14;

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

/**
 * How the next holidays are staffed: shifts rostered on each, how many are
 * still open or unconfirmed, and what the day will cost and bill on top of
 * a normal one. The premium is an estimate at each officer's current rate,
 * before any overtime overlap takes some of it back.
 */
export async function holidayOutlook({ limit = 3, withinDays = 120, now = new Date() } = {}) {
  const today = toDateString(now);
  const until = new Date(now);
  until.setDate(until.getDate() + withinDays);
  const rows = await db
    .prepare(`SELECT * FROM holidays WHERE day >= ? AND day <= ? ORDER BY day LIMIT ?`)
    .all(today, toDateString(until), limit);
  const out = [];
  for (const row of rows) {
    const h = presentHoliday(row);
    const start = parseDay(h.day);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const shifts = await db
      .prepare(
        `SELECT sh.id, sh.user_id, sh.post_id, sh.starts_at, sh.ends_at, sh.confirmed_key, sh.bill_rate_cents AS shift_bill,
                p.bill_rate_cents AS post_bill, u.bill_rate_cents AS officer_bill, u.pay_rate_cents, u.pay_type,
                u.employment_type, u.exempt
         FROM shifts sh JOIN posts p ON p.id = sh.post_id LEFT JOIN users u ON u.id = sh.user_id
         WHERE sh.status <> 'cancelled' AND sh.starts_at >= ? AND sh.starts_at < ?`
      )
      .all(toSql(start), toSql(end));
    let minutes = 0;
    let premium = 0;
    let uplift = 0;
    for (const s of shifts) {
      const m = Math.round((new Date(sqlToIso(s.ends_at)) - new Date(sqlToIso(s.starts_at))) / 60000);
      minutes += m;
      const earns = s.user_id && s.pay_type === 'hourly' && s.employment_type === 'w2' && !s.exempt && s.pay_rate_cents != null;
      if (earns) premium += (m / 60) * s.pay_rate_cents * (h.pay_multiplier - 1);
      const bill = effectiveBillRate({ shiftRateCents: s.shift_bill, postRateCents: s.post_bill, officerRateCents: s.officer_bill });
      if (bill != null) uplift += (m / 60) * bill * (h.bill_multiplier - 1);
    }
    const assigned = shifts.filter((s) => s.user_id).length;
    out.push({
      ...h,
      days_away: Math.round((start - parseDay(today)) / 86400000),
      shifts: shifts.length,
      assigned,
      open: shifts.length - assigned,
      confirmed: shifts.filter((s) => isConfirmed(s)).length,
      hours: toHours(minutes),
      estimated_premium: Math.round(premium) / 100,
      estimated_bill_uplift: Math.round(uplift) / 100,
    });
  }
  return out;
}
