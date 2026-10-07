/**
 * Rest and fatigue: the shared rule (fatigueIssues) applied to the roster.
 *
 * A shift is judged against the officer's other shifts as worked, not as
 * scheduled: one they were held over on ends when they clocked out, or now if
 * they are still on post. So a late relief who keeps someone on two extra
 * hours shows up as a short rest before that officer's next shift.
 */

import { db } from '../lib/db.js';
import { isoFields, sqlToIso } from '../lib/http.js';
import { toSql } from './compliance.js';
import { fatigueIssues, FATIGUE_CODES, FATIGUE_LABEL } from '../shared.js';

const DAY = 86400000;
// Far enough either side of a shift to see a run of days in a row.
const AROUND_DAYS = 8;

/**
 * Every officer's shifts between `from` and `to` as worked, keyed by user.
 * Cancelled and missed shifts were not worked and do not count.
 */
export async function shiftsAsWorked({ from, to, userId = null, now = new Date() }) {
  const rows = await db
    .prepare(
      `SELECT sh.id, sh.user_id, sh.starts_at, sh.ends_at,
              MAX(te.clock_out_at) AS clocked_out_at,
              SUM(CASE WHEN te.id IS NOT NULL AND te.clock_out_at IS NULL THEN 1 ELSE 0 END) AS open_entries
       FROM shifts sh
       LEFT JOIN time_entries te ON te.shift_id = sh.id
       WHERE sh.user_id IS NOT NULL AND sh.status NOT IN ('cancelled', 'missed')
         AND sh.ends_at > ? AND sh.starts_at < ? ${userId ? 'AND sh.user_id = ?' : ''}
       GROUP BY sh.id, sh.user_id, sh.starts_at, sh.ends_at`
    )
    .all(...[toSql(from), toSql(to), ...(userId ? [userId] : [])]);
  const byUser = new Map();
  for (const r of rows) {
    const scheduledEnd = new Date(sqlToIso(r.ends_at));
    let worked = scheduledEnd;
    if (Number(r.open_entries) > 0 && now > scheduledEnd) worked = now; // held over, still on
    else if (r.clocked_out_at && new Date(sqlToIso(r.clocked_out_at)) > scheduledEnd) worked = new Date(sqlToIso(r.clocked_out_at));
    const list = byUser.get(r.user_id) || [];
    list.push({ id: r.id, starts_at: sqlToIso(r.starts_at), ends_at: worked.toISOString(), held_over: worked > scheduledEnd });
    byUser.set(r.user_id, list);
  }
  return byUser;
}

/** The fatigue reasons for one officer working one shift: for claims, swaps and assignments. */
export async function fatigueFor(userId, { startsAt, endsAt, excludeShiftId = 0, now = new Date() }) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const mine = (await shiftsAsWorked({ from: new Date(start - AROUND_DAYS * DAY), to: new Date(+end + AROUND_DAYS * DAY), userId, now })).get(userId) || [];
  return fatigueIssues({ startsAt: start, endsAt: end, others: mine.filter((s) => s.id !== excludeShiftId) });
}

/** The same for everybody at once, for ranking the candidates for a shift. */
export async function fatigueForAll({ startsAt, endsAt, excludeShiftId = 0, now = new Date() }) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const all = await shiftsAsWorked({ from: new Date(start - AROUND_DAYS * DAY), to: new Date(+end + AROUND_DAYS * DAY), now });
  return (userId) =>
    fatigueIssues({ startsAt: start, endsAt: end, others: (all.get(userId) || []).filter((s) => s.id !== excludeShiftId) });
}

/**
 * Shifts on the roster in the next `days` that break a rest or fatigue rule,
 * each listed once, on the shift that tips it (the rule's look-back mode).
 */
export async function fatigueBoard({ days = 7, now = new Date() } = {}) {
  const until = new Date(now.getTime() + days * DAY);
  const shifts = (
    await db
      .prepare(
        `SELECT sh.id, sh.user_id, sh.post_id, sh.starts_at, sh.ends_at, sh.status,
                u.first_name || ' ' || u.last_name AS officer, u.employee_code, u.role,
                p.name AS post_name, s.name AS site_name
         FROM shifts sh
         JOIN users u ON u.id = sh.user_id
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE sh.status = 'scheduled' AND sh.starts_at >= ? AND sh.starts_at < ?
         ORDER BY sh.starts_at`
      )
      .all(toSql(now), toSql(until))
  ).map((r) => isoFields(r, ['starts_at', 'ends_at']));
  const worked = await shiftsAsWorked({ from: new Date(now - AROUND_DAYS * DAY), to: new Date(+until + AROUND_DAYS * DAY), now });

  const list = [];
  for (const sh of shifts) {
    const mine = worked.get(sh.user_id) || [];
    const others = mine.filter((x) => x.id !== sh.id);
    const issues = fatigueIssues({ startsAt: sh.starts_at, endsAt: sh.ends_at, others, lookBack: true });
    if (!issues.length) continue;
    const prev = others.filter((x) => new Date(x.ends_at) <= new Date(sh.starts_at)).sort((a, b) => new Date(b.ends_at) - new Date(a.ends_at))[0];
    list.push({
      shift_id: sh.id,
      user_id: sh.user_id,
      officer: sh.officer,
      employee_code: sh.employee_code,
      role: sh.role,
      post_name: sh.post_name,
      site_name: sh.site_name,
      starts_at: sh.starts_at,
      ends_at: sh.ends_at,
      hours_away: Math.round(((new Date(sh.starts_at) - now) / 3600000) * 10) / 10,
      previous: prev ? { shift_id: prev.id, ends_at: prev.ends_at, held_over: prev.held_over } : null,
      issues: issues.map(({ code, message }) => ({ code, label: FATIGUE_LABEL[code], message })),
    });
  }
  const counts = Object.fromEntries(FATIGUE_CODES.map((c) => [c, list.filter((x) => x.issues.some((i) => i.code === c)).length]));
  return { days, shifts: list, counts: { total: list.length, soon: list.filter((x) => x.hours_away <= 24).length, ...counts } };
}
