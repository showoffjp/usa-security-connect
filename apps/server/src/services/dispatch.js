/**
 * Calls for service.
 *
 * A call is raised (by the office, or by a client from the portal), sent to an
 * officer who is on duty, acknowledged, attended and cleared. Each step is a
 * timestamp on the call and a line in its event log, so the response time is
 * measured rather than remembered, and a call that nobody has picked up is
 * visible to every supervisor until somebody does.
 */

import { db } from '../lib/db.js';
import { isoFields, sqlToIso } from '../lib/http.js';
import {
  distanceMeters,
  CALL_TYPE_LABEL,
  CALL_PRIORITY_LABEL,
  CALL_STATUS_LABEL,
  CALL_DISPOSITION_LABEL,
  CALL_TARGET_MINUTES,
  OPEN_CALL_STATUSES,
} from '../shared.js';
import { toSql } from './compliance.js';
import { pushAsync, supervisorIds } from './push.js';

export const CALL_TIMES = ['assigned_at', 'acknowledged_at', 'arrived_at', 'cleared_at', 'cancelled_at', 'created_at'];
export const OPEN_SQL = OPEN_CALL_STATUSES.map((s) => `'${s}'`).join(',');

export const callSelect = `
  SELECT c.*, s.name AS site_name, s.client_name, s.address, s.city, s.latitude AS site_lat, s.longitude AS site_lng,
         p.name AS post_name,
         o.first_name AS officer_first, o.last_name AS officer_last, o.phone AS officer_phone,
         cu.name AS client_contact, cu.company AS client_company,
         cb.first_name || ' ' || cb.last_name AS created_by_name,
         ab.first_name || ' ' || ab.last_name AS assigned_by_name
  FROM service_calls c
  JOIN sites s ON s.id = c.site_id
  LEFT JOIN posts p ON p.id = c.post_id
  LEFT JOIN users o ON o.id = c.assigned_to
  LEFT JOIN client_users cu ON cu.id = c.client_user_id
  LEFT JOIN users cb ON cb.id = c.created_by
  LEFT JOIN users ab ON ab.id = c.assigned_by`;

export async function loadCall(id) {
  return db.prepare(`${callSelect} WHERE c.id = ?`).get(Number(id));
}

const minutesBetween = (a, b) =>
  a && b ? Math.max(0, Math.round((new Date(sqlToIso(b)) - new Date(sqlToIso(a))) / 60000)) : null;

/** How long the call took at each stage, in whole minutes; null where a stage has not happened. */
export function timings(c, now = new Date()) {
  const created = sqlToIso(c.created_at);
  const open = OPEN_CALL_STATUSES.includes(c.status);
  const toArrive = minutesBetween(created, c.arrived_at);
  const target = CALL_TARGET_MINUTES[c.priority] ?? null;
  return {
    toAssign: minutesBetween(created, c.assigned_at),
    toAcknowledge: minutesBetween(c.assigned_at, c.acknowledged_at),
    toArrive,
    onScene: minutesBetween(c.arrived_at, c.cleared_at),
    // How long it has been going on, for a call still open.
    elapsed: open ? minutesBetween(created, now.toISOString()) : minutesBetween(created, c.cleared_at || c.cancelled_at),
    target,
    // Still waiting for an officer to arrive and already past the target.
    late: target != null && !c.arrived_at && open && minutesBetween(created, now.toISOString()) > target,
    withinTarget: toArrive == null || target == null ? null : toArrive <= target,
  };
}

/** A call as staff see it. */
export function presentCall(c, now = new Date()) {
  const out = isoFields(c, CALL_TIMES);
  delete out.site_lat;
  delete out.site_lng;
  out.officer_name = c.officer_first ? `${c.officer_first} ${c.officer_last}` : null;
  out.type_label = CALL_TYPE_LABEL[c.call_type] || c.call_type;
  out.priority_label = CALL_PRIORITY_LABEL[c.priority] || String(c.priority);
  out.status_label = CALL_STATUS_LABEL[c.status] || c.status;
  out.disposition_label = c.disposition ? CALL_DISPOSITION_LABEL[c.disposition] || c.disposition : null;
  out.open = OPEN_CALL_STATUSES.includes(c.status);
  out.timings = timings(c, now);
  return out;
}

