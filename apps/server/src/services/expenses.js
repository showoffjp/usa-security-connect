/**
 * Expense claims: money an officer spent on the job, claimed back.
 *
 * A claim is a reimbursement, not wages: it is never part of the hours, the
 * overtime or the gross pay on a payroll line. It rides alongside them. An
 * approved claim waits for the next payroll close, which pays every approved
 * claim incurred on or before the period's last day and records the period
 * against it; reopening that period hands them back to waiting.
 */

import { db } from '../lib/db.js';
import { sqlToIso } from '../lib/http.js';
import { EXPENSE_CATEGORY_LABEL, EXPENSE_STATUS_LABEL } from '../shared.js';
import { dayString } from './payPeriods.js';

const dollars = (cents) => (cents == null ? null : cents / 100);

export const CLAIM_SELECT = `
  SELECT c.*, u.first_name || ' ' || u.last_name AS officer, u.employee_code,
         s.name AS site_name, d.first_name || ' ' || d.last_name AS decided_by_name,
         p.period_start, p.period_end
  FROM expense_claims c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN sites s ON s.id = c.site_id
  LEFT JOIN users d ON d.id = c.decided_by
  LEFT JOIN pay_periods p ON p.id = c.pay_period_id`;

export function presentClaim(c) {
  return {
    id: c.id,
    user_id: c.user_id,
    officer: c.officer,
    employee_code: c.employee_code,
    site_id: c.site_id,
    site_name: c.site_name || null,
    category: c.category,
    category_label: EXPENSE_CATEGORY_LABEL[c.category] || c.category,
    incurred_on: dayString(c.incurred_on),
    miles: c.miles == null ? null : Number(c.miles),
    amount_cents: c.amount_cents,
    amount: dollars(c.amount_cents),
    description: c.description,
    has_receipt: Boolean(c.receipt_filename),
    receipt_pdf: c.receipt_type === 'application/pdf',
    status: c.status,
    status_label: EXPENSE_STATUS_LABEL[c.status] || c.status,
    decided_by: c.decided_by_name || null,
    decided_at: sqlToIso(c.decided_at),
    decision_note: c.decision_note || null,
    pay_period_id: c.pay_period_id,
    paid_in: c.pay_period_id ? `${dayString(c.period_start)} to ${dayString(c.period_end)}` : null,
    created_at: sqlToIso(c.created_at),
  };
}

export async function loadClaim(id) {
  return db.prepare(`${CLAIM_SELECT} WHERE c.id = ?`).get(id);
}

/**
 * The claims a pay period pays: for a closed period, the ones it paid; for an
 * open one, the approved claims its close would pay, and how many incurred in
 * it are still waiting for a decision.
 */
export async function periodExpenses(period) {
  const end = dayString(period.period_end);
  const rows =
    period.status === 'closed'
      ? await db.prepare(`${CLAIM_SELECT} WHERE c.pay_period_id = ? ORDER BY u.last_name, c.incurred_on`).all(period.id)
      : await db
          .prepare(`${CLAIM_SELECT} WHERE c.status = 'approved' AND c.pay_period_id IS NULL AND c.incurred_on <= ? ORDER BY u.last_name, c.incurred_on`)
          .all(end);
  const pending =
    period.status === 'closed'
      ? 0
      : Number((await db.prepare(`SELECT COUNT(*) AS n FROM expense_claims WHERE status = 'pending' AND incurred_on <= ?`).get(end)).n);
  const byUser = new Map();
  for (const c of rows) byUser.set(c.user_id, (byUser.get(c.user_id) || 0) + c.amount_cents);
  const total = rows.reduce((n, c) => n + c.amount_cents, 0);
  return { claims: rows.map(presentClaim), byUser, total_cents: total, total: dollars(total), pending };
}

/** At close: every approved claim up to the period's last day is paid by it. */
export async function payClaims(period) {
  const r = await db
    .prepare(
      `UPDATE expense_claims SET status = 'paid', pay_period_id = ?
       WHERE status = 'approved' AND pay_period_id IS NULL AND incurred_on <= ?`
    )
    .run(period.id, dayString(period.period_end));
  return r.changes;
}

/** At reopen: what the period paid goes back to waiting for the next close. */
export async function unpayClaims(period) {
  const r = await db
    .prepare(`UPDATE expense_claims SET status = 'approved', pay_period_id = NULL WHERE pay_period_id = ?`)
    .run(period.id);
  return r.changes;
}
