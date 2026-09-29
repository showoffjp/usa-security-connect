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
import { HttpError, wrap, parse, isoFields, rateLimit, parseDay, toDateString, sqlToIso } from '../lib/http.js';
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
import { toHours, daysOverdue } from '../shared.js';
import * as storage from '../services/storage.js';
import { toSql } from '../services/compliance.js';

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

    res.json({ incident: isoFields(row, ['occurred_at', 'created_at']), photos });
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
        `SELECT v.id, v.visited_at, v.uniform_ok, v.post_orders_reviewed,
                v.equipment_ok, v.site_secure, v.rating, v.notes,
                s.name AS site_name, p.name AS post_name
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
});

clientRouter.get(
  '/invoices',
  wrap(async (req, res) => {
    const { sql, ids } = sitesFilter(req);

    // A draft has not been issued and may still change, so it is not theirs
    // to see yet.
    const rows = await db
      .prepare(
        `SELECT i.*, s.name AS site_name, s.client_name
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
    const { sql, ids } = scope(req);
    const row = await db
      .prepare(
        `SELECT i.*, s.name AS site_name, s.client_name, s.address, s.city, s.state, s.postal_code
         FROM invoices i JOIN sites s ON s.id = i.site_id
         WHERE i.id = ? AND s.id IN (${sql}) AND i.status IN ('sent','paid')`
      )
      .get(req.params.id, ...ids);
    if (!row) throw new HttpError(404, 'Invoice not found.');

    const lines = await db
      .prepare(
        `SELECT description, minutes, rate_cents, amount_cents
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
    });
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
        `SELECT v.visited_at, v.notes, v.rating, p.name AS post_name
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
    const onSiteNow = await db
      .prepare(`SELECT COUNT(*) AS n FROM visitor_log WHERE site_id = ? AND departed_at IS NULL`)
      .get(siteId);

    res.json({
      date: toDateString(start),
      site,
      visitors: visitors.map((v) => isoFields(v, ['arrived_at', 'departed_at'])),
      visitorsOnSiteNow: Number(onSiteNow.n),
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
