/**
 * Demo handovers, on top of whoever is on duty when the seed runs:
 *
 *  - one officer's shift ended 25 minutes ago and the officer who confirmed
 *    they would relieve them has not turned up, so they are held over;
 *  - another's ended ten minutes ago and the officer who was to relieve them
 *    called out, leaving the rest of the shift with nobody on it.
 *
 * Each is made from an officer already on duty where one fits: the relief
 * shift covers what was left of their shift, so nothing at the post overlaps.
 * Where nobody on the roster fits (at some hours nobody has been on long
 * enough), an extra officer is put on a quiet post for the morning instead,
 * clocked in with a trail of GPS points like everyone else, so the demo shows
 * both at any hour. Both relief shifts have already started, which keeps the
 * uncovered one out of the open-shifts list the API suites claim from. Only
 * in the first hour of a payroll week, when no shift may start before it,
 * is there no room for either.
 */

import { toSql } from './services/compliance.js';
import { confirmKey } from './services/confirmations.js';

const MIN = 60000;
const SUITE_PEOPLE = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008'];

const HOUR = 60 * MIN;

/**
 * `roster: false` skips the officers already on duty and always uses a
 * stand-in, so the rules test can reach that path whatever the hour.
 */
export async function seedHandovers({ db, now = new Date(), roster = true }) {
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
  const candidates = roster ? onDuty.filter((r) => Number(r.at_post) === 1) : [];

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
  const relieverFor = (from, to, exclude = 0) =>
    db
      .prepare(
        `SELECT u.id FROM users u
         WHERE u.status = 'active' AND u.role = 'officer' AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
           AND u.id <> ? AND u.must_change_pin = false
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
      .get(...SUITE_PEOPLE, exclude, toSql(to), toSql(from), toSql(from), toSql(to), toSql(from));

  const admin = (await db.prepare(`SELECT id FROM users WHERE employee_code = '1001'`).get())?.id ?? null;
  const insertShift = db.prepare(
    `INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status, notes, is_open, created_by, confirmed_at, confirm_method)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );

  // A quiet post for a stand-in: unarmed, no site training needed, with a
  // position for the GPS trail, nobody on it now, and no shift there within an
  // hour and a half either side of the handover. With it, when the shifts
  // around that gap end and start.
  const quietPost = (end) =>
    db
      .prepare(
        `SELECT p.*,
                (SELECT MAX(sh.ends_at) FROM shifts sh WHERE sh.post_id = p.id AND sh.status <> 'cancelled' AND sh.ends_at <= ?) AS prev_end,
                (SELECT MIN(sh.starts_at) FROM shifts sh WHERE sh.post_id = p.id AND sh.status <> 'cancelled' AND sh.starts_at >= ?) AS next_start
         FROM posts p JOIN sites s ON s.id = p.site_id
         WHERE p.active = true AND s.active = true AND p.armed = false AND p.training_required = false
           AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
           ${usedPosts.size ? `AND p.id NOT IN (${[...usedPosts].join(',')})` : ''}
           AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.post_id = p.id AND te.clock_out_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM shifts sh WHERE sh.post_id = p.id AND sh.status <> 'cancelled'
                           AND sh.starts_at < ?::timestamptz + interval '90 minutes' AND sh.ends_at > ?::timestamptz - interval '90 minutes')
         ORDER BY p.id LIMIT 1`
      )
      .get(toSql(end), toSql(end), toSql(end), toSql(end));

  // Nobody's shift starts before ten past midnight on the Monday of this
  // payroll week, so a running shift never holds last week open (as in the
  // expansion seed).
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const earliest = new Date(weekStart.getTime() + 10 * MIN);

  const insertEntry = db.prepare(
    `INSERT INTO time_entries (user_id, shift_id, post_id, clock_in_at, clock_in_lat, clock_in_lng, clock_in_accuracy,
       clock_in_geofence, clock_in_distance_m, method, device_id, late_minutes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertPing = db.prepare(
    `INSERT INTO location_pings (user_id, time_entry_id, post_id, recorded_at, latitude, longitude, accuracy, source, geofence, distance_m)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );

  /**
   * Put an officer on post until `end`: one already on duty, their shift cut
   * short, or a stand-in on a quiet post. Returns the post and how long the
   * shift after it runs, or null when there is no room.
   */
  async function onPostUntil(end, { late, excludeUser = 0 }) {
    const c = pick(late);
    if (c) {
      return {
        postId: c.post_id,
        until: new Date(c.ends_at),
        apply: async () => db.prepare(`UPDATE shifts SET ends_at = ? WHERE id = ?`).run(toSql(end), c.shift_id),
      };
    }
    const post = await quietPost(end);
    if (!post) return null;
    // On for up to six hours before the handover and relieved for up to four
    // after it, fitted between the shifts either side at the post.
    const start = new Date(Math.max(earliest.getTime(), end.getTime() - 6 * HOUR, post.prev_end ? new Date(post.prev_end).getTime() : 0));
    const until = new Date(Math.min(end.getTime() + 4 * HOUR, post.next_start ? new Date(post.next_start).getTime() : Infinity));
    if (end - start < HOUR) return null;
    const officer = await relieverFor(start, until, excludeUser);
    if (!officer) return null;
    usedPosts.add(post.id);
    return {
      postId: post.id,
      until,
      officerId: officer.id,
      apply: async () => {
        const shiftId = Number((await insertShift.run(officer.id, post.id, toSql(start), toSql(end), 'in_progress',
          'Extra cover for the morning.', false, admin, null, null)).lastInsertRowid);
        const clockIn = new Date(start.getTime() - 4 * MIN);
        const entryId = Number((await insertEntry.run(officer.id, shiftId, post.id, toSql(clockIn), post.latitude, post.longitude, 6,
          'inside', 4, 'gps', `demo-device-standin-${officer.id}`, 0)).lastInsertRowid);
        // A position about every five minutes since clock-in, a few metres off the post.
        for (let t = clockIn.getTime(), i = 0; t < now.getTime() - MIN; t += 5 * MIN, i++) {
          const jitter = ((i * 37) % 9 - 4) * 0.00002;
          await insertPing.run(officer.id, entryId, post.id, toSql(new Date(t)), post.latitude + jitter, post.longitude - jitter, 5,
            i === 0 ? 'clock_in' : 'watch', 'inside', 3 + (i % 5));
        }
      },
    };
  }

  // Held over: the relief confirmed yesterday evening and has not come.
  {
    const end = new Date(now.getTime() - 25 * MIN);
    const plan = await onPostUntil(end, { late: true });
    const relief = plan && (await relieverFor(end, plan.until, plan.officerId || 0));
    if (relief) {
      await plan.apply();
      const confirmed = new Date(now.getTime() - 15 * HOUR);
      const id = Number((await insertShift.run(relief.id, plan.postId, toSql(end), toSql(plan.until), 'scheduled',
        'Second half of a split shift.', false, admin, toSql(confirmed), 'app')).lastInsertRowid);
      const row = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(id);
      await db.prepare(`UPDATE shifts SET confirmed_by = user_id, confirmed_key = ? WHERE id = ?`).run(confirmKey(row), id);
      result.late = 1;
    }
  }

  // Uncovered: the officer due on called out this morning; nobody has been found.
  {
    const end = new Date(now.getTime() - 10 * MIN);
    const plan = await onPostUntil(end, { late: false });
    if (plan) {
      await plan.apply();
      await insertShift.run(null, plan.postId, toSql(end), toSql(plan.until), 'scheduled',
        'Second half of a split shift. The officer booked on it called out sick.', true, admin, null, null);
      result.uncovered = 1;
    }
  }
  return result;
}
