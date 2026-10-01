/**
 * The client portal.
 *
 * A read-only window for the people who pay for the guarding: which posts were
 * covered, who stood them, what was patrolled and what happened. Everything is
 * scoped to the sites linked to the signed-in contact.
 *
 * Two things are deliberately absent, and should stay absent:
 *   - anything to do with money we pay (pay rates, classification, margin).
 *     Bill rates reach a client through an invoice, never through this API.
 *   - anything internal to an officer's employment: flags, discipline,
 *     licence numbers, contact details, review notes on an incident.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit, demoInstance } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, rateLimit, parseDay, toDateString, sqlToIso, idParam } from '../lib/http.js';
import {
  authenticateClient,
  requireClient,
  publicClient,
  hashPassword,
  verifyPassword,
  passwordIsStrongEnough,
  issueClientToken,
  readPasswordToken,
  consumePasswordToken,
} from '../lib/clientAuth.js';
import { toHours, daysOverdue, CALL_TYPES } from '../shared.js';
import { callSelect, loadCall, logEvent, presentCallForClient, pushToSupervisors, OPEN_SQL } from '../services/dispatch.js';
import { pushAsync } from '../services/push.js';
import { agreementBoard, deliveredByWeek } from '../services/agreements.js';
import * as storage from '../services/storage.js';
import { toSql } from '../services/compliance.js';
import { contactsFor, contactSchema } from './siteLog.js';
import { currentOrders } from '../services/postOrders.js';
import { siteMonth, monthKey } from '../services/siteMonth.js';

export const clientRouter = Router();

/* ------------------------------------------------------------- scoping --- */

/**
 * `IN (?,?,?)` for the caller's sites, and the ids to bind.
 *
 * Every query in this file goes through it, so a missed filter is a syntax
 * error rather than a data leak.
 */
const scope = (req) => ({
  sql: req.clientSiteIds.map(() => '?').join(','),
  ids: req.clientSiteIds,
});

/** 404 rather than 403: a client should not learn that another site exists. */
function assertSite(req, siteId) {
  const id = Number(siteId);
  if (!req.clientSiteIds.includes(id)) throw new HttpError(404, 'Site not found.');
  return id;
}

/** Read an optional ?siteId, falling back to every site they can see. */
function sitesFilter(req) {
  if (req.query.siteId) {
    const id = assertSite(req, req.query.siteId);
    return { sql: '?', ids: [id] };
  }
  return scope(req);
}

/** A window of days ending today, clamped so a client cannot ask for the lot. */
function window(req, defaultDays = 14) {
  const days = Math.min(Math.max(Number(req.query.days) || defaultDays, 1), 92);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end.getTime() - days * 86400000);
  start.setHours(0, 0, 0, 0);
  return { days, start, end, from: toSql(start), to: toSql(end) };
}

/* ---------------------------------------------------------------- login --- */

const loginSchema = z.object({
  email: z.string().email('Enter the email address your account was set up with.'),
  password: z.string().min(1, 'Enter your password.'),
});

clientRouter.post(
  '/login',
  // Several contacts at one company share an office IP, so the per-address
  // allowance is generous; the meaningful limit is per email address.
  //
  // The per-IP figure is overridable because the whole suite signs in from one
  // address and exhausts it, which made a second run fail on the limiter rather
  // than on anything real. The per-email limit is deliberately not overridable:
  // it is the one the security suite measures, and a test that can move the
  // number it is checking is not checking anything. Production leaves it unset.
  rateLimit({
    windowMs: 5 * 60000,
    max: Number(process.env.USC_CLIENT_LOGIN_LIMIT_PER_IP) || 60,
    key: (req) => `ip:${req.ip}`,
  }),
  // Except on the demo site, where every visitor shares the published
  // contacts and their passwords are public: there it would only lock
  // strangers out of each other's tour.
  rateLimit({ windowMs: 5 * 60000, max: demoInstance ? 500 : 10, key: (req) => `email:${req.body?.email || 'none'}` }),
  wrap(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const { client, token } = await authenticateClient({ ...body, ip: req.ip });
    res.json({ token, client: publicClient(client), mustChangePassword: false });
  })
);

/* ------------------------------------------------- choosing a password --- */

/**
 * What is behind a set-password link, without spending it.
 *
 * Lets the page say "this link has expired" before somebody types a password
 * into a form that was never going to work.
 */
clientRouter.get(
  '/set-password/:token',
  rateLimit({ windowMs: 5 * 60000, max: 30, key: (req) => `token-check:${req.ip}` }),
  wrap(async (req, res) => {
    const record = await readPasswordToken(req.params.token);
    if (!record) throw new HttpError(404, 'That link is not valid. Ask your account manager for a new one.');
    res.json({
      valid: record.valid,
      reason: record.reason || null,
      // Enough to reassure them the link is theirs; nothing they did not know.
      name: record.valid ? record.name : null,
      email: record.valid ? record.email : null,
      purpose: record.purpose,
      expiresAt: sqlToIso(record.expires_at),
    });
  })
);

clientRouter.post(
  '/set-password',
  rateLimit({ windowMs: 5 * 60000, max: 15, key: (req) => `set-password:${req.ip}` }),
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        token: z.string().min(10, 'That link is not valid.'),
        password: z.string().min(12, 'Use at least 12 characters.'),
        confirmPassword: z.string().min(1, 'Confirm the password.'),
      }),
      req.body
    );

    if (body.password !== body.confirmPassword) {
      throw new HttpError(422, 'Please correct the highlighted fields.', [
        { field: 'confirmPassword', message: 'The two passwords do not match.' },
      ]);
    }

    const client = await consumePasswordToken({ token: body.token, password: body.password });
    await audit(null, 'client.password_set', 'client_user', client.id, null, req.ip);

    // Straight into the portal: making them retype what they just chose is
    // friction with nothing behind it.
    res.json({ token: issueClientToken(client), client: publicClient(client) });
  })
);

clientRouter.post('/logout', requireClient, wrap(async (req, res) => {
  await audit(null, 'client.logout', 'client_user', req.client.id, null, req.ip);
  res.json({ ok: true });
}));

clientRouter.post(
  '/change-password',
  requireClient,
  wrap(async (req, res) => {
    // Each demo server keeps its own copy of the data, so a changed password
    // would work on one and not the next. The published ones stay as they are.
    if (demoInstance) {
      throw new HttpError(403, 'Passwords cannot be changed on the demo site, so everyone can keep using the published ones.');
    }
    const body = parse(
      z.object({
        currentPassword: z.string().min(1, 'Enter your current password.'),
        newPassword: z.string().min(12, 'Use at least 12 characters.'),
        confirmPassword: z.string().min(1, 'Confirm the new password.'),
      }),
      req.body
    );

    if (!verifyPassword(body.currentPassword, req.client.password_hash, req.client.password_salt)) {
      throw new HttpError(401, 'Your current password is incorrect.');
    }
    if (body.newPassword !== body.confirmPassword) {
      throw new HttpError(422, 'Please correct the highlighted fields.', [
        { field: 'confirmPassword', message: 'The two passwords do not match.' },
      ]);
    }
    if (!passwordIsStrongEnough(body.newPassword)) {
      throw new HttpError(422, 'Please correct the highlighted fields.', [
        { field: 'newPassword', message: 'Use at least 12 characters.' },
      ]);
    }

    const { hash, salt } = hashPassword(body.newPassword);
    await db
      .prepare(
        `UPDATE client_users
         SET password_hash = ?, password_salt = ?, token_version = token_version + 1
         WHERE id = ?`
      )
      .run(hash, salt, req.client.id);
    await audit(null, 'client.password_changed', 'client_user', req.client.id, null, req.ip);

    // The bump has just retired every token this contact holds, including the
    // one that made this request, so issue a replacement at the new version.
    const updated = await db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(req.client.id);
    res.json({ ok: true, token: issueClientToken(updated) });
  })
);

