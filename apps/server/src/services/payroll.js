/**
 * Pricing hours: what they cost and what they bill.
 *
 * One place, used by the report centre, the Timesheets screen and invoice
 * cost, so the three cannot disagree. Two rules matter:
 *
 *  - Each hour is paid at the rate in effect on the day it was worked, read
 *    from pay_rate_history, so a raise does not reprice last month.
 *  - A post can pay more than the officer standing it earns. An armed yard
 *    differential applies only while they are on that post, so the post is part
 *    of the rate lookup rather than something added afterwards.
 *  - Overtime is decided per payroll week (Monday to Sunday), never across a
 *    range, at the multiplier over the week's weighted-average rate - the
 *    FLSA "regular rate".
 *  - A shift that starts on a company holiday bills at the holiday rate and,
 *    for W-2 officers who earn overtime, pays a holiday premium. Holiday hours
 *    that are also overtime get the larger premium, not both.
 */

import { db } from '../lib/db.js';
import { toDateString, sqlToIso } from '../lib/http.js';
import {
  computePeriodPay,
  effectiveBillRate,
  billableMinutes,
  amountForMinutes,
  payrollWeekOf,
  holidayPremiumCents,
  RULES,
} from '../shared.js';
import { toSql } from './compliance.js';
import { holidaysForSpan } from './holidays.js';

/**
 * Every rate change, oldest first per person, plus any differentials the posts
 * themselves carry. Small enough to read whole, and read once per report rather
 * than once per time entry.
 */
export async function loadRateBook() {
  const history = await db
    .prepare(
      `SELECT user_id, effective_on, pay_type, pay_rate_cents, overtime_multiplier
       FROM pay_rate_history ORDER BY user_id, effective_on, id`
    )
    .all();
  const book = new Map();
  for (const h of history) {
    if (!book.has(h.user_id)) book.set(h.user_id, []);
    book.get(h.user_id).push(h);
  }

  const posts = await db
    .prepare(
      `SELECT post_id, user_id, effective_on, pay_rate_cents, overtime_multiplier
       FROM post_pay_rates ORDER BY post_id, effective_on, id`
    )
    .all();
  const byPost = new Map();
  for (const p of posts) {
    if (!byPost.has(p.post_id)) byPost.set(p.post_id, []);
    byPost.get(p.post_id).push(p);
  }

  book.posts = byPost;
  return book;
}

/** The latest entry in a list that had taken effect by `day`. */
function latestBy(list, day, accept = () => true) {
  let found = null;
  for (const row of list || []) {
    if (String(row.effective_on) > day) break;
    if (accept(row)) found = row;
  }
  return found;
}

/**
 * The pay rate that applied to `person` (a row with user_id, pay_type,
 * pay_rate_cents, overtime_multiplier) on `day` (YYYY-MM-DD), for work at
 * `postId`.
 *
 * Most specific wins: a differential naming this officer at this post, then one
 * the post pays anybody, then the officer's own rate history, then the record
 * as it stands. An armed yard that pays more than the officer's standing rate
 * pays it only while they are standing that post - which is the whole point of
 * a differential, and why the post has to be part of the lookup rather than
 * something applied afterwards.
 */
export function rateOn(book, person, day, postId = null) {
  if (postId != null && book.posts) {
    const atPost = book.posts.get(postId);
    const mine = latestBy(atPost, day, (r) => r.user_id === person.user_id);
    const anyone = latestBy(atPost, day, (r) => r.user_id == null);
    const differential = mine || anyone;
    if (differential) {
      return {
        rate: differential.pay_rate_cents,
        multiplier: differential.overtime_multiplier ?? person.overtime_multiplier,
        source: mine ? 'officer_at_post' : 'post',
      };
    }
  }

  const found = latestBy(book.get(person.user_id), day);
  // A change of pay basis is not something a rate lookup can reconcile;
  // it falls back to the record as it stands.
  return found && found.pay_type === person.pay_type && found.pay_rate_cents != null
    ? { rate: found.pay_rate_cents, multiplier: found.overtime_multiplier ?? person.overtime_multiplier, source: 'history' }
    : { rate: person.pay_rate_cents, multiplier: person.overtime_multiplier, source: 'record' };
}

