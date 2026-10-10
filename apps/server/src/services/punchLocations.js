/**
 * Correcting where a punch was made. A phone's reading can be wrong: GPS
 * drifting in a parking garage, a stale fix from before the officer arrived,
 * a phone that reported the cell tower. A supervisor or administrator who
 * knows where the officer really was (they saw them, the camera did, the
 * client called) puts the clock-in, clock-out or check-in where it was made.
 *
 * The punch is judged against its post again, so the punch log, scorecards
 * and site health all count the corrected place; the flag it raised is
 * closed when the punch is now inside the geofence, and raised (or reopened)
 * when a correction puts it outside. Every correction is kept with the place
 * before and after, who made it and why, so the phone's own reading is never
 * lost. Nobody corrects their own punches.
 */

import { db, audit } from '../lib/db.js';
import { HttpError, sqlToIso } from '../lib/http.js';
import { FLAG_TYPES, LOCATION_RULES, distanceMeters, evaluateGeofence } from '../shared.js';
import { raiseFlag } from './compliance.js';

export const PUNCH_FIX_KINDS = ['clock_in', 'clock_out', 'check_in'];

/** Which flag each kind of punch raises when it is made away from the post. */
const FLAG_FOR = {
  clock_in: { type: FLAG_TYPES.GEOFENCE_VIOLATION, refType: 'time_entry' },
  check_in: { type: FLAG_TYPES.CHECK_IN_AWAY, refType: 'status_check' },
};

const POST_COLS = `p.id AS post_id, p.name AS post_name, p.latitude AS post_lat, p.longitude AS post_lng, p.geofence_radius_m,
                   s.name AS site_name, u.first_name || ' ' || u.last_name AS officer, u.employee_code`;

/** One punch as it stands: where it was made, its post, and its verdict. */
export async function loadPunch(kind, id) {
  if (!PUNCH_FIX_KINDS.includes(kind)) throw new HttpError(404, 'That kind of punch has no location to correct.');
  let row;
  if (kind === 'check_in') {
    row = await db
      .prepare(
        `SELECT sc.id AS ref_id, sc.time_entry_id, sc.user_id, sc.status, sc.responded_at AS at,
                sc.latitude, sc.longitude, sc.accuracy, sc.geofence, sc.distance_m, ${POST_COLS}
         FROM status_checks sc JOIN time_entries te ON te.id = sc.time_entry_id
         JOIN posts p ON p.id = te.post_id JOIN sites s ON s.id = p.site_id JOIN users u ON u.id = sc.user_id
         WHERE sc.id = ?`
      )
      .get(id);
    if (row && !['ok', 'late'].includes(row.status)) throw new HttpError(409, 'Only an answered check-in has a location to correct.');
  } else {
    const c = kind === 'clock_in' ? 'clock_in' : 'clock_out';
    row = await db
      .prepare(
        `SELECT te.id AS ref_id, te.id AS time_entry_id, te.user_id, te.${c}_at AS at,
                te.${c}_lat AS latitude, te.${c}_lng AS longitude, te.${c}_accuracy AS accuracy,
                te.${c}_geofence AS geofence, te.${c}_distance_m AS distance_m, ${POST_COLS}
         FROM time_entries te JOIN posts p ON p.id = te.post_id JOIN sites s ON s.id = p.site_id JOIN users u ON u.id = te.user_id
         WHERE te.id = ?`
      )
      .get(id);
    if (row && kind === 'clock_out' && !row.at) throw new HttpError(409, 'This shift has not been clocked out yet.');
  }
  if (!row) throw new HttpError(404, 'Punch not found.');
  return {
    kind,
    id: row.ref_id,
    time_entry_id: row.time_entry_id,
    user_id: row.user_id,
    officer: row.officer,
    employee_code: row.employee_code,
    at: sqlToIso(row.at),
    site_name: row.site_name,
    post: { id: row.post_id, name: row.post_name, latitude: row.post_lat, longitude: row.post_lng, radius_m: row.geofence_radius_m },
    location: {
      latitude: row.latitude,
      longitude: row.longitude,
      accuracy: row.accuracy,
      geofence: row.geofence,
      distance_m: row.distance_m,
    },
  };
}

