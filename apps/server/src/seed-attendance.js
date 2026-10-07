/**
 * Demo late and no-show alerts:
 *
 *  - Vince Ortega, the administrator, has texts on for late arrivals,
 *    no-shows and what follows, to his confirmed number;
 *  - earlier today an officer never turned up, and the shift was given to
 *    another officer who got there within the hour (covered);
 *  - every stage of the last twelve hours is recorded, and the texts Vince
 *    would have had are in the outbox, stamped when each happened. With no
 *    text provider on the demo they are marked 'skipped'.
 *
 * The officer running late and the one who never turned up right now come
 * from the expansion seed.
 */

import { toSql } from './services/compliance.js';
import { sweepAttendance, replayHistory } from './services/attendance.js';
import { fatigueFor } from './services/fatigue.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const SUITE_PEOPLE = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008'];

export async function seedAttendance({ db, now = new Date() }) {
  const result = { subscribed: 0, covered: null, events: 0, texts: 0 };
  const vince = await db.prepare(`SELECT id FROM users WHERE employee_code = '1001'`).get();
  if (vince) {
    await db
      .prepare(
        `INSERT INTO alert_subscriptions (user_id, sms_enabled, push_enabled, on_late, on_no_show, on_update, sms_phone, sms_verified_at)
         VALUES (?, true, true, true, true, true, '+19045550100', ?)
         ON CONFLICT (user_id) DO NOTHING`
      )
      .run(vince.id, toSql(new Date(now.getTime() - 9 * 24 * HOUR)));
    result.subscribed += 1;
  }

  /* --------------------------------------- a no-show, covered this morning */
  // An eight-hour shift that ended two hours ago. Kept inside this payroll
  // week, like every other seeded shift.
  const start = new Date(now.getTime() - 10 * HOUR);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 8 * HOUR);
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  if (start.getTime() >= weekStart.getTime() + 10 * MIN) {
    const post = await db
      .prepare(
        `SELECT p.id FROM posts p JOIN sites s ON s.id = p.site_id
         WHERE p.active = true AND s.active = true AND p.armed = false AND p.training_required = false
           AND NOT EXISTS (SELECT 1 FROM shifts sh WHERE sh.post_id = p.id AND sh.status <> 'cancelled'
                           AND sh.starts_at < ? AND sh.ends_at > ?)
           AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.post_id = p.id
                           AND te.clock_in_at < ? AND COALESCE(te.clock_out_at, now()) > ?)
         ORDER BY p.id LIMIT 1`
      )
      .get(toSql(new Date(end.getTime() + 90 * MIN)), toSql(new Date(start.getTime() - 90 * MIN)),
        toSql(new Date(end.getTime() + 90 * MIN)), toSql(new Date(start.getTime() - 90 * MIN)));
    // Two officers with nothing within nine hours either side, nothing on their
    // record, in no other story and not on leave.
    const free = (exclude) =>
      db
        .prepare(
          `SELECT u.id, u.first_name || ' ' || u.last_name AS name FROM users u
           WHERE u.status = 'active' AND u.role = 'officer' AND u.must_change_pin = false
             AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')}) AND u.id <> ?
             AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.user_id = u.id AND s.status <> 'cancelled'
                             AND s.starts_at < ? AND s.ends_at > ?)
             AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.user_id = u.id AND te.clock_out_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM conduct_records c WHERE c.user_id = u.id)
             AND NOT EXISTS (SELECT 1 FROM post_qualifications q WHERE q.user_id = u.id)
             AND NOT EXISTS (SELECT 1 FROM attendance_events a WHERE a.user_id = u.id)
             -- Nor anyone in the training or rest and fatigue stories.
             AND NOT EXISTS (SELECT 1 FROM shifts x JOIN posts xp ON xp.id = x.post_id
                             WHERE x.user_id = u.id AND (xp.armed OR xp.training_required)
                               AND x.starts_at > now() - interval '30 days')
             AND NOT EXISTS (SELECT 1 FROM shifts x WHERE x.user_id = u.id
                             AND (x.notes LIKE 'Late event cover%' OR x.notes LIKE 'Extra patrol%'))
             AND NOT EXISTS (SELECT 1 FROM time_off_requests t WHERE t.user_id = u.id AND t.status <> 'denied'
                             AND t.starts_on <= ?::date AND t.ends_on >= ?::date)
           ORDER BY u.employee_code DESC LIMIT 40`
        )
        .all(...SUITE_PEOPLE, exclude, toSql(new Date(end.getTime() + 9 * HOUR)), toSql(new Date(start.getTime() - 9 * HOUR)),
          toSql(end), toSql(start));
    const missing = post && (await free(0))[0];
    // The cover's extra shift must not leave them short of rest or on a
    // seventh day in a row: that is the rest and fatigue story's to tell.
    let cover = null;
    for (const c of missing ? await free(missing.id) : []) {
      if (!(await fatigueFor(c.id, { startsAt: start, endsAt: end, now })).length) { cover = c; break; }
    }
    if (cover) {
      const admin = vince?.id ?? null;
      const shift = await db
        .prepare(
          `INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status, notes, created_by)
           VALUES (?,?,?,?,'completed',?,?) RETURNING id`
        )
        .get(cover.id, post.id, toSql(start), toSql(end),
          `Covered for ${missing.name}, who did not show. Called in by the duty supervisor.`, admin);
      const inAt = new Date(start.getTime() + 55 * MIN);
      await db
        .prepare(
          `INSERT INTO time_entries (user_id, shift_id, post_id, clock_in_at, clock_out_at, clock_in_geofence, clock_out_geofence,
                                     method, minutes_worked, late_minutes)
           VALUES (?,?,?,?,?,'inside','inside','gps',?,0)`
        )
        .run(cover.id, shift.id, post.id, toSql(inAt), toSql(end), Math.round((end - inAt) / MIN));
      const event = db.prepare(
        `INSERT INTO attendance_events (shift_id, user_id, stage, occurred_at, minutes_late, detail) VALUES (?,?,?,?,?,?)`
      );
      await event.run(shift.id, missing.id, 'late', toSql(new Date(start.getTime() + 7 * MIN)), 7, null);
      await event.run(shift.id, missing.id, 'no_show', toSql(new Date(start.getTime() + 30 * MIN)), 30, null);
      await event.run(shift.id, missing.id, 'covered', toSql(new Date(start.getTime() + 38 * MIN)), null,
        JSON.stringify({ by_user_id: cover.id, by: cover.name, was: missing.name }));
      result.covered = `${cover.name} for ${missing.name}`;
    }
  }

  /* ------------------------------------------- the rest of the last twelve hours */
  // The demo seed's compliance sweep ran before anyone had asked for alerts,
  // so what it recorded went to nobody. Send it now, as it would have gone.
  await db.prepare(`UPDATE attendance_events SET notified = false WHERE notified = true`).run();
  const swept = await sweepAttendance(now);
  result.events = Number((await db.prepare(`SELECT COUNT(*) AS n FROM attendance_events`).get()).n);
  result.texts = swept.sent + (await replayHistory({ since: new Date(now.getTime() - 12 * HOUR) }));
  return result;
}
