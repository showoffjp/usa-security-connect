/**
 * Demo shift confirmations. Most officers have confirmed the week ahead from
 * the app, a few by phone with their supervisor; a handful have not:
 *
 *   - two shifts inside the next 12 hours, so the dashboard and the alerts
 *     have someone to chase (reminded already, as the sweep would have);
 *   - Marcus Bell's next shift, so the demo officer has one to confirm;
 *   - roughly one in seven later in the week, not yet due a reminder.
 */

import { toSql } from './services/compliance.js';
import { confirmKey } from './services/confirmations.js';
import { CONFIRM_AHEAD_DAYS, CONFIRM_ALERT_HOURS, CONFIRM_REMIND_HOURS } from './shared.js';

const HOUR = 3600000;

export async function seedConfirmations({ db }) {
  const now = Date.now();
  const shifts = await db
    .prepare(
      `SELECT sh.*, u.employee_code FROM shifts sh JOIN users u ON u.id = sh.user_id
       WHERE sh.status = 'scheduled' AND sh.starts_at > ? AND sh.starts_at <= ?
         AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.shift_id = sh.id)
       ORDER BY sh.starts_at`
    )
    .all(toSql(new Date(now)), toSql(new Date(now + CONFIRM_AHEAD_DAYS * 24 * HOUR)));
  const sup = await db.prepare(`SELECT id FROM users WHERE employee_code = '1002'`).get();
  const startsIn = (s) => new Date(s.starts_at).getTime() - now;

  const leave = new Set();
  const marcusNext = shifts.find((s) => s.employee_code === '1003');
  if (marcusNext) leave.add(marcusNext.id);
  // Two soon ones, not Marcus's, so the dashboard has something to chase.
  for (const s of shifts.filter((x) => startsIn(x) <= CONFIRM_ALERT_HOURS * HOUR && x.employee_code !== '1003').slice(1, 3)) {
    leave.add(s.id);
  }
  for (const s of shifts) if (startsIn(s) > 2 * 24 * HOUR && s.id % 7 === 0) leave.add(s.id);

  let confirmed = 0;
  let phone = 0;
  for (const s of shifts) {
    const key = confirmKey(s);
    if (leave.has(s.id)) {
      if (startsIn(s) <= CONFIRM_REMIND_HOURS * HOUR) {
        await db.prepare(`UPDATE shifts SET reminded_key = ? WHERE id = ?`).run(key, s.id);
      }
      continue;
    }
    // Confirmed between a few hours and a couple of days ago; one in eight by phone.
    const byPhone = sup && s.id % 8 === 3;
    const at = new Date(now - (2 + (s.id % 46)) * HOUR);
    await db
      .prepare(
        `UPDATE shifts SET confirmed_at = ?, confirmed_by = ?, confirm_method = ?, confirm_note = ?, confirmed_key = ?, reminded_key = ?
         WHERE id = ?`
      )
      .run(
        toSql(at),
        byPhone ? sup.id : s.user_id,
        byPhone ? 'phone' : 'app',
        byPhone ? 'Called after the reminder; on their way in as planned.' : null,
        key,
        startsIn(s) <= CONFIRM_REMIND_HOURS * HOUR ? key : null,
        s.id
      );
    confirmed += 1;
    if (byPhone) phone += 1;
  }
  return { confirmed, phone, waiting: leave.size };
}