/**
 * A call as a client sees it: their own property's call and what came of it.
 * No internal log, no officer phone number, no note about who turned it down.
 */
export function presentCallForClient(c, now = new Date()) {
  const t = timings(c, now);
  return {
    id: c.id,
    site_id: c.site_id,
    site_name: c.site_name,
    post_name: c.post_name,
    call_type: c.call_type,
    type_label: CALL_TYPE_LABEL[c.call_type] || c.call_type,
    priority: c.priority,
    priority_label: CALL_PRIORITY_LABEL[c.priority] || String(c.priority),
    location: c.location,
    description: c.description,
    caller_name: c.caller_name,
    source: c.source,
    raised_by_you: Boolean(c.client_user_id),
    status: c.status,
    status_label: CALL_STATUS_LABEL[c.status] || c.status,
    open: OPEN_CALL_STATUSES.includes(c.status),
    officer: c.officer_first ? `${c.officer_first} ${String(c.officer_last || '').slice(0, 1)}.` : null,
    disposition_label: c.disposition ? CALL_DISPOSITION_LABEL[c.disposition] || c.disposition : null,
    outcome: c.outcome,
    cancel_reason: c.cancel_reason,
    ...isoFields(
      {
        created_at: c.created_at, assigned_at: c.assigned_at, acknowledged_at: c.acknowledged_at,
        arrived_at: c.arrived_at, cleared_at: c.cleared_at, cancelled_at: c.cancelled_at,
      },
      CALL_TIMES
    ),
    minutes_to_arrive: t.toArrive,
    target_minutes: t.target,
  };
}

export async function logEvent(callId, kind, { userId = null, clientUserId = null, note = null, at = null } = {}) {
  await db
    .prepare(`INSERT INTO service_call_events (call_id, kind, user_id, client_user_id, note, created_at) VALUES (?,?,?,?,?,?)`)
    .run(callId, kind, userId, clientUserId, note, toSql(at || new Date()));
}

export async function eventsFor(callId) {
  const rows = await db
    .prepare(
      `SELECT e.*, u.first_name || ' ' || u.last_name AS user_name, cu.name AS client_name
       FROM service_call_events e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN client_users cu ON cu.id = e.client_user_id
       WHERE e.call_id = ? ORDER BY e.created_at, e.id`
    )
    .all(callId);
  return rows.map((r) => isoFields(r, ['created_at']));
}

/** The open time entry an officer is working, with the post's site. Null when off duty. */
export async function onDutyEntry(userId) {
  return db
    .prepare(
      `SELECT te.id, te.post_id, p.site_id FROM time_entries te JOIN posts p ON p.id = te.post_id
       WHERE te.user_id = ? AND te.clock_out_at IS NULL ORDER BY te.clock_in_at DESC LIMIT 1`
    )
    .get(userId);
}

/**
 * Who could take this call: everyone on the clock, nearest first. Somebody
 * already on this property comes first; somebody on a break or already on
 * another call is listed but marked, because a supervisor may still want them.
 */
