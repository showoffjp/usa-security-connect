/**
 * Demo paid time off.
 *
 *   - Every W-2 hourly employee starts with a balance carried over from the
 *     old payroll system, and the closed week's hours have earned more.
 *   - Marcus Bell (1003) has asked for a week's vacation from his balance,
 *     waiting for a decision.
 *   - Sick days already approved for Alicia Nunez and 1027 are paid from
 *     their balances, as is a vacation coming up for 1016.
 *   - A personal day last week (1029) is paid by the close still to come; a
 *     day the week before (1012) was paid by the closed one.
 */

import { toDateString } from './lib/http.js';
import { toSql } from './services/compliance.js';
import { PTO_CAP_HOURS, ptoAccrued, ptoEligible } from './shared.js';

export async function seedPto({ db }) {
  const people = await db
    .prepare(`SELECT id, employee_code, employment_type, pay_type, pay_rate_cents FROM users WHERE status = 'active' AND role <> 'admin'`)
    .all();
  const eligible = people.filter(ptoEligible);
  const byCode = new Map(people.map((p) => [p.employee_code, p]));
  const admin = await db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();
  const supervisor = await db.prepare(`SELECT id FROM users WHERE role = 'supervisor' ORDER BY id LIMIT 1`).get();
  const periods = await db.prepare(`SELECT * FROM pay_periods ORDER BY period_start`).all();
  const closed = periods.find((p) => p.status === 'closed');
  const waiting = periods.find((p) => p.status === 'open');
  const day = (d) => (d instanceof Date ? toDateString(d) : String(d).slice(0, 10));
  const plusDays = (d, n) => {
    const x = new Date(`${day(d)}T12:00:00`);
    x.setDate(x.getDate() + n);
    return toDateString(x);
  };

  // What each request to be paid from a balance will need, so the carry-over covers it.
  const PAID = [
    { code: '1003', match: { type: 'vacation', status: 'pending' }, hours: 40 },
    { code: '1006', match: { type: 'sick', status: 'approved' }, hours: 16 },
    { code: '1027', match: { type: 'sick', status: 'approved' }, hours: 16 },
    { code: '1016', match: { type: 'vacation', status: 'approved' }, hours: 24 },
  ];
  const needs = new Map(PAID.map((p) => [p.code, p.hours]));
  needs.set('1029', (needs.get('1029') || 0) + 8);
  needs.set('1012', (needs.get('1012') || 0) + 8);

  const ledger = db.prepare(
    `INSERT INTO pto_ledger (user_id, kind, hours, pay_period_id, time_off_request_id, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const balance = new Map();
  const add = async (userId, kind, hours, { period = null, request = null, note = null, by = null, at = new Date() } = {}) => {
    await ledger.run(userId, kind, hours, period, request, note, by, toSql(at));
    balance.set(userId, Math.round(((balance.get(userId) || 0) + hours) * 100) / 100);
  };

  // The carry-over, a little before the closed week.
  const carriedAt = new Date(`${closed ? plusDays(closed.period_start, -10) : day(new Date(Date.now() - 24 * 86400000))}T07:00:00`);
  for (const u of eligible) {
    const base = 6 + ((u.id * 7) % 31);
    const hours = Math.min(PTO_CAP_HOURS - 10, Math.max(base, (needs.get(u.employee_code) || 0) + 6));
    await add(u.id, 'adjustment', hours, { note: 'Balance carried over from the previous payroll system.', by: admin?.id, at: carriedAt });
  }

  // What the closed week's hours earned.
  if (closed) {
    const lines = await db.prepare(`SELECT user_id, minutes, employment_type, pay_type FROM pay_period_lines WHERE pay_period_id = ?`).all(closed.id);
    for (const l of lines) {
      if (!ptoEligible(l)) continue;
      const room = Math.max(0, PTO_CAP_HOURS - (balance.get(l.user_id) || 0));
      const hours = Math.min(ptoAccrued(l.minutes), room);
      if (hours > 0) await add(l.user_id, 'accrual', hours, { period: closed.id, by: admin?.id, at: closed.closed_at || new Date() });
    }
  }

  // Requests already on file, now paid from the balance.
  let requests = 0;
  for (const p of PAID) {
    const u = byCode.get(p.code);
    if (!u || !ptoEligible(u)) continue;
    const r = await db
      .prepare(`SELECT * FROM time_off_requests WHERE user_id = ? AND type = ? AND status = ? ORDER BY starts_on LIMIT 1`)
      .get(u.id, p.match.type, p.match.status);
    if (!r) continue;
    await db.prepare(`UPDATE time_off_requests SET pto_hours = ? WHERE id = ?`).run(p.hours, r.id);
    if (r.status === 'approved') {
      await add(u.id, 'used', -p.hours, { request: r.id, by: r.decided_by, at: r.decided_at || new Date() });
    }
    requests++;
  }

  // A personal day in each payroll week: one paid by the closed close, one waiting for the next.
  const newDay = async (code, period, paid) => {
    const u = byCode.get(code);
    if (!u || !ptoEligible(u) || !period) return;
    const on = plusDays(period.period_start, 2);
    const decided = new Date(`${plusDays(period.period_start, -3)}T10:00:00`);
    const info = await db
      .prepare(
        `INSERT INTO time_off_requests (user_id, type, starts_on, ends_on, reason, status, decided_by, decided_at, decision_note,
           pto_hours, pto_pay_cents, pto_paid_period_id, created_at)
         VALUES (?,?,?,?,?,'approved',?,?,?,?,?,?,?)`
      )
      .run(
        u.id, 'other', on, on, code === '1029' ? 'Closing on my house.' : 'Moving apartments.',
        supervisor?.id ?? null, toSql(decided), 'Approved, from your balance.', 8,
        paid ? 8 * (u.pay_rate_cents || 0) : null, paid ? period.id : null, toSql(new Date(decided.getTime() - 86400000))
      );
    await add(u.id, 'used', -8, { request: Number(info.lastInsertRowid), by: supervisor?.id, at: decided });
    requests++;
  };
  await newDay('1012', closed, true);
  await newDay('1029', waiting, false);

  return { people: eligible.length, requests };
}
