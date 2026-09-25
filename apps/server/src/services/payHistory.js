/**
 * The record of what a person was paid and billed at, and from when.
 *
 * Whatever changed a rate - the employee form, the pay rates screen, a bulk
 * raise - calls this afterwards with the row as it now stands. It writes a
 * snapshot only when something that affects money actually moved, so saving a
 * phone number does not fill the history with duplicates.
 */

import { db } from '../lib/db.js';
import { toDateString } from '../lib/http.js';

const MONEY_FIELDS = [
  'employment_type',
  'pay_type',
  'pay_rate_cents',
  'salary_cents',
  'bill_rate_cents',
  'overtime_multiplier',
];

export async function recordPayHistory(userId, { changedBy = null, reason = null, effectiveOn = null } = {}) {
  const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!user) return null;

  const last = await db
    .prepare(`SELECT * FROM pay_rate_history WHERE user_id = ? ORDER BY effective_on DESC, id DESC LIMIT 1`)
    .get(userId);

  const same =
    last &&
    MONEY_FIELDS.every((f) => {
      const a = last[f] ?? null;
      const b = user[f] ?? null;
      return a === b || (a != null && b != null && Number(a) === Number(b));
    });
  if (same) return null;

  const info = await db
    .prepare(
      `INSERT INTO pay_rate_history
       (user_id, effective_on, employment_type, pay_type, pay_rate_cents, salary_cents,
        bill_rate_cents, overtime_multiplier, reason, changed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      userId,
      effectiveOn || toDateString(new Date()),
      user.employment_type,
      user.pay_type,
      user.pay_rate_cents,
      user.salary_cents,
      user.bill_rate_cents,
      user.overtime_multiplier,
      // With no earlier row there is nothing to say what changed, only what is.
      last ? reason : reason || 'Rate on record',
      changedBy
    );
  return Number(info.lastInsertRowid);
}
