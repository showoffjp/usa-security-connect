/**
 * Demo site training. The armed posts, Harborview's Emergency Department
 * Entrance and the Research Park's lab access desk need it. Everyone who has
 * worked one of those posts is signed off there already, except:
 *
 *  - at Capital Plaza's armed garage post, the officer newest to it has been
 *    working it with a partner and is still waiting to be signed off;
 *  - at the Emergency Department Entrance, another officer is rostered on a
 *    training shift alongside a trained one later this week;
 *  - at the lab desk, one officer was trained months ago and has not worked
 *    it since, so they need a refresher;
 *  - at Pensacola's armed warehouse post, one officer's training was
 *    withdrawn after a supervisor's spot check.
 */

import { toSql } from './services/compliance.js';

const REQUIRED = [
  ['Gulfport Logistics Yard', 'Yard Security - Armed'],
  ['Capital Plaza Office Tower', 'Garage & Loading Dock - Armed'],
  ['Pensacola Distribution Center', 'Warehouse Interior - Armed'],
  ['Harborview Medical Center', 'Emergency Department Entrance'],
  ['Sunshine State University Research Park', 'Lab Building Access Control'],
];

const DAY = 86400000;
// The people the API suites sign in as are left as they are.
const SUITE_PEOPLE = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008'];