export async function candidatesFor(call) {
  const rows = await db
    .prepare(
      `SELECT u.id, u.first_name, u.last_name, u.phone, u.license_type,
              te.id AS entry_id, te.clock_in_at, p.id AS post_id, p.name AS post_name, p.latitude AS post_lat, p.longitude AS post_lng,
              s.id AS site_id, s.name AS site_name,
              (SELECT b.type FROM breaks b WHERE b.user_id = u.id AND b.ended_at IS NULL LIMIT 1) AS on_break,
              (SELECT COUNT(*) FROM service_calls sc WHERE sc.assigned_to = u.id AND sc.id <> ? AND sc.status IN (${OPEN_SQL})) AS other_calls
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       JOIN posts p ON p.id = te.post_id
       JOIN sites s ON s.id = p.site_id
       WHERE te.clock_out_at IS NULL AND u.status = 'active'`
    )
    .all(call.id);

  const pings = await db
    .prepare(
      `SELECT DISTINCT ON (lp.user_id) lp.user_id, lp.latitude, lp.longitude, lp.recorded_at
       FROM location_pings lp JOIN time_entries te ON te.id = lp.time_entry_id AND te.clock_out_at IS NULL
       ORDER BY lp.user_id, lp.recorded_at DESC`
    )
    .all();
  const pingBy = new Map(pings.map((p) => [p.user_id, p]));

  // The call's own position: its post if it names one, else the site.
  let target = null;
  if (call.post_id) {
    const p = await db.prepare(`SELECT latitude, longitude FROM posts WHERE id = ?`).get(call.post_id);
    if (p?.latitude != null) target = [p.latitude, p.longitude];
  }
  if (!target) {
    const s = await db.prepare(`SELECT latitude, longitude FROM sites WHERE id = ?`).get(call.site_id);
    if (s?.latitude != null) target = [s.latitude, s.longitude];
  }

  const list = rows.map((r) => {
    const ping = pingBy.get(r.id);
    const from = ping ? [ping.latitude, ping.longitude] : r.post_lat != null ? [r.post_lat, r.post_lng] : null;
    const metres = target && from ? distanceMeters(from[0], from[1], target[0], target[1]) : null;
    return {
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      phone: r.phone,
      armed: /class g/i.test(r.license_type || ''),
      site_id: r.site_id,
      site_name: r.site_name,
      post_name: r.post_name,
      same_site: r.site_id === call.site_id,
      distance_km: metres == null ? null : Math.round(metres / 100) / 10,
      position_from: ping ? 'gps' : from ? 'post' : null,
      on_break: r.on_break || null,
      busy: Number(r.other_calls) > 0,
      assigned: r.id === call.assigned_to,
    };
  });
  return list.sort(
    (a, b) =>
      Number(b.same_site) - Number(a.same_site) ||
      Number(a.busy) - Number(b.busy) ||
      Number(Boolean(a.on_break)) - Number(Boolean(b.on_break)) ||
      (a.distance_km ?? 9999) - (b.distance_km ?? 9999) ||
      a.name.localeCompare(b.name)
  );
}

/** Tell the officer a call is theirs. Fire and forget, like every push. */
export function pushToOfficer(call, userId) {
  pushAsync([userId], {
    title: `${CALL_PRIORITY_LABEL[call.priority] || 'Call'}: ${CALL_TYPE_LABEL[call.call_type] || call.call_type}`,
    body: [call.site_name, call.location, call.description].filter(Boolean).join(' · ').slice(0, 160),
    data: { type: 'call', id: call.id },
    priority: call.priority <= 2 ? 'high' : 'default',
  });
}

/** Tell the supervisors a call is waiting. */
export async function pushToSupervisors(call, title) {
  pushAsync(await supervisorIds(), {
    title,
    body: [call.site_name, CALL_TYPE_LABEL[call.call_type], call.description].filter(Boolean).join(' · ').slice(0, 160),
    data: { type: 'call', id: call.id },
    priority: call.priority <= 2 ? 'high' : 'default',
  });
}

/**
 * An officer clocking out cannot keep a call. Anything they were holding and
 * had not cleared goes back on the board for somebody else, and says why.
 */
export async function releaseCallsOnClockOut(userId, at = new Date()) {
  const held = await db
    .prepare(`SELECT id FROM service_calls WHERE assigned_to = ? AND status IN (${OPEN_SQL})`)
    .all(userId);
  for (const c of held) {
    await db
      .prepare(
        `UPDATE service_calls SET status = 'open', assigned_to = NULL, assigned_by = NULL, assigned_at = NULL,
                acknowledged_at = NULL, arrived_at = NULL WHERE id = ?`
      )
      .run(c.id);
    await logEvent(c.id, 'returned', { userId, note: 'The officer clocked out before clearing it.', at });
  }
  if (held.length) {
    const first = await loadCall(held[0].id);
    await pushToSupervisors(first, held.length === 1 ? 'A call is back on the board' : `${held.length} calls are back on the board`);
  }
  return held.length;
}
