import { Router } from 'express';
import { db } from '../lib/db.js';
import { HttpError, wrap, isoFields, sqlToIso, parseDay, toDateString } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, toHours, minutesBetween } from '../shared.js';
import { toSql } from '../services/compliance.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

/**
 * Daily Activity Report.
 *
 * The document a security contractor actually hands the client: who was on
 * post, what they walked, what they found, and anything that went wrong.
 * Assembled from the data already captured rather than typed up again.
 */
reportsRouter.get(
  '/dar',
  wrap(async (req, res) => {
    const start = parseDay(req.query.date);
    if (!start) throw new HttpError(422, 'That date is not valid.');
    const end = new Date(start.getTime() + 86400000);

    const siteId = req.query.siteId ? Number(req.query.siteId) : null;
    const from = toSql(start);
    const to = toSql(end);

    const siteFilter = siteId ? 'AND s.id = ?' : '';
    const siteParam = siteId ? [siteId] : [];

    const site = siteId ? (await db.prepare(`SELECT * FROM sites WHERE id = ?`).get(siteId)) : null;

    const shifts = (await db
      .prepare(
        `SELECT te.*, u.employee_code, u.first_name || ' ' || u.last_name AS officer,
                p.name AS post_name, s.name AS site_name, s.id AS site_id
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.clock_in_at >= ? AND te.clock_in_at < ? ${siteFilter}
         ORDER BY s.name, te.clock_in_at`
      )
      .all(from, to, ...siteParam));

    const tours = (await db
      .prepare(
        `SELECT tr.*, t.name AS tour_name, s.name AS site_name,
                u.first_name || ' ' || u.last_name AS officer,
                (SELECT COUNT(*) FROM tour_run_checkpoints x WHERE x.tour_run_id = tr.id) AS total,
                (SELECT COUNT(*) FROM tour_run_checkpoints x WHERE x.tour_run_id = tr.id AND x.status = 'done') AS done,
                (SELECT COUNT(*) FROM tour_run_checkpoints x WHERE x.tour_run_id = tr.id AND x.status = 'skipped') AS skipped
         FROM tour_runs tr
         JOIN tours t ON t.id = tr.tour_id
         JOIN sites s ON s.id = t.site_id
         JOIN users u ON u.id = tr.user_id
         WHERE tr.started_at >= ? AND tr.started_at < ? ${siteFilter}
         ORDER BY tr.started_at`
      )
      .all(from, to, ...siteParam));

    const incidents = (await db
      .prepare(
        `SELECT i.*, s.name AS site_name, p.name AS post_name,
                u.first_name || ' ' || u.last_name AS officer
         FROM incidents i
         LEFT JOIN sites s ON s.id = i.site_id
         LEFT JOIN posts p ON p.id = i.post_id
         JOIN users u ON u.id = i.user_id
         WHERE i.occurred_at >= ? AND i.occurred_at < ? ${siteId ? 'AND i.site_id = ?' : ''}
         ORDER BY i.occurred_at`
      )
      .all(from, to, ...siteParam));

    const visits = (await db
      .prepare(
        `SELECT v.*, s.name AS site_name, p.name AS post_name,
                sup.first_name || ' ' || sup.last_name AS supervisor_name,
                o.first_name || ' ' || o.last_name AS officer_name
         FROM supervisor_visits v
         LEFT JOIN sites s ON s.id = v.site_id
         LEFT JOIN posts p ON p.id = v.post_id
         JOIN users sup ON sup.id = v.supervisor_id
         LEFT JOIN users o ON o.id = v.officer_id
         WHERE v.visited_at >= ? AND v.visited_at < ? ${siteId ? 'AND v.site_id = ?' : ''}
         ORDER BY v.visited_at`
      )
      .all(from, to, ...siteParam));

    const checks = (await db
      .prepare(
        `SELECT sc.status, COUNT(*) AS n
         FROM status_checks sc
         JOIN time_entries te ON te.id = sc.time_entry_id
         JOIN posts p ON p.id = te.post_id
         WHERE sc.due_at >= ? AND sc.due_at < ? ${siteId ? 'AND p.site_id = ?' : ''}
         GROUP BY sc.status`
      )
      .all(from, to, ...siteParam));

    const exceptions = (await db
      .prepare(
        `SELECT f.*, u.first_name || ' ' || u.last_name AS officer
         FROM flags f JOIN users u ON u.id = f.user_id
         WHERE f.occurred_at >= ? AND f.occurred_at < ?
         ORDER BY f.occurred_at`
      )
      .all(from, to));

    const visitors = (await db
      .prepare(
        `SELECT v.*, s.name AS site_name, u.first_name || ' ' || u.last_name AS logged_by_name
         FROM visitor_log v
         JOIN sites s ON s.id = v.site_id
         LEFT JOIN users u ON u.id = v.logged_by
         WHERE v.arrived_at >= ? AND v.arrived_at < ? ${siteId ? 'AND v.site_id = ?' : ''}
         ORDER BY v.arrived_at`
      )
      .all(from, to, ...siteParam));

    const vehicles = (await db
      .prepare(
        `SELECT vv.*, s.name AS site_name, u.first_name || ' ' || u.last_name AS logged_by_name
         FROM vehicle_violations vv
         JOIN sites s ON s.id = vv.site_id
         LEFT JOIN users u ON u.id = vv.logged_by
         WHERE vv.occurred_at >= ? AND vv.occurred_at < ? ${siteId ? 'AND vv.site_id = ?' : ''}
         ORDER BY vv.occurred_at`
      )
      .all(from, to, ...siteParam));

    const totalMinutes = shifts.reduce((sum, s) => sum + (s.minutes_worked || 0), 0);
    const checkTotals = Object.fromEntries(checks.map((c) => [c.status, c.n]));

    res.json({
      date: toDateString(start),
      site: site ? { id: site.id, name: site.name, address: site.address, client: site.client_name } : null,
      summary: {
        officers: new Set(shifts.map((s) => s.user_id)).size,
        shifts: shifts.length,
        hours: toHours(totalMinutes),
        toursCompleted: tours.filter((t) => String(t.status).startsWith('completed')).length,
        checkpointsScanned: tours.reduce((n, t) => n + t.done, 0),
        incidents: incidents.length,
        supervisorVisits: visits.length,
        checkInsAnswered: (checkTotals.ok || 0) + (checkTotals.late || 0),
        checkInsMissed: checkTotals.missed || 0,
        exceptions: exceptions.length,
        visitors: visitors.length,
        vehicleViolations: vehicles.length,
      },
      shifts: shifts.map((s) => ({
        ...isoFields(s, ['clock_in_at', 'clock_out_at']),
        hours: toHours(s.minutes_worked),
      })),
      tours: tours.map((t) => isoFields(t, ['started_at', 'completed_at'])),
      incidents: incidents.map((i) => isoFields(i, ['occurred_at', 'created_at'])),
      visits: visits.map((v) => isoFields(v, ['visited_at'])),
      exceptions: exceptions.map((f) => isoFields(f, ['occurred_at'])),
      visitors: visitors.map((v) => isoFields(v, ['arrived_at', 'departed_at', 'created_at'])),
      vehicles: vehicles.map((v) => isoFields(v, ['occurred_at', 'created_at'])),
    });
  })
);

