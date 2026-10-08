/**
 * Demo late and no-show alerts:
 *
 *  - Vince Ortega, the administrator, has texts on for late arrivals,
 *    no-shows and what follows, to his confirmed number;
 *  - earlier today an officer never turned up, and the shift was given to
 *    another officer who got there within the hour (covered);
 *  - an officer due on in about half an hour has said they are running
 *    fifteen minutes late, and another has called off sick for a shift this
 *    evening, which is open with nobody on it yet;
 *  - every stage of the last twelve hours is recorded, and the texts Vince
 *    would have had are in the outbox, stamped when each happened. With no
 *    text provider on the demo they are marked 'skipped'.
 *
 * The officer late without a word and the one who never turned up right now
 * come from the expansion seed.
 */

import { toSql } from './services/compliance.js';
import { sweepAttendance, replayHistory } from './services/attendance.js';
import { fatigueFor } from './services/fatigue.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const SUITE_PEOPLE = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008'];
/** An officer (u) in no other demo story, and not on duty now. */
const IN_NO_STORY = `NOT EXISTS (SELECT 1 FROM conduct_records c WHERE c.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM post_qualifications q WHERE q.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM attendance_events a WHERE a.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM attendance_notices a WHERE a.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM shifts x JOIN posts xp ON xp.id = x.post_id
                  WHERE x.user_id = u.id AND (xp.armed OR xp.training_required)
                    AND x.starts_at > now() - interval '30 days')
  AND NOT EXISTS (SELECT 1 FROM shifts x WHERE x.user_id = u.id
                  AND (x.notes LIKE 'Late event cover%' OR x.notes LIKE 'Extra patrol%'))
  AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.user_id = u.id AND te.clock_out_at IS NULL)`;

