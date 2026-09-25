/**
 * Location tracking while on duty.
 *
 * A clock-in proves where an officer was at one moment. The pings recorded
 * here are the rest of the shift: the device reports every minute or so, each
 * report is judged against the post being worked, and walking out of the
 * geofence raises a flag once - on the way out, not on every ping while out.
 */

import { db } from '../lib/db.js';
import { RULES, FLAG_TYPES, locationOffset } from '../shared.js';
import { toSql, raiseFlag } from './compliance.js';

// The test suite shortens this so it can exercise thinning without waiting.
const minGapMs = () => Number(process.env.USC_MIN_PING_GAP_SECONDS ?? RULES.minPingGapSeconds) * 1000;

/**
 * Store one position against an open time entry and judge it.
 *
 * `entry` must carry the post's coordinates (post_lat/post_lng/radius) or a
 * `post` row. Returns null when a routine report arrived too soon after the
 * last one to be worth keeping.
 */
export async function recordPing({
  userId,
  entry,
  post,
  latitude,
  longitude,
  accuracy = null,
  speed = null,
  heading = null,
  source = 'watch',
  at = new Date(),
}) {
  if (latitude == null || longitude == null) return null;

  const target = post || (await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(entry.post_id));
  const offset = locationOffset({ lat: latitude, lng: longitude, accuracy, post: target });

  const previous = await db
    .prepare(
      `SELECT id, recorded_at, geofence FROM location_pings
       WHERE user_id = ? AND time_entry_id = ?
       ORDER BY recorded_at DESC LIMIT 1`
    )
    .get(userId, entry.id);

  // A phone left on the watch screen will report far more often than anyone
  // needs. Clock events are always kept; routine reports are thinned.
  if (
    source === 'watch' &&
    previous &&
    at.getTime() - new Date(previous.recorded_at).getTime() < minGapMs()
  ) {
    return { stored: false, offset };
  }

  const info = await db
    .prepare(
      `INSERT INTO location_pings
       (user_id, time_entry_id, post_id, recorded_at, latitude, longitude, accuracy,
        speed_mps, heading, source, geofence, distance_m)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      userId,
      entry.id,
      target?.id ?? entry.post_id,
      toSql(at),
      latitude,
      longitude,
      accuracy,
      speed,
      heading,
      source,
      offset.status,
      offset.distance ?? null
    );
  const pingId = Number(info.lastInsertRowid);

  // Crossing out of the fence is the event; staying out is not a new one.
  // Clock events are judged elsewhere: a clock-in from outside is already a
  // geofence violation, and leaving at clock-out is the point of clocking out.
  const wasInside = !previous || previous.geofence !== 'outside';
  if (offset.status === 'outside' && wasInside && source !== 'clock_out' && source !== 'clock_in') {
    await raiseFlag({
      userId,
      type: FLAG_TYPES.OFF_POST,
      occurredAt: at,
      refType: 'location_ping',
      refId: pingId,
      detail: {
        distance_m: offset.distance,
        radius_m: offset.radius,
        heading_back: offset.heading,
        time_entry_id: entry.id,
      },
    });
  }

  return { stored: true, id: pingId, offset };
}

/** Delete location history past the retention window. Called by the sweep. */
export async function pruneLocationPings(now = new Date()) {
  const cutoff = new Date(now.getTime() - RULES.locationRetentionDays * 86400000);
  const res = await db.prepare(`DELETE FROM location_pings WHERE recorded_at < ?`).run(toSql(cutoff));
  return res?.changes ?? 0;
}
