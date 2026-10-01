/**
 * Demo time corrections, all on this week's shifts so none of them lands in
 * a pay period the payroll demo closes: Marcus Bell asking for a clock-out he
 * tapped late, another officer whose forgotten clock-out the system closed,
 * one already approved and one declined.
 */

import { toSql } from './services/compliance.js';
import { minutesBetween } from './shared.js';

const MIN = 60000;
// Asked after the shift, decided after that, and never later than now.
const notAfter = (d, minutesAgo) => new Date(Math.min(d.getTime(), Date.now() - minutesAgo * MIN));

export async function seedCorrections({ db }) {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const ts = (v) => (v instanceof Date ? v : new Date(v));

  const entries = (await db
    .prepare(
      `SELECT te.id, te.user_id, te.clock_in_at, te.clock_out_at, te.auto_closed, u.employee_code
       FROM time_entries te JOIN users u ON u.id = te.user_id
       WHERE te.clock_in_at >= ? AND te.clock_out_at IS NOT NULL AND te.clock_out_at < ?
       ORDER BY te.clock_in_at DESC`
    )
    .all(toSql(monday), toSql(new Date(Date.now() - 2 * 3600000))))
    .map((e) => ({ ...e, in: ts(e.clock_in_at), out: ts(e.clock_out_at) }));
  const admin = await db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();

  const insert = db.prepare(
    `INSERT INTO time_corrections (time_entry_id, user_id, proposed_clock_in_at, proposed_clock_out_at, recorded_clock_in_at,
       recorded_clock_out_at, reason, status, decided_by, decided_at, decision_note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const used = new Set();
  const take = (pred) => {
    const e = entries.find((x) => !used.has(x.user_id) && pred(x));
    if (e) used.add(e.user_id);
    return e;
  };
  let n = 0;

  // Marcus: stayed for the handover and tapped out late from the car park.
  const marcus = take((e) => e.employee_code === '1003');
  if (marcus) {
    await insert.run(marcus.id, marcus.user_id, null, toSql(new Date(marcus.out.getTime() - 14 * MIN)), toSql(marcus.in), toSql(marcus.out),
      'My relief arrived on time and I handed over at the desk, but I only tapped clock-out once I reached my car.',
      'pending', null, null, null, toSql(notAfter(new Date(marcus.out.getTime() + 40 * MIN), 30)));
    n += 1;
  }

  // Somebody whose clock-out the system had to guess.
  const auto = take((e) => e.auto_closed);
  if (auto) {
    await insert.run(auto.id, auto.user_id, null, toSql(new Date(auto.out.getTime() - 25 * MIN)), toSql(auto.in), toSql(auto.out),
      'Phone battery died at the end of the shift so the clock-out never went through. I left at the handover.',
      'pending', null, null, null, toSql(notAfter(new Date(auto.out.getTime() + 3 * 3600000), 30)));
    n += 1;
  }

  // Approved: a clock-in the app lost, applied to the entry the way the office would.
  const approved = take((e) => !e.auto_closed);
  if (approved && admin) {
    const fixedIn = new Date(approved.in.getTime() - 9 * MIN);
    await db
      .prepare(
        `UPDATE time_entries SET clock_in_at = ?, minutes_worked = ?, original_clock_in_at = COALESCE(original_clock_in_at, clock_in_at),
           original_clock_out_at = COALESCE(original_clock_out_at, clock_out_at), adjusted_by = ?, adjustment_reason = ?
         WHERE id = ?`
      )
      .run(toSql(fixedIn), minutesBetween(fixedIn.toISOString(), approved.out.toISOString()), admin.id,
        'Officer\'s correction request: the app froze on the clock-in screen; I was at the post at the start time.', approved.id);
    await insert.run(approved.id, approved.user_id, toSql(fixedIn), null, toSql(approved.in), toSql(approved.out),
      'The app froze on the clock-in screen; I was at the post at the start time.',
      'approved', admin.id, toSql(notAfter(new Date(approved.out.getTime() + 5 * 3600000), 5)), 'Matches the visitor log entry at the start of the shift.',
      toSql(notAfter(new Date(approved.out.getTime() + 60 * MIN), 20)));
    n += 1;
  }

  // Declined, with the reason the officer reads.
  const declined = take((e) => !e.auto_closed);
  if (declined && admin) {
    await insert.run(declined.id, declined.user_id, null, toSql(new Date(declined.out.getTime() + 45 * MIN)), toSql(declined.in), toSql(declined.out),
      'I stayed on after the shift to finish the incident report for the night manager.',
      'declined', admin.id, toSql(notAfter(new Date(declined.out.getTime() + 6 * 3600000), 5)),
      'Overtime has to be agreed with a supervisor first. Ask Renata to approve it and we will add it.',
      toSql(notAfter(new Date(declined.out.getTime() + 90 * MIN), 20)));
    n += 1;
  }

  return { corrections: n };
}
