/**
 * One site's month: how much of the schedule was covered, the patrols
 * walked, what happened, who came through, and what was fixed. The client's
 * monthly report and the managers' site health board both read it, so the
 * two can never disagree about a number.
 */

import { db } from '../lib/db.js';
import { HttpError, isoFields } from '../lib/http.js';
import { toSql } from './compliance.js';

const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** Validate a YYYY-MM month and return its bounds; the current month runs to now. */
export function monthBounds(month = monthKey()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(422, 'Month must look like 2026-09.');
  const now = new Date();
  const [y, m] = month.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 1);
  if (start > now) throw new HttpError(422, 'That month has not started yet.');
  if (start < new Date(now.getFullYear() - 2, now.getMonth(), 1)) throw new HttpError(422, 'Reports go back two years.');
  const end = monthEnd < now ? monthEnd : now;
  return { month, from: toSql(start), to: toSql(end), partial: monthEnd > now };
}

export async function siteMonth(siteId, month = monthKey()) {
  const { from, to, partial } = monthBounds(month);
  const n = (v) => Number(v || 0);
  const site = await db.prepare(`SELECT id, name, address, city, state FROM sites WHERE id = ?`).get(siteId);
  if (!site) throw new HttpError(404, 'Site not found.');

  const posts = await db
    .prepare(
      `SELECT p.id, p.name, p.post_code,
              COUNT(sh.id) AS scheduled,
              SUM(CASE WHEN te.id IS NOT NULL THEN 1 ELSE 0 END) AS covered,
              COALESCE(SUM(te.minutes_worked), 0) AS minutes
       FROM posts p
       LEFT JOIN shifts sh ON sh.post_id = p.id AND sh.status != 'cancelled'
         AND sh.starts_at >= ? AND sh.starts_at < ? AND sh.starts_at < now()
       LEFT JOIN time_entries te ON te.shift_id = sh.id
       WHERE p.site_id = ?
       GROUP BY p.id, p.name, p.post_code ORDER BY p.name`
    )
    .all(from, to, siteId);
  const scheduled = posts.reduce((a, p) => a + n(p.scheduled), 0);
  const covered = posts.reduce((a, p) => a + n(p.covered), 0);
  const minutes = posts.reduce((a, p) => a + n(p.minutes), 0);

  const patrols = await db
    .prepare(
      `SELECT COUNT(DISTINCT tr.id) AS runs,
              SUM(CASE WHEN trc.status = 'done' THEN 1 ELSE 0 END) AS scanned,
              SUM(CASE WHEN trc.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
              COUNT(trc.id) AS checkpoints
       FROM tour_runs tr JOIN tours t ON t.id = tr.tour_id
       LEFT JOIN tour_run_checkpoints trc ON trc.tour_run_id = tr.id
       WHERE t.site_id = ? AND tr.started_at >= ? AND tr.started_at < ?`
    )
    .get(siteId, from, to);

  const incidents = await db
    .prepare(
      `SELECT id, ref_number, category, severity, status, occurred_at, location_text, police_notified
       FROM incidents WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at`
    )
    .all(siteId, from, to);

  const count = async (sql, ...params) => n((await db.prepare(sql).get(...params))?.n);
  const visitors = await count(`SELECT COUNT(*) AS n FROM visitor_log WHERE site_id = ? AND arrived_at >= ? AND arrived_at < ?`, siteId, from, to);
  const violations = await count(`SELECT COUNT(*) AS n FROM vehicle_violations WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?`, siteId, from, to);
  const activity = await count(
    `SELECT COUNT(*) AS n FROM activity_entries WHERE site_id = ? AND client_visible = true AND occurred_at >= ? AND occurred_at < ?`,
    siteId, from, to
  );
  const visits = await count(`SELECT COUNT(*) AS n FROM supervisor_visits WHERE site_id = ? AND visited_at >= ? AND visited_at < ?`, siteId, from, to);
  const issuesReported = await count(`SELECT COUNT(*) AS n FROM site_issues WHERE site_id = ? AND created_at >= ? AND created_at < ?`, siteId, from, to);
  const issuesFixed = await count(`SELECT COUNT(*) AS n FROM site_issues WHERE site_id = ? AND fixed_at >= ? AND fixed_at < ?`, siteId, from, to);
  const issuesOpen = await count(`SELECT COUNT(*) AS n FROM site_issues WHERE site_id = ? AND status <> 'fixed' AND created_at < ?`, siteId, to);
  const found = await count(`SELECT COUNT(*) AS n FROM lost_found WHERE site_id = ? AND found_at >= ? AND found_at < ?`, siteId, from, to);
  const rating = await db
    .prepare(`SELECT ROUND(AVG(rating)::numeric, 1) AS average, COUNT(*) AS n FROM client_feedback WHERE site_id = ? AND period = ?`)
    .get(siteId, month);

  const bySeverity = {};
  for (const i of incidents) bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;

  return {
    month,
    partial,
    site,
    coverage: {
      scheduled, covered, hours: Math.round(minutes / 6) / 10,
      pct: scheduled ? Math.round((covered / scheduled) * 1000) / 10 : null,
    },
    posts: posts.map((p) => ({
      id: p.id, name: p.name, post_code: p.post_code, scheduled: n(p.scheduled), covered: n(p.covered),
      hours: Math.round(n(p.minutes) / 6) / 10,
    })),
    patrols: {
      runs: n(patrols.runs), checkpoints: n(patrols.checkpoints), scanned: n(patrols.scanned), skipped: n(patrols.skipped),
      pct: n(patrols.checkpoints) ? Math.round((n(patrols.scanned) / n(patrols.checkpoints)) * 1000) / 10 : null,
    },
    incidents: { total: incidents.length, bySeverity, list: incidents.map((i) => isoFields(i, ['occurred_at'])) },
    visitors, violations, activity, supervisorVisits: visits,
    issues: { reported: issuesReported, fixed: issuesFixed, open: issuesOpen },
    found,
    rating: rating?.n ? { average: Number(rating.average), count: n(rating.n) } : null,
  };
}
