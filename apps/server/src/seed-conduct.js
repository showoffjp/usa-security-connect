/**
 * Demo coaching and discipline:
 *
 *  - Marcus Bell, the demo officer, was coached three days ago for a late
 *    clock-in, and has it to read and sign;
 *  - one officer has climbed the attendance ladder this year - coached,
 *    then a verbal warning they signed with their side of it, then a written
 *    warning they refused to sign, so the next step is a final warning;
 *  - one has had a verbal warning about uniform for over a week without
 *    signing it, which the alerts inbox chases;
 *  - one was found asleep on post: a final warning, and a three-day
 *    suspension already served;
 *  - a written warning over a client complaint was rescinded when the
 *    camera footage showed it was someone else;
 *  - and a coaching from more than a year ago no longer counts.
 */

import { toSql } from './services/compliance.js';
import { toDateString } from './lib/http.js';

const DAY = 86400000;
const SUITE_PEOPLE = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008'];
// The site-training story's officers are left out, so each officer has one story.
const TAKEN = ['1020', '1036', '1042'];

export async function seedConduct({ db }) {
  const idOf = async (code) => (await db.prepare(`SELECT id FROM users WHERE employee_code = ?`).get(code))?.id;
  const supervisor = await idOf('1002');
  const admin = await idOf('1001');
  const marcus = await idOf('1003');
  const others = await db
    .prepare(
      `SELECT id, first_name || ' ' || last_name AS name FROM users
       WHERE status = 'active' AND role = 'officer' AND employee_code NOT IN (${[...SUITE_PEOPLE, ...TAKEN].map(() => '?').join(',')})
       ORDER BY employee_code LIMIT 5`
    )
    .all(...SUITE_PEOPLE, ...TAKEN);
  const daysAgo = (n) => toDateString(new Date(Date.now() - n * DAY));
  const at = (n, h = 10) => {
    const d = new Date(Date.now() - n * DAY);
    d.setHours(h, 20, 0, 0);
    return toSql(d);
  };
  const insert = db.prepare(
    `INSERT INTO conduct_records (user_id, category, level, occurred_on, summary, expectations, suspension_starts_on, suspension_ends_on,
       status, issued_by, created_at, acknowledged_at, signature, officer_statement, refused_witness, refused_by, refused_at,
       rescinded_at, rescinded_by, rescind_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const add = (r) =>
    insert.run(r.user, r.category, r.level, r.on, r.summary, r.expect, r.from ?? null, r.to ?? null, r.status || 'issued',
      r.by ?? supervisor, r.created, r.ackAt ?? null, r.signature ?? null, r.statement ?? null, r.witness ?? null,
      r.witness ? supervisor : null, r.witness ? r.refusedAt : null, r.rescindedAt ?? null, r.rescindedAt ? admin : null, r.rescindReason ?? null);

  let n = 0;
  if (marcus) {
    await add({ user: marcus, category: 'attendance', level: 'coaching', on: daysAgo(3), created: at(1, 16),
      summary: 'Clocked in at the Riverfront lobby console 14 minutes after the 7:00 AM start, and did not call ahead. The night officer stayed on until relieved.',
      expect: 'Be on post and clocked in by the start of the shift. If you are running late, call the supervisor line before the shift starts.' });
    n++;
  }
  const [ladder, uniform, asleep, complaint, old] = others;
  if (ladder) {
    const name = ladder.name;
    await add({ user: ladder.id, category: 'attendance', level: 'coaching', on: daysAgo(150), created: at(149), status: 'acknowledged', ackAt: at(148), signature: name,
      summary: 'Two late clock-ins in one week at the start of the night shift: 9 and 17 minutes.',
      expect: 'Be clocked in by the start of every shift.' });
    await add({ user: ladder.id, category: 'attendance', level: 'verbal_warning', on: daysAgo(62), created: at(61), status: 'acknowledged', ackAt: at(60), signature: name,
      statement: 'My car was in the shop that week and the bus runs late. It is fixed now.',
      summary: 'Late again on three shifts in two weeks after being coached in the spring, the longest by 25 minutes.',
      expect: 'No late clock-ins. Call ahead if anything will make you late, so cover can be arranged.' });
    await add({ user: ladder.id, category: 'attendance', level: 'written_warning', on: daysAgo(12), created: at(11), status: 'refused', witness: 'Tasha Greene, shift lead', refusedAt: at(10),
      summary: 'Did not show for an overnight shift and did not call. The post was covered by holding the evening officer over for six hours.',
      expect: 'Work every rostered shift or give at least four hours notice. Another no-call no-show will lead to a final warning.' });
    n += 3;
  }
  if (uniform) {
    await add({ user: uniform.id, category: 'uniform', level: 'verbal_warning', on: daysAgo(9), created: at(8),
      summary: 'On a supervisor visit, working the post without the company jacket and badge, in jeans, after a reminder the week before.',
      expect: 'Full uniform on every shift: company shirt or jacket, badge visible, black trousers.' });
    n++;
  }
  if (asleep) {
    await add({ user: asleep.id, category: 'post_conduct', level: 'final_warning', on: daysAgo(34), created: at(33), by: admin, status: 'acknowledged', ackAt: at(32), signature: asleep.name,
      statement: 'I had worked a double the day before. I accept it should not have happened.',
      summary: 'Found asleep in the guard booth at 3:40 AM by the field supervisor, with the gate arm left up.',
      expect: 'Stay alert and on your feet through every round. Do not accept back-to-back doubles. Any repeat will end your employment.' });
    await add({ user: asleep.id, category: 'post_conduct', level: 'suspension', on: daysAgo(34), created: at(33), by: admin, status: 'acknowledged', ackAt: at(32), signature: asleep.name,
      from: daysAgo(31), to: daysAgo(29),
      summary: 'Three days off without pay for sleeping on post, alongside the final warning.',
      expect: 'Return on the fourth day and go through the post orders with the supervisor before the first shift.' });
    n += 2;
  }
  if (complaint) {
    await add({ user: complaint.id, category: 'client_complaint', level: 'written_warning', on: daysAgo(20), created: at(19), status: 'rescinded',
      rescindedAt: at(15), rescindReason: 'The camera footage showed the visitor was signed in by the day porter, not our officer. Withdrawn with an apology.',
      summary: 'The property manager reported a contractor let into the server room without being signed in.',
      expect: 'Sign every contractor in, and check their access list, before letting them past the lobby.' });
    n++;
  }
  if (old) {
    await add({ user: old.id, category: 'procedure', level: 'coaching', on: daysAgo(420), created: at(419), status: 'acknowledged', ackAt: at(418), signature: old.name,
      summary: 'Skipped two checkpoints on the garage round without noting why.',
      expect: 'Scan every checkpoint, or note in the round why one was skipped.' });
    n++;
  }
  return { records: n };
}
