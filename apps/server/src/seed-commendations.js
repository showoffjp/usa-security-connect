/**
 * Demo commendations: a client at Riverfront thanking Marcus Bell two days
 * ago (not yet read, so it greets him on his home screen), a supervisor's
 * from last week, and a handful across the other properties.
 */

import { toSql } from './services/compliance.js';

export async function seedCommendations({ db }) {
  const user = async (code) => (await db.prepare(`SELECT id FROM users WHERE employee_code = ?`).get(code))?.id;
  const client = async (email) => (await db.prepare(`SELECT id FROM client_users WHERE email = ?`).get(email))?.id;
  const site = async (name) => (await db.prepare(`SELECT id FROM sites WHERE name = ?`).get(name))?.id;
  const supervisor = await user('1002');
  const ago = (days, hour = 10) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(hour, 15, 0, 0);
    return toSql(d);
  };

  const ROWS = [
    {
      code: '1003', site: 'Riverfront Commerce Center', client: 'dana.whitfield@riverfrontholdings.com', category: 'vigilance', days: 2, seen: false,
      message: 'Marcus noticed the loading dock door propped open at 2 a.m. on his round, closed it and checked the dock before calling it in. Our facilities team found the latch had failed. Thank you.',
    },
    {
      code: '1003', site: 'Riverfront Commerce Center', staff: true, category: 'professionalism', days: 9, seen: true,
      message: 'Spot inspection: post orders read, log complete, uniform squared away and a calm handover to nights. Exactly what we want at Riverfront.',
    },
    {
      code: '1006', staff: true, category: 'teamwork', days: 5, seen: true,
      message: 'Stayed an extra hour on Tuesday so the night officer could get to the hospital to see his daughter. Thank you, Alicia.',
    },
    {
      code: '1020', site: 'Capital Plaza Office Tower', client: 'dfaulkner@capitalplazart.com', category: 'customer_service', days: 4, seen: false,
      message: 'Raymond helped a visitor in a wheelchair when the east lobby lift was out, and walked her round to the service elevator himself. Several tenants mentioned it.',
    },
    {
      code: '1013', staff: true, category: 'emergency', days: 3, seen: false,
      message: 'Handled the disturbance in the ED waiting room exactly by the book: stepped between them, called the Code Grey, held the area until HPD arrived. Well done.',
    },
  ];

  let n = 0;
  for (const r of ROWS) {
    const userId = await user(r.code);
    if (!userId) continue;
    const clientId = r.client ? await client(r.client) : null;
    if (r.client && !clientId) continue;
    await db
      .prepare(
        `INSERT INTO commendations (user_id, site_id, category, message, client_user_id, staff_user_id, seen_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(userId, r.site ? (await site(r.site)) ?? null : null, r.category, r.message, clientId, r.staff ? supervisor : null,
        r.seen ? ago(r.days - 1) : null, ago(r.days));
    n++;
  }
  return { commendations: n };
}
