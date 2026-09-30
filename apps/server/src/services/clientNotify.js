/**
 * Emails to client contacts about their own properties.
 *
 *   - A serious incident (high or critical): sent once, when it is filed or
 *     when a supervisor raises it to serious on review.
 *   - The daily report: yesterday at each property, sent by the daily sweep to
 *     the contacts who asked for it, once per contact, site and day.
 *   - A follow-up done: when a follow-up shared with the client on one of
 *     their incidents is marked done, once, to the contacts who take serious
 *     incident alerts.
 *
 * Only what the portal already shows the client goes in: never the officer's
 * name, a review note or anything about pay.
 */

import { db } from '../lib/db.js';
import { send } from './email.js';
import { toSql } from './compliance.js';

export const SERIOUS = ['high', 'critical'];
const label = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const when = (value) =>
  new Date(value).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });
const portalLink = () => (process.env.USC_PUBLIC_URL ? `${process.env.USC_PUBLIC_URL.replace(/\/+$/, '')}/portal` : 'the client portal');

async function contactsFor(siteId, column) {
  return db
    .prepare(
      `SELECT c.id, c.email, c.name FROM client_users c JOIN client_sites cs ON cs.client_user_id = c.id
       WHERE cs.site_id = ? AND c.status = 'active' AND c.${column} = true ORDER BY c.id`
    )
    .all(siteId);
}

/** Tell the property's contacts about a serious incident, once. Returns how many were emailed. */
export async function notifySeriousIncident(incidentId) {
  const i = await db
    .prepare(
      `SELECT i.*, s.name AS site_name FROM incidents i JOIN sites s ON s.id = i.site_id WHERE i.id = ?`
    )
    .get(incidentId);
  if (!i || !SERIOUS.includes(i.severity) || i.client_notified_at) return 0;
  // Claim it first, so two requests at once cannot both send.
  const claimed = await db
    .prepare(`UPDATE incidents SET client_notified_at = now() WHERE id = ? AND client_notified_at IS NULL`)
    .run(i.id);
  if (!claimed.changes) return 0;

  const contacts = await contactsFor(i.site_id, 'notify_serious_incidents');
  for (const c of contacts) {
    await send({
      to: c.email,
      name: c.name,
      kind: 'incident_alert',
      entity: 'incident',
      entityId: i.id,
      subject: `${label(i.severity)} incident at ${i.site_name} - ${i.ref_number}`,
      body: [
        `Dear ${c.name},`,
        '',
        `Our officer has reported a ${i.severity} incident at ${i.site_name}.`,
        '',
        `  Reference  ${i.ref_number}`,
        `  What       ${label(i.category) || 'Incident'}`,
        `  When       ${when(i.occurred_at)}`,
        i.location_text ? `  Where      ${i.location_text}` : null,
        i.police_notified ? '  Police     Notified' : null,
        '',
        `The full report, with any photographs, is in ${portalLink()} under Incidents. Your account manager will be in touch.`,
        '',
        'You are receiving this because serious incident alerts are on for your account. You can turn them off in the portal.',
      ]
        .filter((l) => l !== null)
        .join('\n'),
    });
  }
  return contacts.length;
}

/** Tell the property's contacts that a follow-up we shared with them is done. Returns how many were emailed. */
export async function notifyFollowUpDone(actionId) {
  const a = await db
    .prepare(
      `SELECT a.id, a.title, a.status, a.client_visible, a.client_notified_at, a.done_at,
              i.id AS incident_id, i.ref_number, i.site_id, s.name AS site_name
       FROM incident_actions a JOIN incidents i ON i.id = a.incident_id JOIN sites s ON s.id = i.site_id
       WHERE a.id = ?`
    )
    .get(actionId);
  if (!a || a.status !== 'done' || !a.client_visible || a.client_notified_at) return 0;
  const claimed = await db
    .prepare(`UPDATE incident_actions SET client_notified_at = now() WHERE id = ? AND client_notified_at IS NULL`)
    .run(a.id);
  if (!claimed.changes) return 0;

  const open = await db
    .prepare(`SELECT title FROM incident_actions WHERE incident_id = ? AND client_visible = true AND status = 'open' ORDER BY due_on NULLS LAST, id`)
    .all(a.incident_id);
  const contacts = await contactsFor(a.site_id, 'notify_serious_incidents');
  for (const c of contacts) {
    await send({
      to: c.email,
      name: c.name,
      kind: 'incident_update',
      entity: 'incident',
      entityId: a.incident_id,
      subject: `Update on ${a.ref_number} at ${a.site_name}: ${a.title}`,
      body: [
        `Dear ${c.name},`,
        '',
        `An update on incident ${a.ref_number} at ${a.site_name}. This is now done:`,
        '',
        `  ${a.title}`,
        '',
        open.length
          ? `Still in hand:\n${open.map((o) => `  - ${o.title}`).join('\n')}`
          : 'That was the last thing we had open on this incident.',
        '',
        `The report and everything we are doing about it are in ${portalLink()} under Incidents.`,
        '',
        'You are receiving this because serious incident alerts are on for your account. You can turn them off in the portal.',
      ].join('\n'),
    });
  }
  return contacts.length;
}