/* ------------------------------------------------- everything below: auth --- */

clientRouter.use(requireClient);

clientRouter.get(
  '/me',
  wrap(async (req, res) => {
    const { sql, ids } = scope(req);
    const sites = await db
      .prepare(
        `SELECT id, name, address, city, state, postal_code, latitude, longitude
         FROM sites WHERE id IN (${sql}) ORDER BY name`
      )
      .all(...ids);
    res.json({ client: publicClient(req.client), sites });
  })
);

/* ------------------------------------------------------------- overview --- */

/** The landing screen: is my property covered right now, and what is open. */
clientRouter.get(
  '/overview',
  wrap(async (req, res) => {
    const { sql, ids } = scope(req);
    const { from, to, days } = window(req, 7);

    const onPost = await db
      .prepare(
        `SELECT te.id, te.clock_in_at, u.first_name, u.last_name,
                p.name AS post_name, s.name AS site_name, s.id AS site_id
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.clock_out_at IS NULL AND s.id IN (${sql})
         ORDER BY te.clock_in_at`
      )
      .all(...ids);

    const upcoming = await db
      .prepare(
        `SELECT sh.id, sh.starts_at, sh.ends_at, sh.is_open,
                p.name AS post_name, s.name AS site_name,
                u.first_name, u.last_name
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         LEFT JOIN users u ON u.id = sh.user_id
         WHERE s.id IN (${sql}) AND sh.status != 'cancelled' AND sh.ends_at >= now()
         ORDER BY sh.starts_at LIMIT 12`
      )
      .all(...ids);

    const coverage = await db
      .prepare(
        `SELECT COUNT(*) AS scheduled,
                SUM(CASE WHEN te.id IS NOT NULL THEN 1 ELSE 0 END) AS covered,
                COALESCE(SUM(te.minutes_worked), 0) AS minutes
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         LEFT JOIN time_entries te ON te.shift_id = sh.id
         WHERE p.site_id IN (${sql}) AND sh.status != 'cancelled'
           AND sh.starts_at >= ? AND sh.starts_at <= ? AND sh.starts_at < now()`
      )
      .get(...ids, from, to);

    const patrols = await db
      .prepare(
        `SELECT COUNT(DISTINCT tr.id) AS runs,
                SUM(CASE WHEN trc.status = 'done' THEN 1 ELSE 0 END) AS scanned,
                COUNT(trc.id) AS checkpoints
         FROM tour_runs tr
         JOIN tours t ON t.id = tr.tour_id
         LEFT JOIN tour_run_checkpoints trc ON trc.tour_run_id = tr.id
         WHERE t.site_id IN (${sql}) AND tr.started_at >= ? AND tr.started_at <= ?`
      )
      .get(...ids, from, to);

    const incidents = await db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN severity IN ('high','critical') THEN 1 ELSE 0 END) AS serious,
                SUM(CASE WHEN status != 'closed' THEN 1 ELSE 0 END) AS open
         FROM incidents
         WHERE site_id IN (${sql}) AND occurred_at >= ? AND occurred_at <= ?`
      )
      .get(...ids, from, to);

    const visits = (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM supervisor_visits
           WHERE site_id IN (${sql}) AND visited_at >= ? AND visited_at <= ?`
        )
        .get(...ids, from, to)
    ).n;

    const scheduled = coverage.scheduled || 0;
    res.json({
      days,
      onPost: onPost.map((r) => ({
        ...isoFields(r, ['clock_in_at']),
        officer_name: `${r.first_name} ${r.last_name}`,
        first_name: undefined,
        last_name: undefined,
      })),
      upcoming: upcoming.map((r) => ({
        ...isoFields(r, ['starts_at', 'ends_at']),
        // An unfilled shift is shown as unassigned rather than as a blank name.
        officer_name: r.first_name ? `${r.first_name} ${r.last_name}` : null,
        first_name: undefined,
        last_name: undefined,
      })),
      summary: {
        shiftsScheduled: scheduled,
        shiftsCovered: coverage.covered || 0,
        coveragePercent: scheduled ? Math.round(((coverage.covered || 0) / scheduled) * 100) : null,
        hoursOnSite: toHours(coverage.minutes || 0),
        patrolRuns: patrols.runs || 0,
        checkpointsScanned: patrols.scanned || 0,
        checkpointsTotal: patrols.checkpoints || 0,
        incidents: incidents.total || 0,
        seriousIncidents: incidents.serious || 0,
        openIncidents: incidents.open || 0,
        supervisorVisits: visits,
      },
    });
  })
);

/* ------------------------------------------------------------- coverage --- */

/** Shift-by-shift proof of attendance. No rates, ours or theirs. */
clientRouter.get(
  '/coverage',
  wrap(async (req, res) => {
    const { sql, ids } = sitesFilter(req);
    const { from, to, days } = window(req, 14);

    const rows = await db
      .prepare(
        `SELECT sh.id, sh.starts_at, sh.ends_at, sh.status, sh.is_open,
                p.name AS post_name, p.armed, s.name AS site_name, s.id AS site_id,
                u.first_name, u.last_name,
                te.clock_in_at, te.clock_out_at, te.minutes_worked, te.late_minutes,
                te.clock_in_geofence
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         LEFT JOIN users u ON u.id = sh.user_id
         LEFT JOIN time_entries te ON te.shift_id = sh.id
         WHERE s.id IN (${sql}) AND sh.status != 'cancelled'
           AND sh.starts_at >= ? AND sh.starts_at <= ?
         ORDER BY sh.starts_at DESC`
      )
      .all(...ids, from, to);

    res.json({
      days,
      shifts: rows.map((r) => {
        const row = isoFields(r, ['starts_at', 'ends_at', 'clock_in_at', 'clock_out_at']);
        return {
          id: row.id,
          site_id: row.site_id,
          site_name: row.site_name,
          post_name: row.post_name,
          armed: row.armed,
          starts_at: row.starts_at,
          ends_at: row.ends_at,
          officer_name: row.first_name ? `${row.first_name} ${row.last_name}` : null,
          clock_in_at: row.clock_in_at,
          clock_out_at: row.clock_out_at,
          hours_worked: row.minutes_worked ? toHours(row.minutes_worked) : null,
          // The client is told a post was covered late, not by how much - the
          // minute count is an employment matter.
          late: (row.late_minutes || 0) > 0,
          on_site: row.clock_in_geofence === 'inside',
          covered: Boolean(row.clock_in_at),
        };
      }),
    });
  })
);

/* ------------------------------------------------------------- schedule --- */

/**
 * The schedule ahead at their properties: who is booked on each post, and
 * which shifts we are still arranging. Nothing about pay or the reason a
 * shift is open.
 */
clientRouter.get(
  '/schedule',
  wrap(async (req, res) => {
    const { sql, ids } = sitesFilter(req);
    const days = Math.min(Math.max(Math.floor(Number(req.query.days)) || 7, 1), 14);
    const from = new Date();
    const until = new Date(from.getTime() + days * 86400000);
    const rows = await db
      .prepare(
        `SELECT sh.id, sh.starts_at, sh.ends_at, sh.user_id, p.name AS post_name, p.armed, s.name AS site_name, s.id AS site_id,
                u.first_name, u.last_name
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         LEFT JOIN users u ON u.id = sh.user_id
         WHERE s.id IN (${sql}) AND sh.status != 'cancelled' AND sh.ends_at > ? AND sh.starts_at < ?
         ORDER BY sh.starts_at, p.name`
      )
      .all(...ids, toSql(from), toSql(until));
    const shifts = rows.map((r) => {
      const row = isoFields(r, ['starts_at', 'ends_at']);
      return {
        id: row.id,
        site_id: row.site_id,
        site_name: row.site_name,
        post_name: row.post_name,
        armed: Boolean(row.armed),
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        officer_name: row.user_id && row.first_name ? `${row.first_name} ${row.last_name}` : null,
        assigned: Boolean(row.user_id),
      };
    });
    res.json({ days, shifts, summary: { total: shifts.length, assigned: shifts.filter((x) => x.assigned).length } });
  })
);

