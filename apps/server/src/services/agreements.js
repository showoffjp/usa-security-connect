/**
 * Service agreements: the hours a week each property pays for, held against
 * the roster and the hours actually worked.
 *
 * Three numbers per site. Contracted: the agreement. Rostered: shifts with an
 * officer on them in the next seven days, plus the open ones nobody has
 * taken yet. Delivered: hours clocked at the site in the last seven days. A
 * site whose next week is rostered short of its agreement, or whose agreement
 * is inside its notice period, is something a manager needs to know now.
 */

import { db } from '../lib/db.js';
import { toDateString, parseDay } from '../lib/http.js';
import { toSql } from './compliance.js';

const DAY = 86400000;
const hours = (minutes) => Math.round((Number(minutes) || 0) / 6) / 10;
/** Half an hour of slack, so a roster built to the minute is not called short. */
export const SHORT_TOLERANCE_HOURS = 0.5;

export function presentAgreement(a, today = parseDay()) {
  if (!a) return null;
  const end = a.ends_on ? parseDay(String(a.ends_on)) : null;
  const daysLeft = end ? Math.round((end - today) / DAY) : null;
  return {
    site_id: a.site_id,
    weekly_hours: Number(a.weekly_hours),
    starts_on: a.starts_on ? String(a.starts_on).slice(0, 10) : null,
    ends_on: a.ends_on ? String(a.ends_on).slice(0, 10) : null,
    notice_days: Number(a.notice_days),
    auto_renew: Boolean(a.auto_renew),
    notes: a.notes ?? null,
    updated_at: a.updated_at instanceof Date ? a.updated_at.toISOString() : a.updated_at,
    days_left: daysLeft,
    expired: daysLeft != null && daysLeft < 0,
    // Inside the notice period and not set to renew on its own.
    renewal_due: daysLeft != null && !a.auto_renew && daysLeft <= Number(a.notice_days),
  };
}

/** Every active site with its agreement and the three numbers. */
export async function agreementBoard(now = new Date()) {
  const sites = await db
    .prepare(`SELECT id, name, client_name, city FROM sites WHERE active = true ORDER BY name`)
    .all();
  const agreements = new Map(
    (await db.prepare(`SELECT * FROM site_agreements`).all()).map((a) => [a.site_id, a])
  );
  const ahead = toSql(new Date(now.getTime() + 7 * DAY));
  const back = toSql(new Date(now.getTime() - 7 * DAY));
  const nowSql = toSql(now);

  const rostered = new Map(
    (await db
      .prepare(
        `SELECT p.site_id,
                SUM(CASE WHEN sh.user_id IS NOT NULL THEN EXTRACT(EPOCH FROM (sh.ends_at - sh.starts_at)) / 60 ELSE 0 END) AS filled,
                SUM(CASE WHEN sh.user_id IS NULL THEN EXTRACT(EPOCH FROM (sh.ends_at - sh.starts_at)) / 60 ELSE 0 END) AS open
         FROM shifts sh JOIN posts p ON p.id = sh.post_id
         WHERE sh.status <> 'cancelled' AND sh.starts_at >= ? AND sh.starts_at < ?
         GROUP BY p.site_id`
      )
      .all(nowSql, ahead)).map((r) => [r.site_id, r])
  );
  const delivered = new Map(
    (await db
      .prepare(
        `SELECT p.site_id, SUM(te.minutes_worked) AS minutes
         FROM time_entries te JOIN posts p ON p.id = te.post_id
         WHERE te.clock_in_at >= ? AND te.clock_in_at < ? AND te.clock_out_at IS NOT NULL
         GROUP BY p.site_id`
      )
      .all(back, nowSql)).map((r) => [r.site_id, Number(r.minutes) || 0])
  );

  const today = parseDay();
  const rows = sites.map((s) => {
    const agreement = presentAgreement(agreements.get(s.id), today);
    const r = rostered.get(s.id);
    const filled = hours(r?.filled);
    const open = hours(r?.open);
    const worked = hours(delivered.get(s.id));
    const contracted = agreement?.weekly_hours ?? null;
    const shortfall = contracted != null ? Math.max(0, Math.round((contracted - filled) * 10) / 10) : null;
    return {
      ...s,
      agreement,
      rostered_hours: filled,
      open_hours: open,
      delivered_hours: worked,
      shortfall_hours: shortfall,
      short: shortfall != null && shortfall > SHORT_TOLERANCE_HOURS,
      delivered_pct: contracted ? Math.round((worked / contracted) * 1000) / 10 : null,
    };
  });
  return {
    sites: rows,
    summary: {
      sites: rows.length,
      withAgreement: rows.filter((r) => r.agreement).length,
      short: rows.filter((r) => r.short).length,
      renewals: rows.filter((r) => r.agreement?.renewal_due).length,
      contractedHours: Math.round(rows.reduce((n, r) => n + (r.agreement?.weekly_hours || 0), 0) * 10) / 10,
      rosteredHours: Math.round(rows.reduce((n, r) => n + (r.agreement ? r.rostered_hours : 0), 0) * 10) / 10,
    },
  };
}

/**
 * The last few whole weeks (Monday to Sunday) at one site: contracted against
 * worked. What a client sees in the portal.
 */
export async function deliveredByWeek(siteId, weeks = 4) {
  const monday = parseDay();
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  // A week before we have any record at the site is not a week of zero hours.
  const first = await db
    .prepare(`SELECT MIN(te.clock_in_at) AS at FROM time_entries te JOIN posts p ON p.id = te.post_id WHERE p.site_id = ?`)
    .get(siteId);
  const since = first?.at ? new Date(first.at) : null;
  const out = [];
  for (let i = weeks; i >= 1; i--) {
    const start = new Date(monday);
    start.setDate(start.getDate() - 7 * i);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    if (!since || end <= since) continue;
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(te.minutes_worked), 0) AS minutes
         FROM time_entries te JOIN posts p ON p.id = te.post_id
         WHERE p.site_id = ? AND te.clock_in_at >= ? AND te.clock_in_at < ? AND te.clock_out_at IS NOT NULL`
      )
      .get(siteId, toSql(start), toSql(end));
    out.push({ week_of: toDateString(start), hours: hours(row?.minutes) });
  }
  return out;
}
