/**
 * Shift handovers: the moment a post goes from one officer to the next.
 *
 * For every officer on duty whose shift ends within the window (or has
 * already ended - they are held over), find the shift that follows at the
 * same post and say where that relief stands: on post, confirmed, not
 * confirmed, late, or not assigned at all. A post with no shift after it
 * closes, and the officer simply leaves. A shift the same officer works
 * straight after is not a handover.
 */

import { db } from '../lib/db.js';
import { isoFields } from '../lib/http.js';
import { toSql } from './compliance.js';
import { isConfirmed } from './confirmations.js';
import { HANDOVER_WINDOW_MINUTES, HANDOVER_STATES, HANDOVER_STATE_LABEL, handoverState, handoverSeverity } from '../shared.js';

const MIN = 60000;
// The relief shift starts at the handover, give or take this much.
const MATCH_MINUTES = 60;

/** The shift that follows `shift` at its post, with whether its officer is on and confirmed. */
async function reliefFor(shift) {
  const row = await db
    .prepare(
      `SELECT n.id, n.user_id, n.post_id, n.starts_at, n.ends_at, n.status, n.confirmed_at, n.confirmed_key, n.relief_chased_at,
              u.first_name || ' ' || u.last_name AS officer, u.phone, u.employee_code,
              (SELECT te.clock_in_at FROM time_entries te
                WHERE te.user_id = n.user_id AND te.post_id = n.post_id AND te.clock_out_at IS NULL
                ORDER BY te.clock_in_at DESC LIMIT 1) AS clocked_in_at
       FROM shifts n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.post_id = ? AND n.id != ? AND n.status != 'cancelled'
         AND n.starts_at BETWEEN ?::timestamptz - interval '${MATCH_MINUTES} minutes' AND ?::timestamptz + interval '${MATCH_MINUTES} minutes'
       ORDER BY abs(EXTRACT(EPOCH FROM (n.starts_at - ?::timestamptz))) LIMIT 1`
    )
    .get(shift.post_id, shift.id, shift.ends_at, shift.ends_at, shift.ends_at);
  if (!row) return null;
  // A confirmation counts only while the shift is still the one confirmed.
  const confirmed = isConfirmed(row);
  const r = isoFields(row, ['starts_at', 'ends_at', 'confirmed_at', 'relief_chased_at', 'clocked_in_at']);
  return { ...r, clocked_in: Boolean(r.clocked_in_at), confirmed };
}

/** Every handover in the window, worst first. */
export async function handovers({ windowMinutes = HANDOVER_WINDOW_MINUTES, now = new Date() } = {}) {
  const rows = await db
    .prepare(
      `SELECT te.id AS entry_id, te.user_id, te.clock_in_at, sh.id, sh.post_id, sh.starts_at, sh.ends_at,
              u.first_name || ' ' || u.last_name AS officer, u.phone, u.employee_code,
              p.name AS post_name, s.name AS site_name, s.id AS site_id
       FROM time_entries te
       JOIN shifts sh ON sh.id = te.shift_id
       JOIN users u ON u.id = te.user_id
       JOIN posts p ON p.id = te.post_id
       JOIN sites s ON s.id = p.site_id
       WHERE te.clock_out_at IS NULL AND sh.ends_at <= ?
       ORDER BY sh.ends_at`
    )
    .all(toSql(new Date(now.getTime() + windowMinutes * MIN)));

  const list = [];
  for (const row of rows) {
    const out = isoFields(row, ['clock_in_at', 'starts_at', 'ends_at']);
    const relief = await reliefFor(row);
    if (relief && relief.user_id === out.user_id) continue; // working straight on: no handover
    const state = handoverState({ outgoing: out, relief, now });
    const minutesToEnd = Math.round((new Date(out.ends_at).getTime() - now.getTime()) / MIN);
    list.push({
      shift_id: out.id,
      entry_id: out.entry_id,
      user_id: out.user_id,
      officer: out.officer,
      phone: out.phone,
      employee_code: out.employee_code,
      post_id: out.post_id,
      post_name: out.post_name,
      site_id: out.site_id,
      site_name: out.site_name,
      ends_at: out.ends_at,
      minutes_to_end: minutesToEnd,
      held_over_minutes: Math.max(0, -minutesToEnd),
      state,
      state_label: HANDOVER_STATE_LABEL[state],
      severity: handoverSeverity(state, minutesToEnd),
      relief: relief && {
        shift_id: relief.id,
        user_id: relief.user_id,
        officer: relief.officer,
        phone: relief.phone,
        employee_code: relief.employee_code,
        starts_at: relief.starts_at,
        confirmed: relief.confirmed,
        clocked_in_at: relief.clocked_in_at,
        chased_at: relief.relief_chased_at,
        minutes_late: relief.user_id && !relief.clocked_in
          ? Math.max(0, Math.round((now.getTime() - new Date(relief.starts_at).getTime()) / MIN))
          : 0,
      },
    });
  }
  const rank = (h) => HANDOVER_STATES.indexOf(h.state);
  list.sort((a, b) => rank(a) - rank(b) || new Date(a.ends_at) - new Date(b.ends_at));
  const count = (st) => list.filter((h) => h.state === st).length;
  return {
    window_minutes: windowMinutes,
    handovers: list,
    counts: {
      total: list.length,
      at_risk: list.filter((h) => ['critical', 'warning'].includes(h.severity)).length,
      held_over: list.filter((h) => h.held_over_minutes > 0 && h.state !== 'relieved').length,
      ...Object.fromEntries(HANDOVER_STATES.map((st) => [st, count(st)])),
    },
  };
}

/**
 * The handovers one officer is part of: theirs going off post, and the one
 * they are coming on to relieve. Phone numbers stay with the office.
 */
export async function myHandovers(userId, now = new Date()) {
  const { handovers: all } = await handovers({ now });
  const strip = ({ phone, relief, ...h }) => ({ ...h, relief: relief && { ...relief, phone: undefined } });
  const outgoing = all.find((h) => h.user_id === userId) || null;
  const incoming = all.find((h) => h.relief?.user_id === userId && !h.relief.clocked_in_at) || null;
  return { outgoing: outgoing && strip(outgoing), incoming: incoming && strip(incoming) };
}