/* -------------------------------------------------------------- notices --- */

/** Notices live now at any of the client's properties. */
const liveNotices = (sql) => `
  n.withdrawn_at IS NULL AND n.starts_at <= now() AND (n.ends_at IS NULL OR n.ends_at > now())
  AND (n.all_sites = true OR EXISTS (SELECT 1 FROM client_notice_sites ns WHERE ns.notice_id = n.id AND ns.site_id IN (${sql})))`;

clientRouter.get(
  '/notices',
  wrap(async (req, res) => {
    const { sql, ids } = scope(req);
    const rows = await db
      .prepare(
        `SELECT n.id, n.title, n.body, n.level, n.all_sites, n.starts_at, n.ends_at,
                EXISTS (SELECT 1 FROM client_notice_reads r WHERE r.notice_id = n.id AND r.client_user_id = ?) AS read
         FROM client_notices n
         WHERE ${liveNotices(sql)}
         ORDER BY CASE n.level WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, n.starts_at DESC`
      )
      .all(req.client.id, ...ids);
    const notices = [];
    for (const n of rows) {
      // Which of their own properties it is about; never the others it went to.
      const sites = n.all_sites
        ? []
        : (await db
            .prepare(`SELECT s.name FROM client_notice_sites ns JOIN sites s ON s.id = ns.site_id WHERE ns.notice_id = ? AND ns.site_id IN (${sql}) ORDER BY s.name`)
            .all(n.id, ...ids)).map((x) => x.name);
      notices.push({ ...isoFields(n, ['starts_at', 'ends_at']), all_sites: Boolean(n.all_sites), read: Boolean(n.read), sites });
    }
    res.json({ notices, unread: notices.filter((n) => !n.read).length });
  })
);

clientRouter.post(
  '/notices/:id/read',
  wrap(async (req, res) => {
    const { sql, ids } = scope(req);
    const id = idParam(req.params.id, 'notice');
    const visible = await db.prepare(`SELECT n.id FROM client_notices n WHERE n.id = ? AND ${liveNotices(sql)}`).get(id, ...ids);
    if (!visible) throw new HttpError(404, 'Notice not found.');
    await db
      .prepare(`INSERT INTO client_notice_reads (notice_id, client_user_id) VALUES (?,?) ON CONFLICT DO NOTHING`)
      .run(id, req.client.id);
    res.json({ ok: true });
  })
);

/* -------------------------------------------------------------- patrols --- */

/** Patrol proof: every run, and every checkpoint scanned or missed. */
clientRouter.get(
  '/patrols',
  wrap(async (req, res) => {
    const { sql, ids } = sitesFilter(req);
    const { from, to, days } = window(req, 7);

    const runs = await db
      .prepare(
        `SELECT tr.id, tr.started_at, tr.completed_at, tr.status,
                t.name AS tour_name, s.name AS site_name, s.id AS site_id,
                u.first_name, u.last_name,
                COUNT(trc.id) AS checkpoints,
                SUM(CASE WHEN trc.status = 'done' THEN 1 ELSE 0 END) AS scanned,
                SUM(CASE WHEN trc.status = 'skipped' THEN 1 ELSE 0 END) AS skipped
         FROM tour_runs tr
         JOIN tours t ON t.id = tr.tour_id
         JOIN sites s ON s.id = t.site_id
         JOIN users u ON u.id = tr.user_id
         LEFT JOIN tour_run_checkpoints trc ON trc.tour_run_id = tr.id
         WHERE s.id IN (${sql}) AND tr.started_at >= ? AND tr.started_at <= ?
         GROUP BY tr.id, t.name, s.name, s.id, u.first_name, u.last_name
         ORDER BY tr.started_at DESC LIMIT 200`
      )
      .all(...ids, from, to);

    res.json({
      days,
      runs: runs.map((r) => ({
        ...isoFields(r, ['started_at', 'completed_at']),
        officer_name: `${r.first_name} ${r.last_name}`,
        first_name: undefined,
        last_name: undefined,
      })),
    });
  })
);

clientRouter.get(
  '/patrols/:id',
  wrap(async (req, res) => {
    const { sql, ids } = scope(req);
    const run = await db
      .prepare(
        `SELECT tr.id, tr.started_at, tr.completed_at, tr.status,
                t.name AS tour_name, t.description, s.name AS site_name,
                u.first_name, u.last_name
         FROM tour_runs tr
         JOIN tours t ON t.id = tr.tour_id
         JOIN sites s ON s.id = t.site_id
         JOIN users u ON u.id = tr.user_id
         WHERE tr.id = ? AND s.id IN (${sql})`
      )
      .get(req.params.id, ...ids);
    if (!run) throw new HttpError(404, 'Patrol not found.');

    const checkpoints = await db
      .prepare(
        `SELECT trc.id, trc.status, trc.scanned_at, trc.method, trc.skip_reason,
                c.name, c.instructions, c.sequence, c.required
         FROM tour_run_checkpoints trc
         JOIN checkpoints c ON c.id = trc.checkpoint_id
         WHERE trc.tour_run_id = ?
         ORDER BY c.sequence`
      )
      .all(run.id);

    res.json({
      run: {
        ...isoFields(run, ['started_at', 'completed_at']),
        officer_name: `${run.first_name} ${run.last_name}`,
        first_name: undefined,
        last_name: undefined,
      },
      checkpoints: checkpoints.map((c) => isoFields(c, ['scanned_at'])),
    });
  })
);

/* ------------------------------------------------------------ incidents --- */

clientRouter.get(
  '/incidents',
  wrap(async (req, res) => {
    const { sql, ids } = sitesFilter(req);
    const { from, to, days } = window(req, 30);

    const rows = await db
      .prepare(
        `SELECT i.id, i.ref_number, i.category, i.severity, i.status, i.occurred_at,
                i.location_text, i.police_notified, s.name AS site_name, s.id AS site_id,
                p.name AS post_name,
                (SELECT COUNT(*) FROM incident_photos ip WHERE ip.incident_id = i.id) AS photo_count
         FROM incidents i
         JOIN sites s ON s.id = i.site_id
         LEFT JOIN posts p ON p.id = i.post_id
         WHERE s.id IN (${sql}) AND i.occurred_at >= ? AND i.occurred_at <= ?
         ORDER BY i.occurred_at DESC LIMIT 200`
      )
      .all(...ids, from, to);

    res.json({ days, incidents: rows.map((r) => isoFields(r, ['occurred_at'])) });
  })
);

