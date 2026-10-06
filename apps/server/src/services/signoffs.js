/**
 * Client sign-off of the week's hours.
 *
 * Each completed week at a property, the client contact sees the hours worked
 * on each post - the same clocked hours the invoice is built from - and either
 * signs them off or disputes them with a reason. What was signed is kept as a
 * fingerprint of the time entries behind it: if a punch is corrected later the
 * week reads as changed, and is signed again before it can be relied on.
 *
 * Only finished shifts count. A shift still running when the week ends holds
 * that week back: it cannot be signed until the officer has clocked out.
 */

import { createHash } from 'node:crypto';
import { db } from '../lib/db.js';
import { parseDay, toDateString, isoFields } from '../lib/http.js';
import { toSql } from './compliance.js';

/** How many completed weeks a client can look back over and sign. */
export const SIGNOFF_WEEKS = 6;

const hours = (minutes) => Math.round((Number(minutes) || 0) / 6) / 10;

/** Monday 00:00 of the week `day` falls in, local time. */
export function mondayOf(day = parseDay()) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * The hours at one site in the week starting `weekStart`: per post, and a
 * fingerprint of exactly which entries, at which lengths, make them up.
 */
export async function weekHours(siteId, weekStart) {
  const start = new Date(weekStart);
  const end = addDays(start, 7);
  const rows = await db
    .prepare(
      `SELECT te.id, te.post_id, te.minutes_worked, te.clock_out_at, p.name AS post_name, p.post_code
       FROM time_entries te JOIN posts p ON p.id = te.post_id
       WHERE p.site_id = ? AND te.clock_in_at >= ? AND te.clock_in_at < ?
       ORDER BY te.id`
    )
    .all(siteId, toSql(start), toSql(end));

  const byPost = new Map();
  let minutes = 0;
  let running = 0;
  const parts = [];
  for (const r of rows) {
    if (!r.clock_out_at) {
      running++;
      continue;
    }
    const m = Number(r.minutes_worked) || 0;
    minutes += m;
    parts.push(`${r.id}:${m}`);
    const post = byPost.get(r.post_id) || { post_id: r.post_id, post_name: r.post_name, post_code: r.post_code, shifts: 0, minutes: 0 };
    post.shifts++;
    post.minutes += m;
    byPost.set(r.post_id, post);
  }
  const fingerprint = createHash('sha256').update(parts.join(',')).digest('hex').slice(0, 32);
  return {
    week_of: toDateString(start),
    minutes,
    hours: hours(minutes),
    shifts: parts.length,
    running,
    posts: [...byPost.values()]
      .sort((a, b) => b.minutes - a.minutes)
      .map((p) => ({ ...p, hours: hours(p.minutes) })),
    fingerprint,
  };
}

const presentSignoff = (s) =>
  s
    ? {
        ...isoFields(s, ['decided_at', 'responded_at']),
        week_start: typeof s.week_start === 'string' ? s.week_start.slice(0, 10) : toDateString(new Date(s.week_start)),
        hours: hours(s.minutes),
      }
    : null;

/**
 * Where a week stands: waiting for the client, signed off, disputed, signed
 * off but changed since, or not ready (a shift in it is still running).
 */
export function weekState(week, signoff) {
  if (week.running > 0 && !signoff) return 'not_ready';
  if (!signoff) return week.shifts ? 'waiting' : 'no_hours';
  if (signoff.status === 'disputed') return 'disputed';
  return signoff.fingerprint === week.fingerprint ? 'approved' : 'changed';
}

async function signoffsFor(siteId, from, to) {
  const rows = await db
    .prepare(
      `SELECT h.*, c.name AS client_name, u.first_name || ' ' || u.last_name AS responded_by_name
       FROM hours_signoffs h
       LEFT JOIN client_users c ON c.id = h.client_user_id
       LEFT JOIN users u ON u.id = h.responded_by
       WHERE h.site_id = ? AND h.week_start >= ? AND h.week_start <= ?`
    )
    .all(siteId, toDateString(from), toDateString(to));
  return new Map(rows.map((r) => [presentSignoff(r).week_start, r]));
}

/**
 * The last `weeks` completed weeks at a site, newest first, each with its
 * hours and where its sign-off stands. Weeks before the site's first recorded
 * shift are left out rather than shown as weeks of nothing.
 */
