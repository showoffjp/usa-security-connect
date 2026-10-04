/**
 * Demo holiday calendar: the six core holidays this year and next, at time
 * and a half to pay and to bill. Seeded before payroll closes the demo's past
 * periods, so whatever they contain is in the figures that close.
 */

import { usHolidays, HOLIDAY_DEFAULT_MULTIPLIER } from './shared.js';

export async function seedHolidays({ db, adminId }) {
  const year = new Date().getFullYear();
  let added = 0;
  for (const h of [...usHolidays(year), ...usHolidays(year + 1)].filter((x) => x.core)) {
    const info = await db
      .prepare(
        `INSERT INTO holidays (day, name, pay_multiplier, bill_multiplier, created_by) VALUES (?,?,?,?,?)
         ON CONFLICT (day) DO NOTHING`
      )
      .run(h.day, h.name, HOLIDAY_DEFAULT_MULTIPLIER, HOLIDAY_DEFAULT_MULTIPLIER, adminId ?? null);
    added += info.changes || 0;
  }
  return { holidays: added };
}
