/**
 * Paid time off: the balance, what a pay period pays and what it earns.
 *
 * The ledger is the record: every hour earned at a payroll close, used by an
 * approved time-off request, or adjusted by the office. The balance is its
 * sum, so nothing has to be kept in step.
 *
 * Paid time off is paid like an expense claim is reimbursed: an approved
 * request is paid by the first close on or after the day it starts, at the
 * officer's hourly rate that day, beside - not inside - the pay for hours
 * worked. Reopening the period hands it back, and takes back what the close
 * credited.
 */

import { db } from '../lib/db.js';
import { HttpError, sqlToIso } from '../lib/http.js';
import { PTO_CAP_HOURS, PTO_ACCRUAL_WORKED_HOURS, PTO_DAY_MAX_HOURS, PTO_KIND_LABEL, ptoAccrued, ptoEligible } from '../shared.js';
import { loadRateBook, rateOn } from './payroll.js';
import { dayString } from './payPeriods.js';

const hrs = (v) => Math.round((Number(v) || 0) * 100) / 100;

export const PTO_RULES = {
  accrualWorkedHours: PTO_ACCRUAL_WORKED_HOURS,
  capHours: PTO_CAP_HOURS,
  dayMaxHours: PTO_DAY_MAX_HOURS,
};

/** What someone has, what is promised to requests still waiting, and what is left to ask for. */
export async function ptoBalance(userId) {
  const { balance } = await db.prepare(`SELECT COALESCE(SUM(hours), 0) AS balance FROM pto_ledger WHERE user_id = ?`).get(userId);
  const { pending } = await db
    .prepare(`SELECT COALESCE(SUM(pto_hours), 0) AS pending FROM time_off_requests WHERE user_id = ? AND status = 'pending' AND pto_hours > 0`)
    .get(userId);
  const b = hrs(balance);
  const p = hrs(pending);
  return { balance: b, pending: p, available: hrs(b - p) };
}

/** The ledger, newest first, as a statement. */
export async function ptoHistory(userId, limit = 30) {
  const rows = await db
    .prepare(
      `SELECT l.*, p.period_start, p.period_end, t.starts_on, t.ends_on, t.type AS request_type,
              c.first_name || ' ' || c.last_name AS created_by_name
       FROM pto_ledger l
       LEFT JOIN pay_periods p ON p.id = l.pay_period_id
       LEFT JOIN time_off_requests t ON t.id = l.time_off_request_id
       LEFT JOIN users c ON c.id = l.created_by
       WHERE l.user_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT ?`
    )
    .all(userId, limit);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    kind_label: PTO_KIND_LABEL[r.kind] || r.kind,
    hours: hrs(r.hours),
    note: r.note || null,
    period: r.pay_period_id ? `${dayString(r.period_start)} to ${dayString(r.period_end)}` : null,
    time_off: r.time_off_request_id ? { id: r.time_off_request_id, starts_on: dayString(r.starts_on), ends_on: dayString(r.ends_on), type: r.request_type } : null,
    created_by: r.created_by_name || null,
    created_at: sqlToIso(r.created_at),
  }));
}