/** Every correction to these time entries' punches, oldest first, with who made it. */
export async function fixesForEntries(entryIds) {
  if (!entryIds.length) return [];
  const rows = await db
    .prepare(
      `SELECT f.*, u.first_name || ' ' || u.last_name AS fixed_by_name
       FROM punch_location_fixes f LEFT JOIN users u ON u.id = f.fixed_by
       WHERE f.time_entry_id = ANY(?::int[]) ORDER BY f.fixed_at, f.id`
    )
    .all(`{${[...new Set(entryIds)].join(',')}}`);
  return rows.map((f) => ({ ...f, fixed_at: sqlToIso(f.fixed_at) }));
}

/** The key a punch's corrections are filed under: the check-in's own id, or the entry's. */
export const fixKey = (kind, id) => `${kind}-${id}`;
const keyOf = (f) => fixKey(f.kind, f.kind === 'check_in' ? f.status_check_id : f.time_entry_id);

/** Corrections grouped by punch, each with what the phone first reported. */
export function groupFixes(fixes) {
  const out = new Map();
  for (const f of fixes) {
    const k = keyOf(f);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(f);
  }
  return out;
}

/** A punch's correction history as the screens show it. */
export function fixSummary(list) {
  if (!list?.length) return null;
  const first = list[0];
  const last = list[list.length - 1];
  return {
    count: list.length,
    by: last.fixed_by_name,
    at: last.fixed_at,
    reason: last.reason,
    original: {
      latitude: first.from_lat,
      longitude: first.from_lng,
      accuracy: first.from_accuracy,
      geofence: first.from_geofence,
      distance_m: first.from_distance_m,
    },
  };
}

/**
 * Put a punch where it was really made. `place` is { latitude, longitude },
 * or { atPost: true } for the post's own pin. Returns the punch as it now
 * stands, the correction, and what happened to its flag.
 */
