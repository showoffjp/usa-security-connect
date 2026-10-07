/**
 * Demo handovers, on top of whoever is on duty when the seed runs:
 *
 *  - one officer's shift ended 25 minutes ago and the officer who confirmed
 *    they would relieve them has not turned up, so they are held over;
 *  - another's ended ten minutes ago and the officer who was to relieve them
 *    called out, leaving the rest of the shift with nobody on it.
 *
 * The relief shift in each covers what was left of the outgoing officer's
 * shift, so nothing at the post overlaps. Both relief shifts have already
 * started, which keeps the uncovered one out of the open-shifts list the API
 * suites claim from. Seeded in the first hours of a payroll week nobody has
 * been on long enough, and the board just shows the ordinary handovers.
 */

import { toSql } from './services/compliance.js';
import { confirmKey } from './services/confirmations.js';

const MIN = 60000;
const SUITE_PEOPLE = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008'];

export async function seedHandovers({ db, now = new Date() }) {
  const result = { late: 0, uncovered: 0 };
  // On duty for two hours or more at an unarmed post, and alone there. The
  // live board's own set pieces (off post, on a break, gone quiet) are left
  // be: anyone flagged this shift for more than a late start, on a break, or
  // with a missed check-in.
  const onDuty = await db
    .prepare(
      `SELECT te.id AS entry_id, te.user_id, te.clock_in_at, sh.id AS shift_id, sh.post_id, sh.starts_at, sh.ends_at,
              u.employee_code, p.training_required,
              (SELECT COUNT(*) FROM time_entries o WHERE o.post_id = sh.post_id AND o.clock_out_at IS NULL) AS at_post
       FROM time_entries te
       JOIN shifts sh ON sh.id = te.shift_id
       JOIN users u ON u.id = te.user_id
       JOIN posts p ON p.id = sh.post_id
       WHERE te.clock_out_at IS NULL AND sh.status = 'in_progress' AND p.armed = false AND sh.ends_at > ?
         AND te.clock_in_at <= ?
         AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM flags f WHERE f.user_id = te.user_id AND f.occurred_at >= te.clock_in_at AND f.type <> 'late_clock_in')
         AND NOT EXISTS (SELECT 1 FROM breaks b WHERE b.time_entry_id = te.id AND b.ended_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM status_checks c WHERE c.time_entry_id = te.id AND c.status = 'missed')
       ORDER BY sh.ends_at DESC, sh.id`
    )
    .all(toSql(now), toSql(new Date(now.getTime() - 120 * MIN)), ...SUITE_PEOPLE);
  const candidates = onDuty.filter((r) => Number(r.at_post) === 1);
  if (!candidates.length) return result;

  const usedPosts = new Set();
  // The late relief needs no site training to stand in, and an hour and a half
  // or more of the shift to work, so nobody due after them arrives first; an
  // uncovered post can be any with half an hour left.
  const pick = (late) => {
    const r = candidates.find((c) => !usedPosts.has(c.post_id)
      && (late ? !c.training_required : true)
      && new Date(c.ends_at) - now >= (late ? 90 : 30) * MIN);
    if (r) usedPosts.add(r.post_id);
    return r;
  };

  // A reliever with nothing on at the time, nothing on their record and no leave.
  const relieverFor = (from, to) =>
    db
      .prepare(
        `SELECT u.id FROM users u
         WHERE u.status = 'active' AND u.role = 'officer' AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.user_id = u.id AND s.status <> 'cancelled'
                           AND s.starts_at < ?::timestamptz + interval '8 hours' AND s.ends_at > ?::timestamptz - interval '8 hours')
           AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.user_id = u.id AND te.clock_out_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM conduct_records c WHERE c.user_id = u.id)
           -- Nor anyone in the site-training story.
           AND NOT EXISTS (SELECT 1 FROM post_qualifications q WHERE q.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM shifts s JOIN posts p ON p.id = s.post_id
                           WHERE s.user_id = u.id AND p.training_required = true AND s.starts_at > ?::timestamptz - interval '30 days')
           AND NOT EXISTS (SELECT 1 FROM time_off_requests t WHERE t.user_id = u.id AND t.status <> 'denied'
                           AND t.starts_on <= ?::date AND t.ends_on >= ?::date)
         ORDER BY u.employee_code DESC LIMIT 1`
      )
      .get(...SUITE_PEOPLE, toSql(to), toSql(from), toSql(from), toSql(to), toSql(from));

  const admin = (await db.prepare(`SELECT id FROM users WHERE employee_code = '1001'`).get())?.id ?? null;
  const insertShift = db.prepare(
    `INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status, notes, is_open, created_by, confirmed_at, confirm_method)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );

  // Held over: the relief confirmed yesterday evening and has not come.
  const late = pick(true);
  if (late) {
    const end = new Date(now.getTime() - 25 * MIN);
    const originalEnd = new Date(late.ends_at);
    const relief = await relieverFor(end, originalEnd);
    if (relief) {
      await db.prepare(`UPDATE shifts SET ends_at = ? WHERE id = ?`).run(toSql(end), late.shift_id);
      const confirmed = new Date(now.getTime() - 15 * 60 * MIN);
      const id = Number((await insertShift.run(relief.id, late.post_id, toSql(end), toSql(originalEnd), 'scheduled',
        'Second half of a split shift.', false, admin, toSql(confirmed), 'app')).lastInsertRowid);
      const row = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(id);
      await db.prepare(`UPDATE shifts SET confirmed_by = user_id, confirmed_key = ? WHERE id = ?`).run(confirmKey(row), id);
      result.late = 1;
    }
  }

  // Uncovered: the officer due on called out this morning; nobody has been found.
  const uncovered = pick();
  if (uncovered) {
    const end = new Date(now.getTime() - 10 * MIN);
    await db.prepare(`UPDATE shifts SET ends_at = ? WHERE id = ?`).run(toSql(end), uncovered.shift_id);
    await insertShift.run(null, uncovered.post_id, toSql(end), toSql(new Date(uncovered.ends_at)), 'scheduled',
      'Second half of a split shift. The officer booked on it called out sick.', true, admin, null, null);
    result.uncovered = 1;
  }
  return result;
}