/**
 * Everything with a coordinate, for the operations map: posts, officers
 * currently on duty, today's clock-ins and any open duress alert.
 */
reportsRouter.get(
  '/map',
  wrap(async (req, res) => {
    const posts = (await db
      .prepare(
        `SELECT p.id, p.name, p.post_code, p.latitude, p.longitude, p.geofence_radius_m,
                p.armed, p.address, s.id AS site_id, s.name AS site_name, s.address AS site_address,
                s.city, s.state
         FROM posts p JOIN sites s ON s.id = p.site_id
         WHERE p.active = 1 AND p.latitude IS NOT NULL`
      )
      .all());

    const onDuty = (await db
      .prepare(
        `SELECT te.id, te.clock_in_at, te.clock_in_lat, te.clock_in_lng, te.clock_in_geofence,
                te.clock_in_distance_m, u.id AS user_id, u.employee_code, u.phone,
                u.first_name || ' ' || u.last_name AS officer,
                p.id AS post_id, p.name AS post_name, p.latitude AS post_lat, p.longitude AS post_lng,
                s.name AS site_name
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.clock_out_at IS NULL`
      )
      .all());

    const alerts = (await db
      .prepare(
        `SELECT pa.id, pa.latitude, pa.longitude, pa.triggered_at, pa.status,
                u.first_name || ' ' || u.last_name AS officer, u.phone
         FROM panic_alerts pa JOIN users u ON u.id = pa.user_id
         WHERE pa.status IN ('active','acknowledged')`
      )
      .all());

    res.json({
      posts,
      onDuty: onDuty.map((o) => ({
        ...isoFields(o, ['clock_in_at']),
        minutes_on_post: minutesBetween(sqlToIso(o.clock_in_at), new Date().toISOString()),
      })),
      alerts: alerts.map((a) => isoFields(a, ['triggered_at'])),
      /** Set USC_MAPS_API_KEY to switch the client from OpenStreetMap to Google Maps. */
      googleMapsKey: process.env.USC_MAPS_API_KEY || null,
    });
  })
);