/** The local calendar day an instant falls on. */
export const dayOf = (value) => toDateString(new Date(sqlToIso(value)));

/** WHERE fragments and their parameters, for queries joined to u (users) and s (sites). */
export function scope(f, userCol = 'u.id') {
  const where = [];
  const params = [];
  if (f.siteId) {
    where.push('s.id = ?');
    params.push(f.siteId);
  }
  if (f.userId) {
    where.push(`${userCol} = ?`);
    params.push(f.userId);
  }
  if (f.employmentType) {
    where.push('u.employment_type = ?');
    params.push(f.employmentType);
  }
  return { sql: where.length ? `AND ${where.join(' AND ')}` : '', params };
}

/** Completed time entries in range, with everything pay and billing need. */
export async function loadPricedEntries(f) {
  const sc = scope(f);
  const rows = await db
    .prepare(
      `SELECT te.id, te.user_id, te.shift_id, te.clock_in_at, te.clock_out_at, te.minutes_worked,
              te.unpaid_break_minutes, te.late_minutes, te.clock_in_geofence, te.clock_in_distance_m,
              te.auto_closed,
              u.employee_code, u.first_name || ' ' || u.last_name AS officer, u.role,
              u.employment_type, u.pay_type, u.exempt, u.pay_rate_cents, u.salary_cents,
              u.bill_rate_cents AS officer_bill_cents, u.overtime_multiplier,
              u.business_name, u.tax_id_last4, u.w9_on_file,
              p.id AS post_id, p.name AS post_name, p.post_code, p.bill_rate_cents AS post_bill_cents,
              s.id AS site_id, s.name AS site_name, s.client_name, s.city,
              sh.bill_rate_cents AS shift_bill_cents
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       JOIN posts p ON p.id = te.post_id
       JOIN sites s ON s.id = p.site_id
       LEFT JOIN shifts sh ON sh.id = te.shift_id
       WHERE te.clock_out_at IS NOT NULL AND te.clock_in_at >= ? AND te.clock_in_at < ?
       ${sc.sql}
       ORDER BY te.clock_in_at`
    )
    .all(toSql(f.from), toSql(f.to), ...sc.params);

  const book = await loadRateBook();
  const holidays = await holidaysForSpan(f.from, f.to);

  return rows.map((r) => {
    const day = toDateString(new Date(sqlToIso(r.clock_in_at)));
    const holiday = holidays.get(day) || null;
    const applied = rateOn(book, r, day, r.post_id);
    r = { ...r, pay_rate_cents: applied.rate, overtime_multiplier: applied.multiplier || 1.5 };
    const paid = billableMinutes(r.minutes_worked, r.unpaid_break_minutes);
    const billRate = effectiveBillRate({
      shiftRateCents: r.shift_bill_cents,
      postRateCents: r.post_bill_cents,
      officerRateCents: r.officer_bill_cents,
    });
    // Base cost of this entry. Overtime premium belongs to the officer's week,
    // not to any one site, so it is reported against the officer instead.
    const baseCost =
      r.pay_type === 'per_shift'
        ? r.pay_rate_cents ?? 0
        : r.pay_type === 'salary'
          ? 0
          : amountForMinutes(paid, r.pay_rate_cents);
    // Holiday hours bill at the holiday rate. The premium they pay is worked
    // out per week by personPay; here it is only the entry's own share, for
    // the cost an invoice carries against the client's site.
    const holidayBillRate = holiday && billRate != null ? Math.round(billRate * holiday.bill_multiplier) : billRate;
    const earnsHolidayPay = r.pay_type === 'hourly' && r.employment_type === 'w2' && !r.exempt;
    return {
      ...r,
      clock_in_at: sqlToIso(r.clock_in_at),
      clock_out_at: sqlToIso(r.clock_out_at),
      paid_minutes: paid,
      holiday,
      bill_rate_cents: billRate,
      charged_rate_cents: holidayBillRate,
      billed_cents: holidayBillRate != null ? amountForMinutes(paid, holidayBillRate) : 0,
      base_cost_cents: baseCost,
      holiday_premium_cents:
        holiday && earnsHolidayPay && r.pay_rate_cents != null ? Math.round((paid / 60) * r.pay_rate_cents * (holiday.pay_multiplier - 1)) : 0,
      week: payrollWeekOf(sqlToIso(r.clock_in_at)),
      day,
    };
  });
}