export async function seedAttendance({ db, now = new Date() }) {
  const result = { subscribed: 0, covered: null, runningLate: null, calledOff: null, events: 0, texts: 0 };
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

  // A plain post with nobody on it from ninety minutes before to ninety after.
  const quietPost = (start, end) =>
    db
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
  const anyPlainPost = () =>
    db
      .prepare(
        `SELECT p.id FROM posts p JOIN sites s ON s.id = p.site_id
         WHERE p.active = true AND s.active = true AND p.armed = false AND p.training_required = false
         ORDER BY p.id LIMIT 1`
      )
      .get();
  // Officers with nothing within `slack` hours either side, nothing on their
  // record, in no other story and not on leave.
  const free = (exclude, start, end, slack = 9) =>
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
           AND NOT EXISTS (SELECT 1 FROM attendance_notices a WHERE a.user_id = u.id)
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
      .all(...SUITE_PEOPLE, exclude, toSql(new Date(end.getTime() + slack * HOUR)), toSql(new Date(start.getTime() - slack * HOUR)),
        toSql(end), toSql(start));
  // The first of them free within the hour either side that the shift leaves
  // rested: short rest and seventh days in a row are the rest and fatigue
  // story's to tell.
  const rested = async (exclude, start, end) => {
    for (const c of await free(exclude, start, end, 1)) {
      if (!(await fatigueFor(c.id, { startsAt: start, endsAt: end, now })).length) return c;
    }
    return null;
  };
  const admin = vince?.id ?? null;

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
    // Ended hours ago, so it does no harm if somebody else was on the post too.
    const post = (await quietPost(start, end)) || (await anyPlainPost());
    // The officer who never came did not work it, so only a clash matters.
    const missing = post && (await free(0, start, end, 1))[0];
    const cover = missing && (await rested(missing.id, start, end));
    if (cover) {
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

  /* ------------------------------------- running late, for a shift soon */
  // A shift already on the roster starting in the next four hours, at a plain
  // post, for an officer in no other story; or, failing that, one put on a
  // quiet post half an hour from now. They said eight minutes ago they would
  // be fifteen minutes late.
  {
    let shift = await db
      .prepare(
        `SELECT sh.id, sh.user_id, sh.starts_at, u.first_name || ' ' || u.last_name AS name
         FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN posts p ON p.id = sh.post_id
         WHERE sh.status = 'scheduled' AND p.armed = false AND p.training_required = false
           AND sh.starts_at BETWEEN ? AND ?
           AND u.role = 'officer' AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
           AND ${IN_NO_STORY}
         ORDER BY sh.starts_at, sh.id LIMIT 1`
      )
      .get(toSql(new Date(now.getTime() + 15 * MIN)), toSql(new Date(now.getTime() + 4 * HOUR)), ...SUITE_PEOPLE);
    if (!shift) {
      const start = new Date(Math.ceil((now.getTime() + 25 * MIN) / (5 * MIN)) * 5 * MIN);
      const end = new Date(start.getTime() + 8 * HOUR);
      const post = await quietPost(start, end);
      const who = post && (await rested(0, start, end));
      if (who) {
        const row = await db
          .prepare(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status, notes, created_by) VALUES (?,?,?,?,'scheduled',?,?) RETURNING id`)
          .get(who.id, post.id, toSql(start), toSql(end), 'Evening cover.', admin);
        shift = { id: row.id, user_id: who.id, starts_at: toSql(start), name: who.name };
      }
    }
    if (shift) {
      const said = new Date(now.getTime() - 8 * MIN);
      const eta = new Date(new Date(shift.starts_at).getTime() + 15 * MIN);
      const note = 'Stuck behind an accident on I-95. Fifteen minutes.';
      await db
        .prepare(`INSERT INTO attendance_notices (shift_id, user_id, kind, eta_at, note, created_at) VALUES (?,?, 'running_late', ?,?,?)`)
        .run(shift.id, shift.user_id, toSql(eta), note, toSql(said));
      await db
        .prepare(`INSERT INTO attendance_events (shift_id, user_id, stage, occurred_at, minutes_late, detail) VALUES (?,?, 'running_late', ?, 15, ?)`)
        .run(shift.id, shift.user_id, toSql(said), JSON.stringify({ eta_at: eta.toISOString(), note }));
      result.runningLate = shift.name;
    }
  }

  /* -------------------------------------- a call-off, a few hours from now */
  // A shift already on the roster, starting two to eleven hours from now at a
  // plain post, worked by an officer in no other story. They call off
  // sick; it is left with nobody on it.
  {
    const sh = await db
      .prepare(
        `SELECT sh.id, sh.user_id, u.first_name || ' ' || u.last_name AS name
         FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN posts p ON p.id = sh.post_id
         WHERE sh.status = 'scheduled' AND p.armed = false AND p.training_required = false
           AND sh.starts_at BETWEEN ? AND ?
           AND u.role = 'officer' AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
           AND ${IN_NO_STORY}
         ORDER BY sh.starts_at, sh.id LIMIT 1`
      )
      .get(toSql(new Date(now.getTime() + 2 * HOUR)), toSql(new Date(now.getTime() + 11 * HOUR)), ...SUITE_PEOPLE);
    if (sh) {
      const said = new Date(now.getTime() - 40 * MIN);
      const note = 'Fever since this morning. Sorry for the short notice.';
      await db.prepare(`UPDATE shifts SET user_id = NULL, is_open = true WHERE id = ?`).run(sh.id);
      await db
        .prepare(`INSERT INTO attendance_notices (shift_id, user_id, kind, reason, note, created_at) VALUES (?,?, 'call_off', 'sick', ?, ?)`)
        .run(sh.id, sh.user_id, note, toSql(said));
      await db
        .prepare(`INSERT INTO attendance_events (shift_id, user_id, stage, occurred_at, detail) VALUES (?,?, 'called_off', ?, ?)`)
        .run(sh.id, sh.user_id, toSql(said), JSON.stringify({ reason: 'sick', note }));
      result.calledOff = sh.name;
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