/**
 * Turn a typed address into coordinates for the location picker.
 *
 * Uses Google's geocoder when USC_MAPS_API_KEY is set, and falls back to
 * OpenStreetMap's Nominatim so the feature works before anyone has signed up
 * for a Google billing account.
 */
reportsRouter.get(
  '/geocode',
  wrap(async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (query.length < 3) {
      throw new HttpError(422, 'Enter at least three characters of the address.');
    }

    const key = process.env.USC_MAPS_API_KEY;

    try {
      if (key) {
        const url =
          `https://maps.googleapis.com/maps/api/geocode/json` +
          `?address=${encodeURIComponent(query)}&region=us&key=${key}`;
        const response = await fetch(url);
        const payload = await response.json();

        if (payload.status === 'OK') {
          return res.json({
            provider: 'google',
            results: payload.results.slice(0, 5).map((r) => ({
              label: r.formatted_address,
              latitude: r.geometry.location.lat,
              longitude: r.geometry.location.lng,
            })),
          });
        }
        if (payload.status !== 'ZERO_RESULTS') {
          console.warn('[usc] google geocode:', payload.status, payload.error_message || '');
        }
        return res.json({ provider: 'google', results: [] });
      }

      // Nominatim asks for a identifying User-Agent, and rate limits politely.
      const url =
        `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=us` +
        `&q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'USA-Security-Connect/1.0 (workforce management)' },
      });
      const payload = await response.json();

      res.json({
        provider: 'openstreetmap',
        results: (Array.isArray(payload) ? payload : []).map((r) => ({
          label: r.display_name,
          latitude: Number(r.lat),
          longitude: Number(r.lon),
        })),
      });
    } catch (err) {
      // A geocoder being down must not block saving a post; the admin can
      // still drop the pin by hand.
      console.error('[usc] geocode failed', err.message);
      res.json({ provider: key ? 'google' : 'openstreetmap', results: [], error: 'Address lookup is unavailable.' });
    }
  })
);

/** Client-facing coverage summary for a date range. */
reportsRouter.get(
  '/coverage',
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const rows = (await db
      .prepare(
        `SELECT s.id, s.name AS site_name, s.client_name,
                COUNT(DISTINCT te.id) AS shifts,
                COALESCE(SUM(te.minutes_worked),0) AS minutes,
                COUNT(DISTINCT te.user_id) AS officers,
                (SELECT COUNT(*) FROM incidents i
                   WHERE i.site_id = s.id AND i.occurred_at BETWEEN ? AND ?) AS incidents,
                (SELECT COUNT(*) FROM tour_runs tr
                   JOIN tours t ON t.id = tr.tour_id
                   WHERE t.site_id = s.id AND tr.started_at BETWEEN ? AND ?) AS tours
         FROM sites s
         LEFT JOIN posts p ON p.site_id = s.id
         LEFT JOIN time_entries te ON te.post_id = p.id AND te.clock_in_at BETWEEN ? AND ?
         WHERE s.active = 1
         GROUP BY s.id
         ORDER BY minutes DESC`
      )
      .all(toSql(from), toSql(to), toSql(from), toSql(to), toSql(from), toSql(to)));

    res.json({
      range: { from: from.toISOString(), to: to.toISOString() },
      sites: rows.map((r) => ({ ...r, hours: toHours(r.minutes) })),
    });
  })
);