export async function siteWeeks(siteId, weeks = SIGNOFF_WEEKS) {
  const thisWeek = mondayOf();
  const first = await db
    .prepare(`SELECT MIN(te.clock_in_at) AS at FROM time_entries te JOIN posts p ON p.id = te.post_id WHERE p.site_id = ?`)
    .get(siteId);
  const since = first?.at ? new Date(first.at) : null;
  const oldest = addDays(thisWeek, -7 * weeks);
  const signed = await signoffsFor(siteId, oldest, thisWeek);
  const out = [];
  for (let i = 1; i <= weeks; i++) {
    const start = addDays(thisWeek, -7 * i);
    if (!since || addDays(start, 7) <= since) break;
    const week = await weekHours(siteId, start);
    const s = signed.get(week.week_of) || null;
    const { fingerprint: _fp, ...shown } = week;
    out.push({ ...shown, status: weekState(week, s), signoff: presentSignoff(s) && stripInternal(presentSignoff(s)) });
  }
  return out;
}

function stripInternal(s) {
  const { fingerprint: _fp, client_user_id: _c, responded_by: _r, ...rest } = s;
  return rest;
}

/** A week a client may answer for: a Monday, already over, within the look-back window. */
export function signableWeek(weekStart) {
  const start = parseDay(weekStart);
  if (!start || start.getDay() !== 1) return { error: 'Pick the Monday a week starts on.' };
  const thisWeek = mondayOf();
  if (start >= thisWeek) return { error: 'A week can only be signed off once it is over.' };
  if (start < addDays(thisWeek, -7 * SIGNOFF_WEEKS)) return { error: `Only the last ${SIGNOFF_WEEKS} weeks can be signed off here.` };
  return { start };
}

/** Every site's recent weeks for the office board, with counts of what needs attention. */
export async function signoffBoard(weeks = 4) {
  const sites = await db
    .prepare(
      `SELECT s.id, s.name, s.client_name,
              (SELECT COUNT(*) FROM client_sites cs JOIN client_users c ON c.id = cs.client_user_id
                WHERE cs.site_id = s.id AND c.status = 'active') AS contacts
       FROM sites s WHERE s.active ORDER BY s.name`
    )
    .all();
  const out = [];
  const counts = { waiting: 0, approved: 0, disputed: 0, changed: 0, not_ready: 0, no_contact: 0 };
  for (const site of sites) {
    const list = [];
    for (const w of await siteWeeks(site.id, weeks)) {
      const signoff = w.signoff ? await signoffRow(site.id, w.week_of) : null;
      // Nobody at the property has a portal login, so nobody can sign it off.
      const status = w.status === 'waiting' && !Number(site.contacts) ? 'no_contact' : w.status;
      const { fingerprint: _fp, ...shown } = signoff ? presentSignoff(signoff) : {};
      list.push({ ...w, status, signoff: signoff ? shown : null });
      if (counts[status] != null) counts[status]++;
    }
    out.push({ id: site.id, name: site.name, client_name: site.client_name, contacts: Number(site.contacts) || 0, weeks: list });
  }
  return { weeks, counts, sites: out };
}

export async function signoffRow(siteId, weekOf) {
  return db
    .prepare(
      `SELECT h.*, c.name AS client_name, s.name AS site_name, u.first_name || ' ' || u.last_name AS responded_by_name
       FROM hours_signoffs h JOIN sites s ON s.id = h.site_id
       LEFT JOIN client_users c ON c.id = h.client_user_id
       LEFT JOIN users u ON u.id = h.responded_by
       WHERE h.site_id = ? AND h.week_start = ?`
    )
    .get(siteId, weekOf);
}

/**
 * Sign-off of the weeks an invoice period touches, for the invoice preview:
 * each week's state, and whether every one of them is signed off as it stands.
 */
export async function periodSignoffs(siteId, start, endExclusive) {
  const weeks = [];
  for (let w = mondayOf(start); w < endExclusive; w = addDays(w, 7)) {
    if (addDays(w, 7) > mondayOf()) {
      weeks.push({ week_of: toDateString(w), status: 'in_progress' });
      continue;
    }
    const week = await weekHours(siteId, w);
    const s = await signoffRow(siteId, week.week_of);
    weeks.push({ week_of: week.week_of, hours: week.hours, status: weekState(week, s), note: s?.status === 'disputed' ? s.note : null });
  }
  const counted = weeks.filter((w) => w.status !== 'no_hours');
  return { weeks, allApproved: counted.length > 0 && counted.every((w) => w.status === 'approved') };
}

export { presentSignoff, hours as signoffHours };
