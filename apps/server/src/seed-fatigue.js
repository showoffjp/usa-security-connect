/**
 * Demo rest and fatigue, on top of the roster:
 *
 *  - one officer was put on a late event the evening before their next
 *    shift, which leaves them six hours off before it;
 *  - another has picked up extra patrols on their days off, so the week
 *    ahead has them working seven days in a row.
 *
 * Both are a day or more ahead, so the board shows them whatever the hour the
 * seed runs, and both are officers the API suites do not sign in as.
 */

import { toSql } from './services/compliance.js';
import { toDateString, sqlToIso } from './lib/http.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const SUITE_PEOPLE = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008'];

export async function seedFatigue({ db, now = new Date() }) {
  const result = { shortRest: null, sevenDays: null };
  const admin = (await db.prepare(`SELECT id FROM users WHERE employee_code = '1001'`).get())?.id ?? null;
  const insertShift = db.prepare(
    `INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status, notes, created_by) VALUES (?,?,?,?,'scheduled',?,?)`
  );
  // One story per officer: nobody the API suites sign in as, nobody with a
  // coaching record or withdrawn training, and nobody who works an armed post
  // or one that needs site training (the training story lives there).
  const notSuite = `u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
    AND NOT EXISTS (SELECT 1 FROM conduct_records c WHERE c.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM post_qualifications q WHERE q.user_id = u.id AND q.status = 'revoked')
    AND NOT EXISTS (SELECT 1 FROM shifts x JOIN posts xp ON xp.id = x.post_id
                    WHERE x.user_id = u.id AND (xp.armed OR xp.training_required)
                      AND x.starts_at > now() - interval '30 days')`;
  // Nothing on the officer's roster, and nobody on the post, over [from, to).
  const free = async (userId, postId, from, to) =>
    !(await db
      .prepare(
        `SELECT 1 FROM shifts WHERE status <> 'cancelled' AND (user_id = ? OR post_id = ?)
           AND starts_at < ? AND ends_at > ? LIMIT 1`
      )
      .get(userId, postId, toSql(to), toSql(from)));
  // A post that needs no licence or training beyond the basics.
  const plainPosts = await db
    .prepare(`SELECT p.id, p.name FROM posts p JOIN sites s ON s.id = p.site_id
              WHERE p.active = true AND s.active = true AND p.armed = false AND p.training_required = false ORDER BY p.id`)
    .all();

  /* -------------------------------------------- six hours off, then on again */
  const next = await db
    .prepare(
      `SELECT sh.id, sh.user_id, sh.starts_at, u.first_name || ' ' || u.last_name AS officer
       FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN posts p ON p.id = sh.post_id
       WHERE sh.status = 'scheduled' AND ${notSuite} AND u.role = 'officer' AND u.status = 'active'
         AND sh.starts_at BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM shifts o WHERE o.user_id = sh.user_id AND o.id <> sh.id AND o.status <> 'cancelled'
                         AND o.ends_at > sh.starts_at - interval '20 hours' AND o.starts_at < sh.starts_at)
       ORDER BY sh.starts_at, sh.id`
    )
    .all(...SUITE_PEOPLE, toSql(new Date(now.getTime() + 30 * HOUR)), toSql(new Date(now.getTime() + 54 * HOUR)));
  for (const n of next) {
    const back = new Date(sqlToIso(n.starts_at));
    const end = new Date(back.getTime() - 6 * HOUR);
    const start = new Date(end.getTime() - 5 * HOUR);
    const post = await (async () => {
      for (const p of plainPosts) if (await free(n.user_id, p.id, start, end)) return p;
      return null;
    })();
    if (!post) continue;
    await insertShift.run(n.user_id, post.id, toSql(start), toSql(end),
      'Late event cover: the client asked for an extra officer until the venue cleared.', admin);
    result.shortRest = n.officer;
    break;
  }

  /* --------------------------------------------- seven days in a row ahead */
  const people = await db
    .prepare(
      `SELECT u.id, u.first_name || ' ' || u.last_name AS officer, COUNT(*) AS n,
              MIN(EXTRACT(HOUR FROM sh.starts_at)) AS hour
       FROM shifts sh JOIN users u ON u.id = sh.user_id
       WHERE sh.status = 'scheduled' AND ${notSuite} AND u.role = 'officer' AND u.status = 'active'
         AND sh.starts_at BETWEEN ? AND ?
       GROUP BY u.id, u.first_name, u.last_name
       HAVING COUNT(*) BETWEEN 4 AND 6
       ORDER BY COUNT(*) DESC, u.id`
    )
    .all(...SUITE_PEOPLE, toSql(new Date(now.getTime() + DAY)), toSql(new Date(now.getTime() + 8 * DAY)));
  for (const person of people) {
    if (result.shortRest === person.officer) continue;
    const days = new Set(
      (await db
        .prepare(`SELECT starts_at FROM shifts WHERE user_id = ? AND status <> 'cancelled' AND starts_at BETWEEN ? AND ?`)
        .all(person.id, toSql(new Date(now.getTime() + DAY)), toSql(new Date(now.getTime() + 8 * DAY))))
        .map((r) => toDateString(new Date(sqlToIso(r.starts_at))))
    );
    // The days off in the next week, filled with an eight-hour patrol at a
    // plain post that is free then, starting at their usual hour.
    const fills = [];
    for (let d = 1; d <= 7; d++) {
      const day = new Date(now.getTime() + d * DAY);
      if (days.has(toDateString(day))) continue;
      const start = new Date(day);
      start.setHours(Number(person.hour), 0, 0, 0);
      const end = new Date(start.getTime() + 8 * HOUR);
      let post = null;
      for (const p of plainPosts) if (await free(person.id, p.id, start, end)) { post = p; break; }
      if (!post) { fills.length = 0; break; }
      fills.push({ post, start, end });
    }
    if (!fills.length) continue;
    for (const f of fills) {
      await insertShift.run(person.id, f.post.id, toSql(f.start), toSql(f.end), 'Extra patrol, picked up on a day off.', admin);
    }
    result.sevenDays = person.officer;
    break;
  }
  return result;
}
