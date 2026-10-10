/**
 * How the demo's pins were set, and where its officers checked in from:
 *
 *  - every site was placed from its street address, geocoded to the building
 *    where OpenStreetMap has it and to the US Census address range where it
 *    does not, and those answers are cached so the location check needs no
 *    lookups on a demo server;
 *  - a supervisor has stood at almost every post and set its pin from their
 *    phone, with a fix good to a few metres; one post was dropped on the map;
 *  - every check-in answered is judged against its post like a clock-in, and
 *    one officer answered a check-in this morning from about 400 m away, which
 *    raised a flag.
 */

import { toSql, raiseFlag } from './services/compliance.js';
import { rememberGeocode } from './services/geocode.js';
import { siteAddress, postAddress } from './services/locations.js';
import { evaluateGeofence } from './shared.js';
import { offsetM } from './seed-demo.js';

const HOUR = 3600000;
const SUITE_PEOPLE = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008'];

/** What the geocoders said for each street address, as they said it. */
const FOUND = {
  '1200 Riverside Ave': ['building', 'openstreetmap', '1200, Riverside Avenue, Jacksonville, Duval County, Florida, 32204, United States'],
  '8000 Via Dellagio Way': ['building', 'openstreetmap', '8000, Via Dellagio Way, Dellagio, Orlando, Orange County, Florida, 32819, United States'],
  '2101 Maritime Blvd': ['building', 'openstreetmap', '2101, Maritime Boulevard, Palmetto Beach, Tampa, Hillsborough County, Florida, 33605, United States'],
  '2414 E Sunrise Blvd': ['building', 'openstreetmap', 'The Galleria at Fort Lauderdale, 2414, East Sunrise Boulevard, Fort Lauderdale, Broward County, Florida, 33304, United States'],
  '1611 NW 12th Ave': ['building', 'openstreetmap', 'Jackson Memorial Hospital, 1611, Northwest 12th Avenue, Miami, Miami-Dade County, Florida, 33136, United States'],
  '300 Bayshore Dr NE': ['street', 'census', '300 BAY SHORE DR NE, ST PETERSBURG, FL, 33701'],
  '215 S Monroe St': ['building', 'openstreetmap', '215, South Monroe Street, Tallahassee, Leon County, Florida, 32301, United States'],
  '3200 SW 34th St': ['building', 'openstreetmap', '3200, Southwest 34th Street, Gainesville, Alachua County, Florida, 32608, United States'],
  '1800 N Atlantic Ave': ['building', 'openstreetmap', '1800, North Atlantic Avenue, Daytona Beach, Volusia County, Florida, 32118, United States'],
  '5600 N W St': ['street', 'census', '5600 N W ST, PENSACOLA, FL, 32505'],
};