clientRouter.get(
  '/incidents/:id',
  wrap(async (req, res) => {
    const { sql, ids } = scope(req);
    const row = await db
      .prepare(
        `SELECT i.id, i.ref_number, i.category, i.severity, i.status, i.occurred_at,
                i.location_text, i.what_happened, i.resolution, i.other_details,
                i.people_involved, i.people_notified, i.police_notified,
                i.police_report_number, i.officer_name, i.created_at,
                s.name AS site_name, p.name AS post_name
         FROM incidents i
         JOIN sites s ON s.id = i.site_id
         LEFT JOIN posts p ON p.id = i.post_id
         WHERE i.id = ? AND s.id IN (${sql})`
      )
      .get(req.params.id, ...ids);
    if (!row) throw new HttpError(404, 'Incident not found.');

    const photos = await db
      .prepare(`SELECT id, filename, original_name, caption FROM incident_photos WHERE incident_id = ?`)
      .all(row.id);

    // What we are doing about it: the follow-ups marked for the client, without
    // who owns them or the internal note on how each was closed.
    const actions = (
      await db
        .prepare(
          `SELECT id, title, status, due_on, done_at FROM incident_actions
           WHERE incident_id = ? AND client_visible = true ORDER BY status = 'done', due_on NULLS LAST, id`
        )
        .all(row.id)
    ).map((a) => ({ ...isoFields(a, ['done_at']), due_on: a.due_on ? String(a.due_on).slice(0, 10) : null }));
    res.json({ incident: isoFields(row, ['occurred_at', 'created_at']), photos, actions });
  })
);

/** Photos stay behind this endpoint so the storage URL is never handed out. */
clientRouter.get(
  '/incidents/:id/photos/:photoId',
  wrap(async (req, res) => {
    const { sql, ids } = scope(req);
    const incident = await db
      .prepare(`SELECT i.id FROM incidents i WHERE i.id = ? AND i.site_id IN (${sql})`)
      .get(req.params.id, ...ids);
    if (!incident) throw new HttpError(404, 'Incident not found.');

    const photo = await db
      .prepare(`SELECT * FROM incident_photos WHERE id = ? AND incident_id = ?`)
      .get(req.params.photoId, incident.id);
    if (!photo) throw new HttpError(404, 'Photo not found.');

    let buffer;
    try {
      buffer = await storage.read(photo);
    } catch (err) {
      throw new HttpError(404, err.message || 'Photo file is missing.');
    }
    res.type(photo.mime_type || 'image/jpeg');
    res.send(buffer);
  })
);

/* ----------------------------------------------------- supervisor visits --- */

clientRouter.get(
  '/visits',
  wrap(async (req, res) => {
    const { sql, ids } = sitesFilter(req);
    const { from, to, days } = window(req, 30);

    const rows = await db
      .prepare(
        `SELECT v.id, v.visited_at, v.client_note AS note, s.name AS site_name, p.name AS post_name
         FROM supervisor_visits v
         JOIN sites s ON s.id = v.site_id
         LEFT JOIN posts p ON p.id = v.post_id
         WHERE s.id IN (${sql}) AND v.visited_at >= ? AND v.visited_at <= ?
         ORDER BY v.visited_at DESC LIMIT 100`
      )
      .all(...ids, from, to);

    res.json({ days, visits: rows.map((r) => isoFields(r, ['visited_at'])) });
  })
);

/* ------------------------------------------------------------ invoices --- */

/**
 * The one place a client sees a rate.
 *
 * What we charge is theirs to see; what the work cost us is not, so
 * cost_cents never leaves this handler.
 */
const publicInvoice = (row) => ({
  id: row.id,
  number: row.number,
  site_id: row.site_id,
  site_name: row.site_name,
  // Their own company name, so the invoice is addressed to them rather than
  // to the property.
  client_name: row.client_name,
  period_start: row.period_start,
  period_end: row.period_end,
  status: row.status,
  subtotal_cents: row.subtotal_cents,
  tax_cents: row.tax_cents,
  total_cents: row.total_cents,
  due_on: row.due_on,
  issued_at: sqlToIso(row.issued_at),
  paid_at: sqlToIso(row.paid_at),
  notes: row.notes,
  overdue_days: daysOverdue(row.due_on, row.status),
  open_queries: Number(row.open_queries || 0),
});

/** Questions on an invoice as the client sees them: no name of ours on the answer. */
async function queriesFor(invoiceId) {
  const rows = await db
    .prepare(
      `SELECT q.id, q.line_id, l.description AS line_description, q.question, q.status, q.answer,
              q.created_at, q.answered_at, c.name AS asked_by
       FROM invoice_queries q
       LEFT JOIN invoice_lines l ON l.id = q.line_id
       LEFT JOIN client_users c ON c.id = q.client_user_id
       WHERE q.invoice_id = ? ORDER BY q.created_at DESC, q.id DESC`
    )
    .all(invoiceId);
  return rows.map((q) => isoFields(q, ['created_at', 'answered_at']));
}

clientRouter.get(
  '/invoices',
  wrap(async (req, res) => {
    const { sql, ids } = sitesFilter(req);

    // A draft has not been issued and may still change, so it is not theirs
    // to see yet.
    const rows = await db
      .prepare(
        `SELECT i.*, s.name AS site_name, s.client_name,
                (SELECT COUNT(*) FROM invoice_queries q WHERE q.invoice_id = i.id AND q.status = 'open') AS open_queries
         FROM invoices i JOIN sites s ON s.id = i.site_id
         WHERE s.id IN (${sql}) AND i.status IN ('sent','paid')
         ORDER BY i.period_end DESC, i.id DESC LIMIT 100`
      )
      .all(...ids);

    const outstanding = rows
      .filter((r) => r.status === 'sent')
      .reduce((sum, r) => sum + r.total_cents, 0);

    res.json({ invoices: rows.map(publicInvoice), outstandingCents: outstanding });
  })
);

clientRouter.get(
  '/invoices/:id',
  wrap(async (req, res) => {
    const row = await loadClientInvoice(req, req.params.id);

    const lines = await db
      .prepare(
        `SELECT id, description, minutes, rate_cents, amount_cents
         FROM invoice_lines WHERE invoice_id = ? ORDER BY sequence, id`
      )
      .all(row.id);

    res.json({
      invoice: {
        ...publicInvoice(row),
        address: row.address,
        city: row.city,
        state: row.state,
        postal_code: row.postal_code,
      },
      lines: lines.map((l) => ({ ...l, hours: toHours(l.minutes) })),
      queries: await queriesFor(row.id),
    });
  })
);

/** One of the client's own issued invoices, or a 404. */
async function loadClientInvoice(req, idValue) {
  const { sql, ids } = scope(req);
  const row = await db
    .prepare(
      `SELECT i.*, s.name AS site_name, s.client_name, s.address, s.city, s.state, s.postal_code,
              (SELECT COUNT(*) FROM invoice_queries q WHERE q.invoice_id = i.id AND q.status = 'open') AS open_queries
       FROM invoices i JOIN sites s ON s.id = i.site_id
       WHERE i.id = ? AND s.id IN (${sql}) AND i.status IN ('sent','paid')`
    )
    .get(idParam(idValue, 'invoice'), ...ids);
  if (!row) throw new HttpError(404, 'Invoice not found.');
  return row;
}

const MAX_OPEN_QUERIES = 3;

/** Ask about an invoice, or one line of it. The office answers in the portal and by email. */
clientRouter.post(
  '/invoices/:id/queries',
  wrap(async (req, res) => {
    const invoice = await loadClientInvoice(req, req.params.id);
    const body = parse(
      z.object({
        lineId: z.number().int().positive().optional().nullable(),
        question: z.string().trim().min(10, 'Say what you would like to know.').max(1000),
      }),
      req.body
    );
    if (body.lineId) {
      const line = await db.prepare(`SELECT id FROM invoice_lines WHERE id = ? AND invoice_id = ?`).get(body.lineId, invoice.id);
      if (!line) throw new HttpError(422, 'That line is not on this invoice.', [{ field: 'lineId', message: 'Pick a line on this invoice.' }]);
    }
    if (Number(invoice.open_queries) >= MAX_OPEN_QUERIES) {
      throw new HttpError(409, `There are already ${MAX_OPEN_QUERIES} questions waiting on this invoice. We will answer those first.`);
    }
    const info = await db
      .prepare(`INSERT INTO invoice_queries (invoice_id, line_id, client_user_id, question) VALUES (?,?,?,?)`)
      .run(invoice.id, body.lineId ?? null, req.client.id, body.question);
    await audit(null, 'invoice_query.asked', 'invoice_query', Number(info.lastInsertRowid), { invoiceId: invoice.id, clientUserId: req.client.id }, req.ip);
    res.status(201).json({ queries: await queriesFor(invoice.id) });
  })
);

