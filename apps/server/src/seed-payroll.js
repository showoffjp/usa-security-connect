/**
 * Demo payroll: weekly pay periods at every stage.
 *
 *  - The week before last is closed: every officer approved, figures frozen.
 *  - Last week has ended and is waiting to be closed: most officers approved,
 *    some not yet, and one whose punch was corrected after approval, so the
 *    "changed since approved" state is there to see.
 *
 * Built through the same service the API uses, so the approvals carry real
 * fingerprints and the closed figures are exactly what the review computed.
 */

import { toDateString, parseDay } from './lib/http.js';
import { toSql } from './services/compliance.js';
import { reviewPeriod, writeLine, totalsOf } from './services/payPeriods.js';
import { minutesBetween } from './shared.js';

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const atHour = (d, h, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);

export async function seedPayroll({ db, users }) {
  const today = parseDay();
  const monday = addDays(today, -((today.getDay() + 6) % 7));

  async function open(start) {
    const info = await db
      .prepare(`INSERT INTO pay_periods (period_start, period_end, created_by, created_at) VALUES (?,?,?,?)`)
      .run(toDateString(start), toDateString(addDays(start, 6)), users.admin, toSql(atHour(start, 8)));
    return db.prepare(`SELECT * FROM pay_periods WHERE id = ?`).get(Number(info.lastInsertRowid));
  }

  async function approve(period, lines, when) {
    for (const line of lines) await writeLine(period.id, line, users.admin);
    await db
      .prepare(`UPDATE pay_period_lines SET approved_at = ? WHERE pay_period_id = ?`)
      .run(toSql(when), period.id);
  }

  /* ---- the week before last: closed ---- */
  const closedStart = addDays(monday, -14);
  const closed = await open(closedStart);
  const closedLines = await reviewPeriod(closed);
  const ready = closedLines.filter((l) => !l.blocked);
  await approve(closed, ready, atHour(addDays(closedStart, 7), 9, 20));
  const closedNote = [];
  if (ready.length === closedLines.length) {
    const t = totalsOf(ready.map((l) => ({ ...l, approval: { state: 'approved' } })));
    await db
      .prepare(
        `UPDATE pay_periods SET status = 'closed', closed_at = ?, closed_by = ?, people = ?, total_minutes = ?,
           overtime_minutes = ?, gross_cents = ?, w2_cents = ?, contractor_cents = ?
         WHERE id = ?`
      )
      .run(
        toSql(atHour(addDays(closedStart, 7), 10, 5)),
        users.admin,
        t.people,
        t.minutes,
        t.overtime_minutes,
        t.gross_cents,
        t.w2.cents,
        t.contractor.cents,
        closed.id
      );
    closedNote.push(`closed, ${t.people} officers, $${(t.gross_cents / 100).toFixed(2)}`);
  } else {
    closedNote.push(`left open: ${closedLines.length - ready.length} officer(s) cannot be paid yet`);
  }

  /* ---- last week: ended, most approved, waiting to close ---- */
  const dueStart = addDays(monday, -7);
  const due = await open(dueStart);
  const dueLines = await reviewPeriod(due);
  const approvable = dueLines.filter((l) => !l.blocked);
  // Roughly two in three approved; the rest left for the demo to finish.
  const approved = approvable.filter((l, i) => i % 3 !== 2);
  await approve(due, approved, atHour(today, 8, 40));

  // One approved officer then has a punch corrected, so their approval is stale.
  let stale = null;
  for (const line of approved) {
    const entry = await db
      .prepare(
        `SELECT * FROM time_entries WHERE user_id = ? AND clock_out_at IS NOT NULL
           AND clock_in_at >= ? AND clock_in_at < ? ORDER BY clock_in_at DESC LIMIT 1`
      )
      .get(line.user_id, toSql(dueStart), toSql(addDays(dueStart, 7)));
    if (!entry) continue;
    const clockOut = new Date(new Date(entry.clock_out_at).getTime() + 15 * 60000);
    const clockIn = new Date(entry.clock_in_at);
    await db
      .prepare(
        `UPDATE time_entries SET clock_out_at = ?, minutes_worked = ?,
           original_clock_out_at = COALESCE(original_clock_out_at, clock_out_at),
           original_clock_in_at = COALESCE(original_clock_in_at, clock_in_at),
           adjusted_by = ?, adjustment_reason = ?
         WHERE id = ?`
      )
      .run(
        toSql(clockOut),
        minutesBetween(clockIn.toISOString(), clockOut.toISOString()),
        users.admin,
        'Stayed 15 minutes for relief officer - confirmed by site manager.',
        entry.id
      );
    stale = line.officer;
    break;
  }

  return {
    closed: `${toDateString(closedStart)} to ${toDateString(addDays(closedStart, 6))}: ${closedNote.join('')}`,
    due: `${toDateString(dueStart)} to ${toDateString(addDays(dueStart, 6))}: ${approved.length} of ${dueLines.length} approved${stale ? `, ${stale} changed since approval` : ''}`,
  };
}
