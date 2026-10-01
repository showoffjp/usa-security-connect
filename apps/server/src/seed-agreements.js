/**
 * Demo service agreements. Most sites are contracted for what they are
 * rostered; Gulfport pays for 48 hours a week and has an 8-hour shift nobody
 * has taken, so it is short; Palmetto Ridge's agreement runs out inside its
 * notice period; Coral Bay is month to month with no agreement on file.
 */

import { toDateString } from './lib/http.js';
import { agreementBoard } from './services/agreements.js';

export async function seedAgreements({ db }) {
  const admin = await db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();
  const board = await agreementBoard();
  const inDays = (n) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return toDateString(d);
  };
  const special = {
    'Gulfport Logistics Yard': { hours: 48, ends: 210, notes: 'Two 8-hour shifts a day on weekdays. The Saturday day shift is part of the agreement.' },
    'Palmetto Ridge Residences': { hours: 56, ends: 38, notice: 60, notes: 'HOA board votes on renewal at its November meeting. Send the proposal by mid-October.' },
    'Bayfront Marina & Yacht Club': { autoRenew: true, ends: 300 },
    'Coral Bay Retail Plaza': { skip: true },
  };
  const insert = db.prepare(
    `INSERT INTO site_agreements (site_id, weekly_hours, starts_on, ends_on, notice_days, auto_renew, notes, updated_by)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  let n = 0;
  for (const [i, site] of board.sites.entries()) {
    const s = special[site.name] || {};
    if (s.skip) continue;
    const hours = s.hours ?? Math.max(8, Math.round(site.rostered_hours * 2) / 2);
    const ends = s.ends ?? 120 + ((i * 47) % 210);
    await insert.run(site.id, hours, inDays(ends - 365), inDays(ends), s.notice ?? 60, Boolean(s.autoRenew), s.notes ?? null, admin?.id ?? null);
    n += 1;
  }
  return { agreements: n };
}