/**
 * Yesterday at each property, to every contact who opted in. Safe to run
 * more than once a day: a contact gets one email per site per day.
 */
export async function sendDailyReports(now = new Date()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 86400000);
  const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const from = toSql(start);
  const to = toSql(end);
  const n = async (sql, ...params) => Number((await db.prepare(sql).get(...params))?.n || 0);

  const pairs = await db
    .prepare(
      `SELECT c.id AS client_id, c.email, c.name, s.id AS site_id, s.name AS site_name
       FROM client_users c JOIN client_sites cs ON cs.client_user_id = c.id JOIN sites s ON s.id = cs.site_id
       WHERE c.status = 'active' AND c.notify_daily_report = true
         AND NOT EXISTS (SELECT 1 FROM client_digests d WHERE d.client_user_id = c.id AND d.site_id = s.id AND d.day = ?)
       ORDER BY c.id, s.id`
    )
    .all(day);

  const cache = new Map();
  let sent = 0;
  for (const p of pairs) {
    if (!cache.has(p.site_id)) {
      const hours = await db
        .prepare(
          `SELECT COUNT(DISTINCT te.user_id) AS officers,
                  COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(te.clock_out_at, ?::timestamptz), ?::timestamptz)
                    - GREATEST(te.clock_in_at, ?::timestamptz))) / 3600), 0) AS hours
           FROM time_entries te JOIN posts po ON po.id = te.post_id
           WHERE po.site_id = ? AND te.clock_in_at < ? AND COALESCE(te.clock_out_at, ?::timestamptz) > ?`
        )
        .get(to, to, from, p.site_id, to, to, from);
      const patrols = await db
        .prepare(
          `SELECT COUNT(DISTINCT tr.id) AS runs, SUM(CASE WHEN trc.status = 'done' THEN 1 ELSE 0 END) AS scanned, COUNT(trc.id) AS total
           FROM tour_runs tr JOIN tours t ON t.id = tr.tour_id LEFT JOIN tour_run_checkpoints trc ON trc.tour_run_id = tr.id
           WHERE t.site_id = ? AND tr.started_at >= ? AND tr.started_at < ?`
        )
        .get(p.site_id, from, to);
      const incidents = await db
        .prepare(
          `SELECT ref_number, category, severity, occurred_at FROM incidents
           WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at`
        )
        .all(p.site_id, from, to);
      cache.set(p.site_id, {
        officers: Number(hours.officers || 0),
        hours: Math.round(Number(hours.hours || 0) * 10) / 10,
        runs: Number(patrols.runs || 0),
        scanned: Number(patrols.scanned || 0),
        checkpoints: Number(patrols.total || 0),
        incidents,
        visitors: await n(`SELECT COUNT(*) AS n FROM visitor_log WHERE site_id = ? AND arrived_at >= ? AND arrived_at < ?`, p.site_id, from, to),
        activity: await n(
          `SELECT COUNT(*) AS n FROM activity_entries WHERE site_id = ? AND client_visible = true AND occurred_at >= ? AND occurred_at < ?`,
          p.site_id, from, to
        ),
        openIssues: await n(`SELECT COUNT(*) AS n FROM site_issues WHERE site_id = ? AND status <> 'fixed'`, p.site_id),
      });
    }
    const d = cache.get(p.site_id);
    const dateText = start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    await send({
      to: p.email,
      name: p.name,
      kind: 'daily_report',
      entity: 'site',
      entityId: p.site_id,
      subject: `Daily report - ${p.site_name}, ${dateText}`,
      body: [
        `Dear ${p.name},`,
        '',
        `Here is ${dateText} at ${p.site_name}.`,
        '',
        `  On site      ${d.officers} officer${d.officers === 1 ? '' : 's'}, ${d.hours} hours`,
        `  Patrols      ${d.runs} round${d.runs === 1 ? '' : 's'}, ${d.scanned} of ${d.checkpoints} checkpoints scanned`,
        `  Incidents    ${d.incidents.length || 'None'}`,
        ...d.incidents.map((i) => `               ${i.ref_number} ${label(i.category)} (${i.severity}), ${when(i.occurred_at)}`),
        `  Visitors     ${d.visitors} signed in`,
        `  Activity     ${d.activity} log entr${d.activity === 1 ? 'y' : 'ies'}`,
        `  Building     ${d.openIssues ? `${d.openIssues} issue${d.openIssues === 1 ? '' : 's'} still open` : 'Nothing open'}`,
        '',
        `The full daily activity report is in ${portalLink()} under Report.`,
        '',
        'You asked for this email in the portal. You can turn it off there.',
      ].join('\n'),
    });
    await db
      .prepare(`INSERT INTO client_digests (client_user_id, site_id, day) VALUES (?,?,?) ON CONFLICT DO NOTHING`)
      .run(p.client_id, p.site_id, day);
    sent++;
  }
  return sent;
}