/** Days from start to end, both included. */
export function daysIn(startsOn, endsOn) {
  const a = new Date(`${dayString(startsOn)}T12:00:00`);
  const b = new Date(`${dayString(endsOn)}T12:00:00`);
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * The paid time off a period pays: for a closed period, what it paid; for an
 * open one, the approved requests its close would pay, priced now, and how
 * many requests starting in it still wait for a decision.
 */
export async function periodPto(period) {
  const end = dayString(period.period_end);
  const closed = period.status === 'closed';
  const rows = await db
    .prepare(
      `SELECT t.*, u.employee_code, u.first_name || ' ' || u.last_name AS officer, u.pay_type, u.pay_rate_cents,
              u.overtime_multiplier, u.employment_type
       FROM time_off_requests t JOIN users u ON u.id = t.user_id
       WHERE ${closed ? 't.pto_paid_period_id = ?' : `t.status = 'approved' AND t.pto_hours > 0 AND t.pto_paid_period_id IS NULL AND t.starts_on <= ?`}
       ORDER BY u.last_name, t.starts_on`
    )
    .all(closed ? period.id : end);
  const book = closed ? null : await loadRateBook();
  const items = rows.map((r) => {
    const hours = hrs(r.pto_hours);
    let cents = r.pto_pay_cents;
    let rate = null;
    if (!closed) {
      rate = rateOn(book, { user_id: r.user_id, pay_type: r.pay_type, pay_rate_cents: r.pay_rate_cents, overtime_multiplier: r.overtime_multiplier }, dayString(r.starts_on)).rate;
      cents = rate == null ? null : Math.round(hours * rate);
    } else if (hours) {
      rate = Math.round(cents / hours);
    }
    return {
      request_id: r.id,
      user_id: r.user_id,
      officer: r.officer,
      employee_code: r.employee_code,
      type: r.type,
      starts_on: dayString(r.starts_on),
      ends_on: dayString(r.ends_on),
      hours,
      rate: rate == null ? null : rate / 100,
      pay_cents: cents,
      pay: cents == null ? null : cents / 100,
    };
  });
  const pending = closed
    ? 0
    : Number((await db.prepare(`SELECT COUNT(*) AS n FROM time_off_requests WHERE status = 'pending' AND pto_hours > 0 AND starts_on <= ?`).get(end)).n);
  const byUser = new Map();
  const hoursByUser = new Map();
  for (const i of items) {
    byUser.set(i.user_id, (byUser.get(i.user_id) || 0) + (i.pay_cents || 0));
    hoursByUser.set(i.user_id, hrs((hoursByUser.get(i.user_id) || 0) + i.hours));
  }
  const totalCents = items.reduce((n, i) => n + (i.pay_cents || 0), 0);
  return {
    items,
    byUser,
    hoursByUser,
    unpriced: items.filter((i) => i.pay_cents == null).length,
    hours: hrs(items.reduce((n, i) => n + i.hours, 0)),
    total_cents: totalCents,
    total: totalCents / 100,
    pending,
  };
}

/**
 * What each officer's hours in the period earn. A closed period reads what it
 * credited; an open one works out what its close would, against the balance
 * as it stands, so nobody is shown going over the cap.
 */
export async function periodAccruals(period, lines) {
  const out = new Map();
  if (period.status === 'closed') {
    const rows = await db
      .prepare(`SELECT user_id, SUM(hours) AS h FROM pto_ledger WHERE pay_period_id = ? AND kind = 'accrual' GROUP BY user_id`)
      .all(period.id);
    for (const r of rows) out.set(r.user_id, hrs(r.h));
    return out;
  }
  const eligible = lines.filter((l) => ptoEligible(l) && l.minutes > 0);
  if (!eligible.length) return out;
  const balances = await db
    .prepare(`SELECT user_id, COALESCE(SUM(hours), 0) AS b FROM pto_ledger WHERE user_id IN (${eligible.map(() => '?').join(',')}) GROUP BY user_id`)
    .all(...eligible.map((l) => l.user_id));
  const balanceBy = new Map(balances.map((b) => [b.user_id, hrs(b.b)]));
  for (const l of eligible) {
    const room = Math.max(0, PTO_CAP_HOURS - (balanceBy.get(l.user_id) || 0));
    out.set(l.user_id, hrs(Math.min(ptoAccrued(l.minutes), room)));
  }
  return out;
}

/** At close: pay the approved time off and credit what the hours earned. */
export async function closePto(period, lines, items, closedBy) {
  for (const i of items) {
    if (i.pay_cents == null) throw new HttpError(409, `${i.officer} has paid time off and no hourly rate on record.`);
    await db
      .prepare(`UPDATE time_off_requests SET pto_paid_period_id = ?, pto_pay_cents = ? WHERE id = ?`)
      .run(period.id, i.pay_cents, i.request_id);
  }
  const accruals = await periodAccruals(period, lines);
  let credited = 0;
  for (const [userId, hours] of accruals) {
    if (hours <= 0) continue;
    await db
      .prepare(`INSERT INTO pto_ledger (user_id, kind, hours, pay_period_id, note, created_by) VALUES (?, 'accrual', ?, ?, ?, ?)`)
      .run(userId, hours, period.id, null, closedBy);
    credited += hours;
  }
  return { paid: items.length, credited: hrs(credited) };
}

/** At reopen: the time off waits for the next close, and the hours earned are taken back. */
export async function reopenPto(period) {
  await db.prepare(`UPDATE time_off_requests SET pto_paid_period_id = NULL, pto_pay_cents = NULL WHERE pto_paid_period_id = ?`).run(period.id);
  await db.prepare(`DELETE FROM pto_ledger WHERE pay_period_id = ? AND kind = 'accrual'`).run(period.id);
}