export async function fixPunchLocation({ kind, id, place, reason, by, ip }) {
  const punch = await loadPunch(kind, id);
  if (Number(punch.user_id) === Number(by)) throw new HttpError(403, 'You cannot correct the location of your own punches. Ask another supervisor or an administrator.');
  const post = { latitude: punch.post.latitude, longitude: punch.post.longitude, geofence_radius_m: punch.post.radius_m };
  let latitude = place.latitude;
  let longitude = place.longitude;
  if (place.atPost) {
    if (post.latitude == null) throw new HttpError(409, `${punch.post.name} has no pin to put the punch on. Set the post's location first.`);
    latitude = post.latitude;
    longitude = post.longitude;
  }
  latitude = Number(Number(latitude).toFixed(6));
  longitude = Number(Number(longitude).toFixed(6));
  const was = punch.location;
  if (was.latitude === latitude && was.longitude === longitude) throw new HttpError(409, 'That is where the punch already is.');
  // A slip of the keyboard (a sign dropped, latitude and longitude swapped)
  // lands hundreds of miles off; nobody punches that far from their post.
  if (post.latitude != null) {
    const far = distanceMeters(latitude, longitude, post.latitude, post.longitude);
    if (far > LOCATION_RULES.fixMaxFromPostM) {
      throw new HttpError(422, `That is ${Math.round(far / 1609)} miles from ${punch.post.name}. Check the coordinates: latitude first, then longitude.`);
    }
  }

  // Placed by a person who knows where it was, not read off a phone: no
  // accuracy to discount it by.
  const fence = evaluateGeofence({ lat: latitude, lng: longitude, accuracy: null, post });
  const distance = fence.distance == null ? null : Math.round(fence.distance);

  await db.transaction(async () => {
    if (kind === 'check_in') {
      await db
        .prepare(`UPDATE status_checks SET latitude = ?, longitude = ?, accuracy = NULL, geofence = ?, distance_m = ? WHERE id = ?`)
        .run(latitude, longitude, fence.status, distance, punch.id);
    } else {
      const c = kind === 'clock_in' ? 'clock_in' : 'clock_out';
      await db
        .prepare(`UPDATE time_entries SET ${c}_lat = ?, ${c}_lng = ?, ${c}_accuracy = NULL, ${c}_geofence = ?, ${c}_distance_m = ? WHERE id = ?`)
        .run(latitude, longitude, fence.status, distance, punch.id);
    }
    await db
      .prepare(
        `INSERT INTO punch_location_fixes
         (kind, time_entry_id, status_check_id, user_id, from_lat, from_lng, from_accuracy, from_geofence, from_distance_m,
          to_lat, to_lng, to_geofence, to_distance_m, reason, fixed_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        kind, punch.time_entry_id, kind === 'check_in' ? punch.id : null, punch.user_id,
        was.latitude, was.longitude, was.accuracy, was.geofence, was.distance_m,
        latitude, longitude, fence.status, distance, reason, by
      );
  })();

  const flag = await settleFlag({ kind, punch, fence, distance, reason, by });
  await audit(by, 'punch.location_fixed', kind === 'check_in' ? 'status_check' : 'time_entry', punch.id, {
    kind, from: [was.latitude, was.longitude], to: [latitude, longitude], geofence: fence.status, reason, flag: flag?.action ?? null,
  }, ip);

  return {
    punch: { ...(await loadPunch(kind, id)), radius_m: fence.radius ?? punch.post.radius_m },
    flag,
  };
}

/**
 * The flag that goes with the punch's place. Inside the geofence now: an open
 * one is closed, saying it was corrected. Outside now: one is raised, or a
 * closed one reopened, or an open one brought up to date. A clock-out raises
 * no flag of its own.
 */
async function settleFlag({ kind, punch, fence, distance, reason, by }) {
  const spec = FLAG_FOR[kind];
  if (!spec) return null;
  const existing = await db
    .prepare(`SELECT id, resolved_at, detail FROM flags WHERE type = ? AND ref_type = ? AND ref_id = ?`)
    .get(spec.type, spec.refType, punch.id);
  const detailOf = (f) => (typeof f?.detail === 'string' ? JSON.parse(f.detail) : f?.detail) || {};

  if (fence.status === 'inside') {
    if (!existing || existing.resolved_at) return { action: existing ? 'already_closed' : 'none' };
    await db
      .prepare(`UPDATE flags SET resolved_at = datetime('now'), resolved_by = ?, resolution_note = ? WHERE id = ?`)
      .run(by, `Location corrected to the post: ${reason}`, existing.id);
    return { action: 'closed', id: existing.id };
  }
  if (fence.status !== 'outside') return { action: 'none' };

  const detail = { distance_m: distance, radius_m: fence.radius, accuracy: null, post: punch.post.name, corrected: true, reason };
  if (!existing) {
    await raiseFlag({ userId: punch.user_id, type: spec.type, occurredAt: new Date(punch.at), refType: spec.refType, refId: punch.id, detail });
    const raised = await db.prepare(`SELECT id FROM flags WHERE type = ? AND ref_type = ? AND ref_id = ?`).get(spec.type, spec.refType, punch.id);
    return { action: 'raised', id: raised?.id ?? null };
  }
  await db
    .prepare(`UPDATE flags SET detail = ?, resolved_at = NULL, resolved_by = NULL, resolution_note = NULL WHERE id = ?`)
    .run(JSON.stringify({ ...detailOf(existing), ...detail }), existing.id);
  return { action: existing.resolved_at ? 'reopened' : 'updated', id: existing.id };
}