/* ----------------------------------------------------------------- DAR --- */

/**
 * The daily activity report, scoped to one of the client's own sites.
 *
 * Same shape as the internal report so the client sees exactly the document
 * their account manager is looking at, minus the staffing internals.
 */
clientRouter.get(
  '/dar',
  wrap(async (req, res) => {
    const siteId = assertSite(req, req.query.siteId ?? req.clientSiteIds[0]);
    const start = parseDay(req.query.date);
    if (!start) throw new HttpError(422, 'That date is not valid.');
    const end = new Date(start.getTime() + 86400000);
    const from = toSql(start);
    const to = toSql(end);

    const site = await db.prepare(`SELECT id, name, address, city, state FROM sites WHERE id = ?`).get(siteId);

    const coverage = await db
      .prepare(
        `SELECT te.clock_in_at, te.clock_out_at, te.minutes_worked,
                p.name AS post_name, u.first_name, u.last_name
         FROM time_entries te
         JOIN posts p ON p.id = te.post_id
         JOIN users u ON u.id = te.user_id
         WHERE p.site_id = ? AND te.clock_in_at >= ? AND te.clock_in_at < ?
         ORDER BY te.clock_in_at`
      )
      .all(siteId, from, to);

    const patrols = await db
      .prepare(
        `SELECT tr.id, tr.started_at, tr.completed_at, tr.status, t.name AS tour_name,
                COUNT(trc.id) AS checkpoints,
                SUM(CASE WHEN trc.status = 'done' THEN 1 ELSE 0 END) AS scanned
         FROM tour_runs tr
         JOIN tours t ON t.id = tr.tour_id
         LEFT JOIN tour_run_checkpoints trc ON trc.tour_run_id = tr.id
         WHERE t.site_id = ? AND tr.started_at >= ? AND tr.started_at < ?
         GROUP BY tr.id, t.name
         ORDER BY tr.started_at`
      )
      .all(siteId, from, to);

    const incidents = await db
      .prepare(
        `SELECT id, ref_number, category, severity, occurred_at, location_text,
                what_happened, resolution, police_notified
         FROM incidents
         WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
         ORDER BY occurred_at`
      )
      .all(siteId, from, to);

    const visits = await db
      .prepare(
        `SELECT v.visited_at, v.client_note AS note, p.name AS post_name
         FROM supervisor_visits v
         LEFT JOIN posts p ON p.id = v.post_id
         WHERE v.site_id = ? AND v.visited_at >= ? AND v.visited_at < ?
         ORDER BY v.visited_at`
      )
      .all(siteId, from, to);

    // Who came through the building that day, as the officers logged them.
    // The officer who signed them in stays internal.
    const visitors = await db
      .prepare(
        `SELECT id, full_name, company, purpose, host, kind, vehicle_plate, vehicle_desc, badge_number,
                arrived_at, departed_at
         FROM visitor_log
         WHERE site_id = ? AND arrived_at >= ? AND arrived_at < ?
         ORDER BY arrived_at`
      )
      .all(siteId, from, to);
    const vehicles = await db
      .prepare(
        `SELECT id, plate, plate_state, vehicle_desc, location_text, violation, action, occurred_at
         FROM vehicle_violations
         WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
         ORDER BY occurred_at`
      )
      .all(siteId, from, to);
    // The officers' running log, less anything they marked internal.
    const activity = await db
      .prepare(
        `SELECT a.id, a.category, a.body, a.occurred_at, u.first_name || ' ' || u.last_name AS officer_name
         FROM activity_entries a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.site_id = ? AND a.client_visible = true AND a.occurred_at >= ? AND a.occurred_at < ?
         ORDER BY a.occurred_at`
      )
      .all(siteId, from, to);
    const issuesReported = await db
      .prepare(
        `SELECT id, category, priority, location_text, description, status, created_at
         FROM site_issues WHERE site_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at`
      )
      .all(siteId, from, to);
    const onSiteNow = await db
      .prepare(`SELECT COUNT(*) AS n FROM visitor_log WHERE site_id = ? AND departed_at IS NULL`)
      .get(siteId);

    res.json({
      date: toDateString(start),
      site,
      visitors: visitors.map((v) => isoFields(v, ['arrived_at', 'departed_at'])),
      visitorsOnSiteNow: Number(onSiteNow.n),
      vehicles: vehicles.map((v) => isoFields(v, ['occurred_at'])),
      activity: activity.map((a) => isoFields(a, ['occurred_at'])),
      issues: issuesReported.map((i) => isoFields(i, ['created_at'])),
      totalHours: toHours(coverage.reduce((sum, c) => sum + (c.minutes_worked || 0), 0)),
      coverage: coverage.map((c) => ({
        ...isoFields(c, ['clock_in_at', 'clock_out_at']),
        officer_name: `${c.first_name} ${c.last_name}`,
        hours: c.minutes_worked ? toHours(c.minutes_worked) : null,
        first_name: undefined,
        last_name: undefined,
        minutes_worked: undefined,
      })),
      patrols: patrols.map((p) => isoFields(p, ['started_at', 'completed_at'])),
      incidents: incidents.map((i) => isoFields(i, ['occurred_at'])),
      visits: visits.map((v) => isoFields(v, ['visited_at'])),
    });
  })
);

/* ------------------------------------------------ building issues ---- */

const issueFields = `i.id, i.site_id, s.name AS site_name, i.category, i.priority, i.location_text, i.description, i.status,
  i.client_note, i.created_at, i.acknowledged_at, i.fixed_at, c.name AS closed_by_name`;

/**
 * What the officers found wrong with the building: open ones first, and the
 * ones fixed in the last month. The officer who reported it stays internal.
 */
clientRouter.get(
  '/issues',
  requireClient,
  wrap(async (req, res) => {
    const sc = scope(req);
    const rows = await db
      .prepare(
        `SELECT ${issueFields}
         FROM site_issues i JOIN sites s ON s.id = i.site_id LEFT JOIN client_users c ON c.id = i.closed_by_client
         WHERE i.site_id IN (${sc.sql}) AND (i.status <> 'fixed' OR i.fixed_at >= ?)
         ORDER BY CASE i.status WHEN 'fixed' THEN 1 ELSE 0 END, CASE i.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, i.created_at DESC
         LIMIT 100`
      )
      .all(...sc.ids, toSql(new Date(Date.now() - 30 * 86400000)));
    res.json({ issues: rows.map((r) => isoFields(r, ['created_at', 'acknowledged_at', 'fixed_at'])) });
  })
);