export async function seedLocations({ db, now = new Date() }) {
  const result = { sites: 0, surveyed: 0, cached: 0, judged: 0, away: null };
  const admin = await db.prepare(`SELECT id FROM users WHERE employee_code = '1001'`).get();
  const supervisor = await db.prepare(`SELECT id FROM users WHERE employee_code = '1002'`).get();
  const ago = (days) => toSql(new Date(now.getTime() - days * 24 * HOUR));

  const sites = await db.prepare(`SELECT * FROM sites ORDER BY id`).all();
  for (const [i, s] of sites.entries()) {
    const found = FOUND[s.address];
    if (!found || s.latitude == null) continue;
    const [precision, provider, label] = found;
    await rememberGeocode(siteAddress(s), { latitude: s.latitude, longitude: s.longitude, label, precision, provider }, new Date(now.getTime() - 20 * 24 * HOUR));
    await db
      .prepare(`UPDATE sites SET location_source = 'address', location_set_at = ?, location_set_by = ? WHERE id = ?`)
      .run(ago(120 - i * 7), admin?.id ?? null, s.id);
    result.sites += 1;
    result.cached += 1;
    // Posts carrying the same street address find the same place.
    for (const p of await db.prepare(`SELECT * FROM posts WHERE site_id = ? AND address IS NOT NULL`).all(s.id)) {
      await rememberGeocode(postAddress(p, s), { latitude: s.latitude, longitude: s.longitude, label, precision, provider }, new Date(now.getTime() - 20 * 24 * HOUR));
      result.cached += 1;
    }
  }

  // A supervisor stood at each post and set its pin; Riverfront's exterior
  // patrol starts at a deck corner and was dropped on the map instead.
  const posts = await db.prepare(`SELECT * FROM posts ORDER BY id`).all();
  for (const [i, p] of posts.entries()) {
    if (p.latitude == null) continue;
    if (p.post_code === 'RF-02') {
      await db.prepare(`UPDATE posts SET location_source = 'map', location_set_at = ?, location_set_by = ? WHERE id = ?`).run(ago(90), admin?.id ?? null, p.id);
      continue;
    }
    await db
      .prepare(`UPDATE posts SET location_source = 'survey', location_accuracy_m = ?, location_set_at = ?, location_set_by = ? WHERE id = ?`)
      .run(4 + ((i * 3) % 6), ago(60 - i * 3), supervisor?.id ?? null, p.id);
    result.surveyed += 1;
  }

  // Every check-in answered, judged against its post as it would have been.
  const answered = await db
    .prepare(
      `SELECT sc.id, sc.latitude, sc.longitude, p.latitude AS post_lat, p.longitude AS post_lng, p.geofence_radius_m
       FROM status_checks sc JOIN time_entries te ON te.id = sc.time_entry_id JOIN posts p ON p.id = te.post_id
       WHERE sc.status IN ('ok','late') AND sc.latitude IS NOT NULL AND sc.geofence IS NULL`
    )
    .all();
  for (const [i, c] of answered.entries()) {
    const accuracy = 5 + (i % 9);
    const fence = evaluateGeofence({
      lat: c.latitude, lng: c.longitude, accuracy,
      post: { latitude: c.post_lat, longitude: c.post_lng, geofence_radius_m: c.geofence_radius_m },
    });
    await db.prepare(`UPDATE status_checks SET accuracy = ?, geofence = ?, distance_m = ? WHERE id = ?`).run(accuracy, fence.status, fence.distance ?? null, c.id);
    result.judged += 1;
  }

  // This morning an officer answered a check-in from the gas station up the
  // road: counted, but flagged. Someone outside the scripted suites, on a
  // shift already over, so nobody's day on post changes.
  const away = await db
    .prepare(
      `SELECT sc.id, sc.user_id, sc.responded_at, p.latitude AS post_lat, p.longitude AS post_lng, p.geofence_radius_m, p.name AS post_name,
              u.first_name || ' ' || u.last_name AS officer
       FROM status_checks sc JOIN time_entries te ON te.id = sc.time_entry_id JOIN posts p ON p.id = te.post_id
       JOIN users u ON u.id = sc.user_id
       WHERE sc.status = 'ok' AND sc.geofence = 'inside' AND te.clock_out_at IS NOT NULL
         AND sc.responded_at BETWEEN ? AND ?
         AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM flags f WHERE f.user_id = sc.user_id AND f.occurred_at > ?)
       ORDER BY sc.responded_at DESC LIMIT 1`
    )
    .get(toSql(new Date(now.getTime() - 14 * HOUR)), toSql(new Date(now.getTime() - 2 * HOUR)), ...SUITE_PEOPLE, toSql(new Date(now.getTime() - 3 * 24 * HOUR)));
  if (away) {
    const [lat, lng] = offsetM([away.post_lat, away.post_lng], 290, 300);
    const fence = evaluateGeofence({ lat, lng, accuracy: 9, post: { latitude: away.post_lat, longitude: away.post_lng, geofence_radius_m: away.geofence_radius_m } });
    await db
      .prepare(`UPDATE status_checks SET latitude = ?, longitude = ?, accuracy = 9, geofence = ?, distance_m = ? WHERE id = ?`)
      .run(lat, lng, fence.status, fence.distance, away.id);
    await raiseFlag({
      userId: away.user_id, type: 'check_in_away', occurredAt: away.responded_at, refType: 'status_check', refId: away.id, severity: 'warning',
      detail: { distance_m: fence.distance, radius_m: fence.radius, accuracy: 9, post: away.post_name },
    });
    result.away = `${away.officer}, ${fence.distance} m from ${away.post_name}`;
  }
  return result;
}
