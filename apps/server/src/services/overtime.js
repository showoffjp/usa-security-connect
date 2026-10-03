/**
 * Overtime watch: who is heading past 40 hours in a payroll week, before it
 * happens.
 *
 * For each W-2 officer paid by the hour (the only people who earn overtime),
 * the week's projection is what they have already worked plus what is still
 * on the roster: a shift in progress counts for the rest of its time, a shift
 * still to come counts whole, and a shift that came and went unworked counts
 * for nothing. The shift that first carries them over the line is named, so
 * a scheduler can hand it to someone with hours to spare - the candidate
 * ranking on the shift already puts those people first.
 */

import { db } from '../lib/db.js';
import { parseDay, sqlToIso, toDateString } from '../lib/http.js';
import { RULES, toHours, payrollWeekOf } from '../shared.js';
import { toSql } from './compliance.js';

/** Within this many hours of the line counts as close to it. */
export const NEAR_HOURS = 4;

export async function overtimeWatch(day = new Date(), now = new Date()) {
  const weekStart = parseDay(payrollWeekOf(day));
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const threshold = RULES.overtimeWeeklyHours * 60;
  const near = threshold - NEAR_HOURS * 60;

  const people = await db
    .prepare(
      `SELECT id, employee_code, first_name || ' ' || last_name AS name, pay_rate_cents, overtime_multiplier
       FROM users
       WHERE status = 'active' AND role IN ('officer','supervisor')
         AND employment_type = 'w2' AND pay_type = 'hourly' AND NOT COALESCE(exempt, false)`
    )
    .all();
  if (!people.length) return empty(weekStart, weekEnd);

  // Worked: every finished entry in the week, at its paid minutes.
  const worked = new Map(
    (
      await db
        .prepare(
          `SELECT user_id, COALESCE(SUM(minutes_worked), 0) AS m FROM time_entries
           WHERE clock_out_at IS NOT NULL AND clock_in_at >= ? AND clock_in_at < ? GROUP BY user_id`
        )
        .all(toSql(weekStart), toSql(weekEnd))
    ).map((r) => [r.user_id, Number(r.m) || 0])
  );

  // Still to work: rostered shifts with no finished entry that have not ended.
  const shifts = await db
    .prepare(
      `SELECT sh.id, sh.user_id, sh.starts_at, sh.ends_at, p.name AS post_name, s.name AS site_name
       FROM shifts sh JOIN posts p ON p.id = sh.post_id JOIN sites s ON s.id = p.site_id
       WHERE sh.user_id IS NOT NULL AND sh.status <> 'cancelled'
         AND sh.starts_at >= ? AND sh.starts_at < ? AND sh.ends_at > ?
         AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.shift_id = sh.id AND te.clock_out_at IS NOT NULL)
       ORDER BY sh.starts_at`
    )
    .all(toSql(weekStart), toSql(weekEnd), toSql(now));
  const ahead = new Map();
  for (const sh of shifts) {
    if (!ahead.has(sh.user_id)) ahead.set(sh.user_id, []);
    ahead.get(sh.user_id).push(sh);
  }

  const officers = [];
  for (const p of people) {
    const done = worked.get(p.id) || 0;
    let cumulative = done;
    let tipping = null;
    const list = ahead.get(p.id) || [];
    for (const sh of list) {
      const from = Math.max(new Date(sqlToIso(sh.starts_at)).getTime(), now.getTime());
      const minutes = Math.max(0, Math.round((new Date(sqlToIso(sh.ends_at)).getTime() - from) / 60000));
      const before = cumulative;
      cumulative += minutes;
      if (!tipping && cumulative > threshold) {
        tipping = {
          shift_id: sh.id,
          starts_at: sqlToIso(sh.starts_at),
          ends_at: sqlToIso(sh.ends_at),
          post_name: sh.post_name,
          site_name: sh.site_name,
          overtime_hours: toHours(cumulative - Math.max(before, threshold)),
          // Already over before this shift starts: moving it alone will not keep them under.
          already_over: before >= threshold,
        };
      }
    }
    if (cumulative < near) continue;
    const otMinutes = Math.max(0, cumulative - threshold);
    const premiumCents = p.pay_rate_cents != null ? Math.round((otMinutes / 60) * p.pay_rate_cents * ((p.overtime_multiplier || 1.5) - 1)) : null;
    officers.push({
      user_id: p.id,
      name: p.name,
      employee_code: p.employee_code,
      worked_hours: toHours(done),
      scheduled_hours: toHours(cumulative - done),
      projected_hours: toHours(cumulative),
      overtime_hours: toHours(otMinutes),
      worked_overtime_hours: toHours(Math.max(0, done - threshold)),
      premium: premiumCents == null ? null : premiumCents / 100,
      status: cumulative > threshold ? 'over' : 'near',
      shifts_left: list.length,
      tipping_shift: tipping,
    });
  }
  officers.sort((a, b) => b.projected_hours - a.projected_hours || a.name.localeCompare(b.name));

  const over = officers.filter((o) => o.status === 'over');
  return {
    week_start: payrollWeekOf(weekStart),
    week_end: toDateString(new Date(weekEnd.getTime() - 86400000)),
    threshold_hours: RULES.overtimeWeeklyHours,
    near_hours: NEAR_HOURS,
    officers,
    totals: {
      over: over.length,
      near: officers.length - over.length,
      overtime_hours: Math.round(over.reduce((n, o) => n + o.overtime_hours, 0) * 100) / 100,
      premium: Math.round(over.reduce((n, o) => n + (o.premium || 0), 0) * 100) / 100,
      // Overtime a reassignment could still prevent: on shifts not yet started.
      avoidable: over.filter((o) => o.tipping_shift && !o.tipping_shift.already_over && new Date(o.tipping_shift.starts_at) > now).length,
    },
  };
}

function empty(weekStart, weekEnd) {
  return {
    week_start: payrollWeekOf(weekStart),
    week_end: toDateString(new Date(weekEnd.getTime() - 86400000)),
    threshold_hours: RULES.overtimeWeeklyHours,
    near_hours: NEAR_HOURS,
    officers: [],
    totals: { over: 0, near: 0, overtime_hours: 0, premium: 0, avoidable: 0 },
  };
}