/** "We've seen it" or "It's fixed", with an optional note for the officers. */
clientRouter.post(
  '/issues/:id/status',
  requireClient,
  wrap(async (req, res) => {
    const body = parse(
      z.object({ status: z.enum(['acknowledged', 'fixed']), note: z.string().trim().max(500).optional().nullable() }),
      req.body
    );
    const issue = await db.prepare(`SELECT * FROM site_issues WHERE id = ?`).get(Number(req.params.id));
    if (!issue || !req.clientSiteIds.includes(issue.site_id)) throw new HttpError(404, 'Issue not found.');
    if (issue.status === 'fixed') throw new HttpError(409, 'That issue is already closed.');
    const fixed = body.status === 'fixed';
    await db
      .prepare(
        `UPDATE site_issues SET status = ?, acknowledged_at = COALESCE(acknowledged_at, now()), fixed_at = ?,
           closed_by_client = ?, client_note = COALESCE(?, client_note)
         WHERE id = ?`
      )
      .run(body.status, fixed ? new Date().toISOString() : null, fixed ? req.client.id : null, body.note || null, issue.id);
    await audit(null, `client.issue_${body.status}`, 'site_issue', issue.id, { clientUserId: req.client.id }, req.ip);
    const row = await db
      .prepare(
        `SELECT ${issueFields} FROM site_issues i JOIN sites s ON s.id = i.site_id
         LEFT JOIN client_users c ON c.id = i.closed_by_client WHERE i.id = ?`
      )
      .get(issue.id);
    res.json({ issue: isoFields(row, ['created_at', 'acknowledged_at', 'fixed_at']) });
  })
);

/* ---------------------------------------------------- site contacts ---- */

/** The people our officers call at the client's properties, one list per site. */
clientRouter.get(
  '/contacts',
  requireClient,
  wrap(async (req, res) => {
    const sites = [];
    for (const id of req.clientSiteIds) {
      const site = await db.prepare(`SELECT id, name FROM sites WHERE id = ?`).get(id);
      if (site) sites.push({ ...site, contacts: (await contactsFor(id)).map(clientContact) });
    }
    res.json({ sites });
  })
);

// Which of our staff added a contact is internal; the client sees whether it
// was them or us.
const clientContact = (c) => ({
  id: c.id, site_id: c.site_id, name: c.name, role: c.role, phone: c.phone, email: c.email, notes: c.notes,
  after_hours: c.after_hours, sort: c.sort, updated_at: c.updated_at, added_by: c.added_by_client ? 'you' : 'us',
});

const needsWayToReach = (body) => {
  if (!body.phone && !body.email) {
    throw new HttpError(422, 'Give a phone number or an email address so our officers can reach them.', [
      { field: 'phone', message: 'A phone number or an email is needed.' },
    ]);
  }
};