export async function seedTraining({ db }) {
  const supervisor = (await db.prepare(`SELECT id FROM users WHERE employee_code = '1002'`).get())?.id ?? null;
  const posts = [];
  for (const [site, name] of REQUIRED) {
    const post = await db
      .prepare(`SELECT p.id, p.name FROM posts p JOIN sites s ON s.id = p.site_id WHERE s.name = ? AND p.name = ?`)
      .get(site, name);
    if (!post) continue;
    await db.prepare(`UPDATE posts SET training_required = true WHERE id = ?`).run(post.id);
    posts.push(post);
  }
  const byName = (name) => posts.find((p) => p.name === name);
  const insert = db.prepare(
    `INSERT INTO post_qualifications (post_id, user_id, status, method, note, trained_at, signed_off_by, revoked_at, revoked_by, revoke_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (post_id, user_id) DO NOTHING`
  );

  // Who has worked each post, and how much.
  const worked = async (postId) =>
    db
      .prepare(
        `SELECT te.user_id, u.employee_code, u.first_name, COUNT(*) AS n, MIN(te.clock_in_at) AS first_at, MAX(te.clock_in_at) AS last_at
         FROM time_entries te JOIN users u ON u.id = te.user_id
         WHERE te.post_id = ? AND te.clock_out_at IS NOT NULL AND u.status = 'active'
         GROUP BY te.user_id, u.employee_code, u.first_name ORDER BY COUNT(*) DESC, te.user_id`
      )
      .all(postId);

  let trained = 0;
  let waiting = null;
  const ed = byName('Emergency Department Entrance');
  const garage = byName('Garage & Loading Dock - Armed');
  for (const post of posts) {
    const people = await worked(post.id);
    // At the garage, the officer newest to it is waiting on a sign-off.
    const candidates = people.filter((p) => !SUITE_PEOPLE.includes(p.employee_code));
    if (post === garage && people.length >= 2 && candidates.length) {
      waiting = candidates[candidates.length - 1];
    }
    for (const p of people) {
      if (waiting && p.user_id === waiting.user_id && post === garage) continue;
      const before = new Date(new Date(p.first_at).getTime() - 3 * DAY);
      await insert.run(post.id, p.user_id, 'trained', 'prior_experience', null, toSql(before), supervisor, null, null, null);
      trained++;
    }
  }

  // A training shift: someone new to the ED, alongside its trained officer.
  let training = null;
  if (ed) {
    const host = await db
      .prepare(
        `SELECT sh.*, u.first_name || ' ' || u.last_name AS officer FROM shifts sh JOIN users u ON u.id = sh.user_id
         WHERE sh.post_id = ? AND sh.status = 'scheduled' AND sh.starts_at > ? AND sh.starts_at < ?
         ORDER BY sh.starts_at LIMIT 1`
      )
      .get(ed.id, toSql(new Date(Date.now() + 2 * DAY)), toSql(new Date(Date.now() + 6 * DAY)));
    if (host) {
      const trainee = await db
        .prepare(
          `SELECT u.id, u.first_name || ' ' || u.last_name AS name FROM users u
           WHERE u.status = 'active' AND u.role = 'officer' AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
             AND NOT EXISTS (SELECT 1 FROM post_qualifications q WHERE q.post_id = ? AND q.user_id = u.id)
             AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.post_id = ? AND te.user_id = u.id)
             AND NOT EXISTS (SELECT 1 FROM shifts sh WHERE sh.user_id = u.id AND sh.status != 'cancelled'
                              AND sh.starts_at < ?::timestamptz + interval '12 hours' AND sh.ends_at > ?::timestamptz - interval '12 hours')
             AND NOT EXISTS (SELECT 1 FROM time_off_requests t WHERE t.user_id = u.id AND t.status = 'approved'
                              AND t.starts_on <= ?::date AND t.ends_on >= ?::date)
           ORDER BY (SELECT COUNT(*) FROM shifts sh WHERE sh.user_id = u.id AND sh.starts_at > now() AND sh.starts_at < now() + interval '7 days'), u.id
           LIMIT 1`
        )
        .get(...SUITE_PEOPLE, ed.id, ed.id, host.ends_at, host.starts_at, host.starts_at, host.starts_at);
      if (trainee) {
        await db
          .prepare(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status, notes, created_by) VALUES (?,?,?,?, 'scheduled', ?, ?)`)
          .run(trainee.id, ed.id, host.starts_at, host.ends_at, `Training shift: shadowing ${host.officer}.`, supervisor);
        training = trainee.name;
      }
    }
  }

  // Trained on the lab desk in the spring, not back since: needs a refresher.
  let lapsed = null;
  const lab = byName('Lab Building Access Control');
  if (lab) {
    const who = await db
      .prepare(
        `SELECT u.id, u.first_name || ' ' || u.last_name AS name FROM users u
         WHERE u.status = 'active' AND u.role = 'officer' AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM post_qualifications q WHERE q.post_id = ? AND q.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.post_id = ? AND te.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM shifts sh WHERE sh.post_id = ? AND sh.user_id = u.id)
         ORDER BY u.id DESC LIMIT 1`
      )
      .get(...SUITE_PEOPLE, lab.id, lab.id, lab.id);
    if (who) {
      await insert.run(lab.id, who.id, 'trained', 'walkthrough', 'Badge office, loading bay and the after-hours sign-in book.',
        toSql(new Date(Date.now() - 214 * DAY)), supervisor, null, null, null);
      lapsed = who.name;
    }
  }

  // Withdrawn at the armed warehouse after a supervisor's spot check: a
  // Class G officer who covered it in the summer and has not been back.
  let revoked = null;
  const warehouse = byName('Warehouse Interior - Armed');
  if (warehouse) {
    const who = await db
      .prepare(
        `SELECT u.id, u.first_name || ' ' || u.last_name AS name FROM users u
         WHERE u.status = 'active' AND u.role = 'officer' AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
           AND (u.license_type ILIKE '%class g%'
                OR EXISTS (SELECT 1 FROM certifications c WHERE c.user_id = u.id AND c.type ILIKE '%class g%'))
           AND NOT EXISTS (SELECT 1 FROM post_qualifications q WHERE q.post_id = ? AND q.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM shifts sh WHERE sh.post_id = ? AND sh.user_id = u.id)
         ORDER BY u.id LIMIT 1`
      )
      .get(...SUITE_PEOPLE, warehouse.id, warehouse.id);
    if (who) {
      await insert.run(warehouse.id, who.id, 'revoked', 'walkthrough', 'Cage, dock doors and the alarm panel with the site lead.',
        toSql(new Date(Date.now() - 96 * DAY)), supervisor, toSql(new Date(Date.now() - 18 * DAY)), supervisor,
        'Left the dock roll-up door open and unattended during a delivery. A shadow shift with a trained officer before working it alone again.');
      revoked = who.name;
    }
  }

  return { posts: posts.length, trained, waiting: waiting ? `${waiting.first_name} (${garage.name})` : null, training, lapsed, revoked };
}
