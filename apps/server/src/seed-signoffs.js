/**
 * Demo sign-offs of the week's hours: most properties have signed off the
 * weeks before last and have last week waiting on them. Palmetto Ridge has
 * disputed last week; Harborview disputed the week before and has had our
 * reply; Capital Plaza signed last week off before a punch was corrected, so
 * it reads as changed since signed. Riverfront's contact, the demo client,
 * has last week to sign off.
 *
 * Every week is answered by one of the property's own portal contacts, with
 * the hours as they stand when the seed runs.
 */

import { toSql } from './services/compliance.js';
import { siteWeeks, weekHours, mondayOf } from './services/signoffs.js';

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const at = (day, h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);

export async function seedSignoffs({ db }) {
  const sites = await db
    .prepare(
      `SELECT s.id, s.name,
              (SELECT MIN(cs.client_user_id) FROM client_sites cs JOIN client_users c ON c.id = cs.client_user_id
                WHERE cs.site_id = s.id AND c.status = 'active') AS contact
       FROM sites s WHERE s.active ORDER BY s.id`
    )
    .all();
  const admin = await db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();
  const insert = db.prepare(
    `INSERT INTO hours_signoffs (site_id, week_start, status, minutes, fingerprint, note, client_user_id, decided_at,
                                 response, responded_by, responded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (site_id, week_start) DO NOTHING`
  );

  let approved = 0;
  let disputed = 0;
  let changed = 0;
  const lastWeek = addDays(mondayOf(), -7);
  for (const site of sites) {
    if (!site.contact) continue;
    const weeks = (await siteWeeks(site.id, 3)).filter((w) => w.shifts > 0 && w.running === 0);
    for (const w of weeks) {
      const start = new Date(`${w.week_of}T00:00:00`);
      const isLast = start.getTime() === lastWeek.getTime();
      const answeredAt = at(addDays(start, 8), 9, 30 + (site.id % 20));
      const week = await weekHours(site.id, start);

      if (/Palmetto/.test(site.name) && isLast) {
        await insert.run(site.id, w.week_of, 'disputed', week.minutes, week.fingerprint,
          'The gate log shows nobody at the North Gatehouse on Wednesday night between 2 and 4 AM, but that shift is billed in full.',
          site.contact, toSql(answeredAt), null, null, null);
        disputed++;
        continue;
      }
      if (/Harborview/.test(site.name) && !isLast && start.getTime() === addDays(lastWeek, -7).getTime()) {
        await insert.run(site.id, w.week_of, 'disputed', week.minutes, week.fingerprint,
          'We count 42 hours for the Parking Garage Patrol, not the hours shown. Please check the weekend shifts.',
          site.contact, toSql(answeredAt),
          'The weekend shifts ran 7 PM to 7 AM, twelve hours each, as agreed for the garage in August - that is the difference. The clock-in and clock-out times are under Coverage. Tell us if that does not match your records.',
          admin?.id ?? null, toSql(at(addDays(start, 9), 11, 15)));
        disputed++;
        continue;
      }
      if (isLast && /Capital Plaza/.test(site.name)) {
        // Signed off before a late punch on that week was corrected by half an hour.
        await insert.run(site.id, w.week_of, 'approved', Math.max(0, week.minutes - 30), `${week.fingerprint.slice(0, 24)}superseded`,
          null, site.contact, toSql(answeredAt), null, null, null);
        changed++;
        continue;
      }
      if (isLast && !/Pensacola|Seaside/.test(site.name)) continue; // waiting on the client
      await insert.run(site.id, w.week_of, 'approved', week.minutes, week.fingerprint, null, site.contact, toSql(answeredAt), null, null, null);
      approved++;
    }
  }
  return { approved, disputed, changed };
}