clientRouter.post(
  '/contacts',
  requireClient,
  wrap(async (req, res) => {
    const body = parse(contactSchema.extend({ siteId: z.number().int().positive() }), req.body);
    assertSite(req, body.siteId);
    needsWayToReach(body);
    const info = await db
      .prepare(
        `INSERT INTO site_contacts (site_id, name, role, phone, email, notes, after_hours, sort, added_by_client)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(body.siteId, body.name, body.role, body.phone || null, body.email || null, body.notes || null, body.afterHours, body.sort, req.client.id);
    await audit(null, 'client.contact_added', 'site_contact', info.lastInsertRowid, { clientUserId: req.client.id }, req.ip);
    res.status(201).json({ contacts: (await contactsFor(body.siteId)).map(clientContact) });
  })
);

async function ownContact(req) {
  const row = await db.prepare(`SELECT * FROM site_contacts WHERE id = ?`).get(idParam(req.params.id, 'contact'));
  if (!row || !req.clientSiteIds.includes(row.site_id)) throw new HttpError(404, 'Contact not found.');
  return row;
}

clientRouter.patch(
  '/contacts/:id',
  requireClient,
  wrap(async (req, res) => {
    const row = await ownContact(req);
    const body = parse(contactSchema, req.body);
    needsWayToReach(body);
    await db
      .prepare(
        `UPDATE site_contacts SET name = ?, role = ?, phone = ?, email = ?, notes = ?, after_hours = ?, sort = ?, updated_at = now()
         WHERE id = ?`
      )
      .run(body.name, body.role, body.phone || null, body.email || null, body.notes || null, body.afterHours, body.sort, row.id);
    await audit(null, 'client.contact_updated', 'site_contact', row.id, { clientUserId: req.client.id }, req.ip);
    res.json({ contacts: (await contactsFor(row.site_id)).map(clientContact) });
  })
);

clientRouter.delete(
  '/contacts/:id',
  requireClient,
  wrap(async (req, res) => {
    const row = await ownContact(req);
    await db.prepare(`DELETE FROM site_contacts WHERE id = ?`).run(row.id);
    await audit(null, 'client.contact_removed', 'site_contact', row.id, { clientUserId: req.client.id, name: row.name }, req.ip);
    res.json({ contacts: (await contactsFor(row.site_id)).map(clientContact) });
  })
);

/* ------------------------------------------------------- feedback ---- */

const monthOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** This month's rating for each property, and the past year's with any reply. */
clientRouter.get(
  '/feedback',
  requireClient,
  wrap(async (req, res) => {
    const sc = scope(req);
    const rows = await db
      .prepare(
        `SELECT f.id, f.site_id, s.name AS site_name, f.period, f.rating, f.comment, f.response, f.responded_at, f.updated_at
         FROM client_feedback f JOIN sites s ON s.id = f.site_id
         WHERE f.client_user_id = ? AND f.site_id IN (${sc.sql})
         ORDER BY f.period DESC, s.name LIMIT 60`
      )
      .all(req.client.id, ...sc.ids);
    res.json({ period: monthOf(), feedback: rows.map((r) => isoFields(r, ['responded_at', 'updated_at'])) });
  })
);

clientRouter.post(
  '/feedback',
  requireClient,
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        siteId: z.number().int().positive(),
        rating: z.number().int().min(1, 'Choose from one to five stars.').max(5, 'Choose from one to five stars.'),
        comment: z.string().trim().max(1000).optional().nullable(),
      }),
      req.body
    );
    assertSite(req, body.siteId);
    if (body.rating <= 2 && !(body.comment || '').trim()) {
      throw new HttpError(422, 'Tell us what went wrong so we can put it right.', [
        { field: 'comment', message: 'A low rating needs a word on why.' },
      ]);
    }
    const period = monthOf();
    // One rating per contact, property and month: a change of mind replaces
    // it, and clears any reply that was written to the old one.
    await db
      .prepare(
        `INSERT INTO client_feedback (client_user_id, site_id, period, rating, comment)
         VALUES (?,?,?,?,?)
         ON CONFLICT (client_user_id, site_id, period) DO UPDATE SET
           rating = excluded.rating, comment = excluded.comment, updated_at = now(),
           response = NULL, responded_by = NULL, responded_at = NULL`
      )
      .run(req.client.id, body.siteId, period, body.rating, body.comment || null);
    await audit(null, 'client.feedback', 'client_feedback', null, { clientUserId: req.client.id, siteId: body.siteId, rating: body.rating }, req.ip);
    const row = await db
      .prepare(
        `SELECT f.id, f.site_id, s.name AS site_name, f.period, f.rating, f.comment, f.response, f.responded_at, f.updated_at
         FROM client_feedback f JOIN sites s ON s.id = f.site_id
         WHERE f.client_user_id = ? AND f.site_id = ? AND f.period = ?`
      )
      .get(req.client.id, body.siteId, period);
    res.status(201).json({ feedback: isoFields(row, ['responded_at', 'updated_at']) });
  })
);

/* ------------------------------------------------- extra coverage ---- */

const coverageFields = [
  'id', 'site_id', 'starts_at', 'ends_at', 'officers', 'armed', 'reason', 'status',
  'response', 'shifts_created', 'handled_at', 'created_at',
];

/** A request as the client sees it: no internal notes, no pay, no staff names. */
const presentCoverage = (r) => {
  const out = {};
  for (const k of coverageFields) out[k] = r[k];
  out.site_name = r.site_name;
  out.armed = Boolean(r.armed);
  return isoFields(out, ['starts_at', 'ends_at', 'handled_at', 'created_at']);
};

clientRouter.get(
  '/coverage-requests',
  requireClient,
  wrap(async (req, res) => {
    const sc = scope(req);
    const rows = await db
      .prepare(
        `SELECT r.*, s.name AS site_name FROM coverage_requests r JOIN sites s ON s.id = r.site_id
         WHERE r.site_id IN (${sc.sql}) ORDER BY r.created_at DESC LIMIT 100`
      )
      .all(...sc.ids);
    res.json({ requests: rows.map(presentCoverage) });
  })
);

const coverageSchema = z.object({
  siteId: z.number().int().positive(),
  startsAt: z.string().min(10),
  endsAt: z.string().min(10),
  officers: z.number().int().min(1, 'Ask for at least one officer.').max(10, 'For more than ten officers, call the office.'),
  armed: z.boolean().default(false),
  reason: z.string().trim().min(5, 'Tell us what the coverage is for.').max(1000),
});

clientRouter.post(
  '/coverage-requests',
  requireClient,
  rateLimit({ windowMs: 60 * 60000, max: 20, key: (req) => `coverage:${req.client.id}` }),
  wrap(async (req, res) => {
    const body = parse(coverageSchema, req.body);
    const siteId = assertSite(req, body.siteId);
    const start = new Date(body.startsAt);
    const end = new Date(body.endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new HttpError(422, 'Those times are not valid.');
    }
    if (start < new Date(Date.now() + 60 * 60000)) {
      throw new HttpError(422, 'Coverage has to start at least an hour from now. For anything sooner, call the office.');
    }
    if (start > new Date(Date.now() + 120 * 86400000)) {
      throw new HttpError(422, 'Requests can be made up to 120 days ahead.');
    }
    if (end <= start) throw new HttpError(422, 'The coverage has to end after it starts.');
    if (end - start > 16 * 3600000) {
      throw new HttpError(422, 'A single request can cover up to 16 hours. Make one request per shift for longer.');
    }

    const created = await db
      .prepare(
        `INSERT INTO coverage_requests (site_id, client_user_id, starts_at, ends_at, officers, armed, reason)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(siteId, req.client.id, toSql(start), toSql(end), body.officers, body.armed, body.reason);
    const id = Number(created.lastInsertRowid);
    await audit(null, 'coverage_request.created', 'coverage_request', id, { client: req.client.id }, req.ip);
    const row = await db
      .prepare(`SELECT r.*, s.name AS site_name FROM coverage_requests r JOIN sites s ON s.id = r.site_id WHERE r.id = ?`)
      .get(id);
    res.status(201).json({ request: presentCoverage(row) });
  })
);

clientRouter.post(
  '/coverage-requests/:id/cancel',
  requireClient,
  wrap(async (req, res) => {
    const sc = scope(req);
    const row = await db
      .prepare(`SELECT * FROM coverage_requests WHERE id = ? AND site_id IN (${sc.sql})`)
      .get(Number(req.params.id), ...sc.ids);
    if (!row) throw new HttpError(404, 'Request not found.');
    if (row.status !== 'open') {
      throw new HttpError(409, 'Only a request we have not answered yet can be withdrawn. Call the office to change it.');
    }
    await db.prepare(`UPDATE coverage_requests SET status = 'cancelled' WHERE id = ?`).run(row.id);
    await audit(null, 'coverage_request.cancelled', 'coverage_request', row.id, { client: req.client.id }, req.ip);
    res.json({ ok: true });
  })
);

/* ===================================================== service agreement === */

/**
 * The hours a week each of their properties is contracted for, what was
 * worked in each of the last four weeks and what is rostered for the next
 * seven days. Our internal notes on the agreement stay with us.
 */
clientRouter.get(
  '/agreement',
  requireClient,
  wrap(async (req, res) => {
    const board = await agreementBoard();
    const mine = board.sites.filter((s) => req.clientSiteIds.includes(s.id));
    const sites = [];
    for (const s of mine) {
      const { notes: _internal, ...agreement } = s.agreement || {};
      sites.push({
        id: s.id,
        name: s.name,
        agreement: s.agreement ? agreement : null,
        rostered_hours: s.rostered_hours + s.open_hours,
        weeks: s.agreement ? await deliveredByWeek(s.id, 4) : [],
      });
    }
    res.json({ sites });
  })
);

/* ===================================================== calls for service === */

/**
 * Their calls: what they raised from here and what the office raised for their
 * property, with where each one has got to. A client can ask for an officer
 * for something urgent or routine; an emergency is a 911 call, and the form
 * says so rather than offering it.
 */
clientRouter.get(
  '/calls',
  requireClient,
  wrap(async (req, res) => {
    const sc = sitesFilter(req);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 92);
    const rows = await db
      .prepare(
        `${callSelect}
         WHERE c.site_id IN (${sc.sql}) AND (c.status IN (${OPEN_SQL}) OR c.created_at >= ?)
         ORDER BY CASE WHEN c.status IN (${OPEN_SQL}) THEN 0 ELSE 1 END, c.created_at DESC LIMIT 200`
      )
      .all(...sc.ids, toSql(new Date(Date.now() - days * 86400000)));
    const now = new Date();
    const calls = rows.map((c) => ({ ...presentCallForClient(c, now), raised_by_you: c.client_user_id === req.client.id }));
    const timed = calls.filter((c) => c.minutes_to_arrive != null);
    res.json({
      calls,
      summary: {
        open: calls.filter((c) => c.open).length,
        cleared: calls.filter((c) => c.status === 'cleared').length,
        avgMinutesToArrive: timed.length ? Math.round(timed.reduce((n, c) => n + c.minutes_to_arrive, 0) / timed.length) : null,
      },
    });
  })
);

const clientCallSchema = z.object({
  siteId: z.number().int().positive(),
  callType: z.enum(CALL_TYPES),
  priority: z.number().int().refine((n) => n === 2 || n === 3, 'For an emergency, call 911 first, then the office.'),
  location: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().min(5, 'Tell us what is happening.').max(1000),
  callerName: z.string().trim().max(80).nullable().optional(),
  callerPhone: z.string().trim().max(30).nullable().optional(),
});

clientRouter.post(
  '/calls',
  requireClient,
  rateLimit({ windowMs: 60 * 60000, max: 20, key: (req) => `calls:${req.client.id}` }),
  wrap(async (req, res) => {
    const body = parse(clientCallSchema, req.body);
    const siteId = assertSite(req, body.siteId);
    const mine = Number((await db
      .prepare(`SELECT COUNT(*) AS n FROM service_calls WHERE client_user_id = ? AND status IN (${OPEN_SQL})`)
      .get(req.client.id)).n);
    if (mine >= 3) {
      throw new HttpError(409, 'You have three calls open already. Call the office if something else needs an officer now.');
    }
    const info = await db
      .prepare(
        `INSERT INTO service_calls (site_id, call_type, priority, location, description, caller_name, caller_phone, source, client_user_id)
         VALUES (?,?,?,?,?,?,?, 'client', ?)`
      )
      .run(siteId, body.callType, body.priority, body.location || null, body.description,
        body.callerName || req.client.name, body.callerPhone || null, req.client.id);
    const id = Number(info.lastInsertRowid);
    await logEvent(id, 'raised', { clientUserId: req.client.id });
    await audit(null, 'call.raised', 'service_call', id, { client: req.client.id, priority: body.priority }, req.ip);
    const call = await loadCall(id);
    await pushToSupervisors(call, `${body.priority === 2 ? 'Urgent call' : 'Call'} from ${call.site_name}`);
    res.status(201).json({ call: presentCallForClient(call) });
  })
);