/**
 * What one person is owed for a set of entries.
 *
 * Hourly pay is worked out payroll week by payroll week. Each hour is paid at
 * the rate that applied on its day, and the overtime premium is the multiplier
 * over the week's weighted-average rate - the FLSA "regular rate" - so a raise
 * mid-week is priced the way a payroll provider would price it. With one rate
 * all week this is exactly rate x regular + rate x multiplier x overtime.
 */
export function personPay(list) {
  const first = list[0];
  if (first.pay_type === 'hourly') {
    const earnsOvertime = first.employment_type === 'w2' && !first.exempt;
    const threshold = RULES.overtimeWeeklyHours * 60;
    let minutes = 0;
    let overtimeMinutes = 0;
    let payCents = list.some((e) => e.pay_rate_cents == null) ? null : 0;
    let overtimePayCents = payCents == null ? null : 0;
    let holidayMinutes = 0;
    let holidayPayCents = payCents == null ? null : 0;
    for (const week of groupBy(list, 'week').values()) {
      const weekMinutes = week.reduce((n, e) => n + e.paid_minutes, 0);
      const straight = week.reduce((n, e) => n + (e.paid_minutes / 60) * (e.pay_rate_cents || 0), 0);
      const ot = earnsOvertime ? Math.max(0, weekMinutes - threshold) : 0;
      const regularRate = weekMinutes ? (straight * 60) / weekMinutes : 0;
      const multiplier = week[week.length - 1].overtime_multiplier || 1.5;
      if (payCents != null) {
        const weekPay = Math.round(straight + (ot / 60) * regularRate * (multiplier - 1));
        // Overtime hours at the full multiplier, as a pay stub shows them;
        // regular pay is the rest, so the two always add up to the week.
        overtimePayCents += Math.min(weekPay, Math.round((ot / 60) * regularRate * multiplier));
        payCents += weekPay;
      }
      if (earnsOvertime) {
        const ordered = [...week].sort((a, b) => new Date(a.clock_in_at) - new Date(b.clock_in_at));
        const holiday = holidayPremiumCents(ordered, { thresholdMinutes: threshold, overtimeMultiplier: multiplier });
        holidayMinutes += holiday.minutes;
        if (payCents != null) {
          holidayPayCents += holiday.cents;
          payCents += holiday.cents;
        }
      }
      minutes += weekMinutes;
      overtimeMinutes += ot;
    }
    return {
      minutes,
      regularMinutes: minutes - overtimeMinutes,
      overtimeMinutes,
      earnsOvertime,
      holidayMinutes,
      payCents,
      regularPayCents: payCents == null ? null : payCents - overtimePayCents - holidayPayCents,
      overtimePayCents,
      holidayPayCents,
    };
  }

  const weeks = new Map();
  for (const e of list) weeks.set(e.week, (weeks.get(e.week) || 0) + e.paid_minutes);
  const pay = computePeriodPay({
    weeks: [...weeks.values()],
    shifts: list.length,
    employmentType: first.employment_type,
    payType: first.pay_type,
    exempt: Boolean(first.exempt),
    payRateCents: first.pay_rate_cents,
    billRateCents: null,
    overtimeMultiplier: first.overtime_multiplier || 1.5,
    salaryCents: first.salary_cents,
  });
  // Salary, per-shift and contractor pay carries no overtime or holiday premium.
  return { ...pay, regularPayCents: pay.payCents, overtimePayCents: pay.payCents == null ? null : 0, holidayMinutes: 0, holidayPayCents: pay.payCents == null ? null : 0 };
}

export const groupBy = (list, key) => {
  const map = new Map();
  for (const item of list) {
    const k = typeof key === 'function' ? key(item) : item[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
};