clientRouter.post(
  '/calls/:id/cancel',
  requireClient,
  wrap(async (req, res) => {
    const sc = scope(req);
    const call = await db
      .prepare(`SELECT * FROM service_calls WHERE id = ? AND site_id IN (${sc.sql})`)
      .get(idParam(req.params.id, 'call'), ...sc.ids);
    if (!call) throw new HttpError(404, 'Call not found.');
    if (!['open', 'assigned', 'en_route'].includes(call.status)) {
      throw new HttpError(409, call.status === 'on_scene' ? 'Our officer is already there. Talk to them, or call the office.' : 'That call is already closed.');
    }
    const body = parse(z.object({ reason: z.string().trim().max(300).nullable().optional() }), req.body || {});
    const reason = body.reason || 'No longer needed (cancelled by the client).';
    await db.prepare(`UPDATE service_calls SET status = 'cancelled', cancelled_at = now(), cancel_reason = ? WHERE id = ?`).run(reason, call.id);
    await logEvent(call.id, 'cancelled', { clientUserId: req.client.id, note: reason });
    await audit(null, 'call.cancelled', 'service_call', call.id, { client: req.client.id }, req.ip);
    // Whoever was on the way can stand down.
    if (call.assigned_to) {
      const loaded = await loadCall(call.id);
      pushAsync([call.assigned_to], { title: 'Call cancelled', body: `${loaded.site_name}: ${reason}`.slice(0, 160), data: { type: 'call', id: call.id } });
    }
    res.json({ ok: true });
  })
);

/* ============================================================ post orders === */

/**
 * The standing orders our officers work to at each of the client's posts,
 * and the changes the client has asked for. Who on our side wrote a version
 * is internal; the client sees the version, when it took effect and why.
 */
const clientRequest = (r) => ({
  id: r.id, post_id: r.post_id, body: r.body, status: r.status, response: r.response,
  applied_version: r.applied_version ?? null, mine: r.mine,
  ...isoFields({ created_at: r.created_at, resolved_at: r.resolved_at }, ['created_at', 'resolved_at']),
});

async function clientPostOrders(req) {
  const sites = [];
  for (const siteId of req.clientSiteIds) {
    const site = await db.prepare(`SELECT id, name FROM sites WHERE id = ?`).get(siteId);
    if (!site) continue;
    const posts = await db
      .prepare(`SELECT id, name, post_code FROM posts WHERE site_id = ? AND active = 1 ORDER BY name`)
      .all(siteId);
    for (const post of posts) {
      const order = await currentOrders(post.id);
      post.order = order?.body.trim()
        ? { version: order.version, body: order.body, change_note: order.change_note, ...isoFields({ created_at: order.created_at }, ['created_at']) }
        : null;
      post.requests = (
        await db
          .prepare(
            `SELECT r.*, o.version AS applied_version, (r.client_user_id = ?) AS mine
             FROM post_order_requests r LEFT JOIN post_orders o ON o.id = r.applied_order_id
             WHERE r.post_id = ? ORDER BY r.created_at DESC LIMIT 10`
          )
          .all(req.client.id, post.id)
      ).map(clientRequest);
    }
    sites.push({ ...site, posts });
  }
  return sites;
}

clientRouter.get(
  '/post-orders',
  requireClient,
  wrap(async (req, res) => {
    res.json({ sites: await clientPostOrders(req) });
  })
);

/** Ask for a change to a post's orders. A supervisor applies or declines it. */
clientRouter.post(
  '/post-orders/requests',
  requireClient,
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        postId: z.number().int().positive(),
        body: z.string().trim().min(10, 'Say what should change, so we can act on it.').max(2000),
      }),
      req.body
    );
    const post = await db.prepare(`SELECT id, site_id FROM posts WHERE id = ? AND active = 1`).get(body.postId);
    if (!post || !req.clientSiteIds.includes(post.site_id)) throw new HttpError(404, 'Post not found.');
    const open = await db
      .prepare(`SELECT COUNT(*) AS n FROM post_order_requests WHERE post_id = ? AND client_user_id = ? AND status = 'open'`)
      .get(post.id, req.client.id);
    if (Number(open.n) >= 3) {
      throw new HttpError(409, 'You already have three changes waiting for this post. We will answer those first.');
    }
    const info = await db
      .prepare(`INSERT INTO post_order_requests (post_id, client_user_id, body) VALUES (?,?,?)`)
      .run(post.id, req.client.id, body.body);
    await audit(null, 'post_order_request.created', 'post_order_request', info.lastInsertRowid, { client: req.client.id, postId: post.id }, req.ip);
    res.status(201).json({ sites: await clientPostOrders(req) });
  })
);

clientRouter.post(
  '/post-orders/requests/:id/withdraw',
  requireClient,
  wrap(async (req, res) => {
    const row = await db.prepare(`SELECT * FROM post_order_requests WHERE id = ?`).get(idParam(req.params.id, 'request'));
    if (!row || row.client_user_id !== req.client.id) throw new HttpError(404, 'Request not found.');
    if (row.status !== 'open') throw new HttpError(409, 'That request has already been answered.');
    await db.prepare(`UPDATE post_order_requests SET status = 'withdrawn', resolved_at = now() WHERE id = ?`).run(row.id);
    await audit(null, 'post_order_request.withdrawn', 'post_order_request', row.id, { client: req.client.id }, req.ip);
    res.json({ sites: await clientPostOrders(req) });
  })
);

/* ======================================================== monthly report === */

/** One property's month, for the client's file or their board. */
clientRouter.get(
  '/monthly',
  requireClient,
  wrap(async (req, res) => {
    const siteId = req.query.siteId ? assertSite(req, idParam(req.query.siteId, 'site')) : req.clientSiteIds[0];
    if (!siteId) throw new HttpError(404, 'No properties are linked to this account.');
    res.json(await siteMonth(siteId, req.query.month ? String(req.query.month) : monthKey()));
  })
);

/* ======================================================== email settings === */

const notificationSettings = (c) => ({ seriousIncidents: Boolean(c.notify_serious_incidents), dailyReport: Boolean(c.notify_daily_report) });

/** Which emails this contact gets: serious incident alerts, and the daily report. */
clientRouter.get(
  '/notifications',
  requireClient,
  wrap(async (req, res) => {
    const c = await db.prepare(`SELECT notify_serious_incidents, notify_daily_report FROM client_users WHERE id = ?`).get(req.client.id);
    res.json({ notifications: notificationSettings(c) });
  })
);

clientRouter.patch(
  '/notifications',
  requireClient,
  wrap(async (req, res) => {
    const body = parse(z.object({ seriousIncidents: z.boolean().optional(), dailyReport: z.boolean().optional() }).strict(), req.body);
    if (body.seriousIncidents === undefined && body.dailyReport === undefined) throw new HttpError(422, 'Say which email to turn on or off.');
    if (body.seriousIncidents !== undefined) {
      await db.prepare(`UPDATE client_users SET notify_serious_incidents = ? WHERE id = ?`).run(body.seriousIncidents, req.client.id);
    }
    if (body.dailyReport !== undefined) {
      await db.prepare(`UPDATE client_users SET notify_daily_report = ? WHERE id = ?`).run(body.dailyReport, req.client.id);
    }
    await audit(null, 'client.notifications_changed', 'client_user', req.client.id, body, req.ip);
    const c = await db.prepare(`SELECT notify_serious_incidents, notify_daily_report FROM client_users WHERE id = ?`).get(req.client.id);
    res.json({ notifications: notificationSettings(c) });
  })
);
