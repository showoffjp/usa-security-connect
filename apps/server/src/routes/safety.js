import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, sqlToIso } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, BREAK_TYPES, minutesBetween } from '../shared.js';
import { toSql } from '../services/compliance.js';
import { pushAsync, supervisorIds } from '../services/push.js';

/* ================================================================== panic === */

export const panicRouter = Router();
panicRouter.use(requireAuth);

const panicSchema = z.object({
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  accuracy: z.number().nullable().optional(),
  note: z.string().max(500).optional(),
});

/**
 * Duress button.
 *
 * Deliberately permissive: it never validates the officer onto a shift, never
 * rejects a missing GPS fix, and returns 201 as soon as the row is written.
 * Someone pressing this is in trouble, and the alert must land even if every
 * other part of their session is in a strange state.
 */
panicRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = parse(panicSchema, req.body);

    const entry = (await db
      .prepare(`SELECT id, post_id FROM time_entries WHERE user_id = ? AND clock_out_at IS NULL LIMIT 1`)
      .get(req.user.id));

    // An officer hammering the button must not create a wall of alerts; an
    // alert already open is reused so responders see one incident.
    const open = (await db
      .prepare(`SELECT * FROM panic_alerts WHERE user_id = ? AND status IN ('active','acknowledged') LIMIT 1`)
      .get(req.user.id));

    if (open) {
      (await db.prepare(
        `UPDATE panic_alerts SET latitude = COALESCE(?, latitude),
           longitude = COALESCE(?, longitude), accuracy = COALESCE(?, accuracy)
         WHERE id = ?`
      ).run(body.latitude ?? null, body.longitude ?? null, body.accuracy ?? null, open.id));
      return res.status(200).json({ alert: isoFields(open, ['triggered_at']), reused: true });
    }

    const info = (await db
      .prepare(
        `INSERT INTO panic_alerts
         (user_id, time_entry_id, post_id, latitude, longitude, accuracy, note)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        req.user.id,
        entry?.id ?? null,
        entry?.post_id ?? null,
        body.latitude ?? null,
        body.longitude ?? null,
        body.accuracy ?? null,
        body.note ?? null
      ));

    const alert = (await db.prepare(`SELECT * FROM panic_alerts WHERE id = ?`).get(info.lastInsertRowid));
    await audit(req.user.id, 'panic.triggered', 'panic_alert', alert.id, null, req.ip);

    const post = entry?.post_id
      ? (await db.prepare(`SELECT name FROM posts WHERE id = ?`).get(entry.post_id))
      : null;

    pushAsync(await supervisorIds(), {
      title: 'EMERGENCY - officer needs help',
      body: `${req.user.first_name} ${req.user.last_name}${post ? ` at ${post.name}` : ''} triggered the duress button.`,
      data: { type: 'panic', id: alert.id },
      priority: 'high',
    });

    res.status(201).json({ alert: isoFields(alert, ['triggered_at']) });
  })
);

/** The officer's own view - so they can see help is coming, or stand it down. */
panicRouter.get(
  '/mine',
  wrap(async (req, res) => {
    const alert = (await db
      .prepare(
        `SELECT p.*, a.first_name || ' ' || a.last_name AS acknowledged_by_name
         FROM panic_alerts p
         LEFT JOIN users a ON a.id = p.acknowledged_by
         WHERE p.user_id = ? AND p.status IN ('active','acknowledged')
         ORDER BY p.triggered_at DESC LIMIT 1`
      )
      .get(req.user.id));
    res.json({ alert: alert ? isoFields(alert, ['triggered_at', 'acknowledged_at']) : null });
  })
);

/** Officers can cancel their own alert; that is recorded as a false alarm. */
panicRouter.post(
  '/:id/stand-down',
  wrap(async (req, res) => {
    const alert = (await db.prepare(`SELECT * FROM panic_alerts WHERE id = ?`).get(req.params.id));
    if (!alert) throw new HttpError(404, 'Alert not found.');
    if (alert.user_id !== req.user.id) throw new HttpError(403, 'That alert belongs to another officer.');

    (await db.prepare(
      `UPDATE panic_alerts SET status = 'false_alarm', resolved_at = datetime('now'),
         resolution_note = ? WHERE id = ?`
    ).run(String(req.body?.note || 'Stood down by the officer.').slice(0, 500), alert.id));

    await audit(req.user.id, 'panic.stood_down', 'panic_alert', alert.id, null, req.ip);
    pushAsync(await supervisorIds(), {
      title: 'Duress alert stood down',
      body: `${req.user.first_name} ${req.user.last_name} cancelled their alert.`,
      data: { type: 'panic', id: alert.id },
    });

    res.json({ ok: true });
  })
);

panicRouter.get(
  '/',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT p.*, u.employee_code, u.first_name || ' ' || u.last_name AS officer, u.phone,
                po.name AS post_name, s.name AS site_name,
                a.first_name || ' ' || a.last_name AS acknowledged_by_name
         FROM panic_alerts p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN posts po ON po.id = p.post_id
         LEFT JOIN sites s ON s.id = po.site_id
         LEFT JOIN users a ON a.id = p.acknowledged_by
         ${req.query.scope === 'all' ? '' : `WHERE p.status IN ('active','acknowledged')`}
         ORDER BY p.triggered_at DESC LIMIT 100`
      )
      .all());
    res.json({ alerts: rows.map((r) => isoFields(r, ['triggered_at', 'acknowledged_at', 'resolved_at'])) });
  })
);

panicRouter.post(
  '/:id/acknowledge',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const alert = (await db.prepare(`SELECT * FROM panic_alerts WHERE id = ?`).get(req.params.id));
    if (!alert) throw new HttpError(404, 'Alert not found.');

    (await db.prepare(
      `UPDATE panic_alerts SET status = 'acknowledged', acknowledged_by = ?,
         acknowledged_at = datetime('now') WHERE id = ?`
    ).run(req.user.id, alert.id));

    await audit(req.user.id, 'panic.acknowledged', 'panic_alert', alert.id, null, req.ip);

    // Tell the officer help is on the way - the whole point of the feature.
    pushAsync([alert.user_id], {
      title: 'Help is on the way',
      body: `${req.user.first_name} ${req.user.last_name} has seen your alert and is responding.`,
      data: { type: 'panic', id: alert.id },
      priority: 'high',
    });

    res.json({ ok: true });
  })
);

const resolveSchema = z.object({
  status: z.enum(['resolved', 'false_alarm']).default('resolved'),
  note: z.string().trim().min(3, 'Record what happened.').max(1000),
});

panicRouter.post(
  '/:id/resolve',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const body = parse(resolveSchema, req.body);
    (await db.prepare(
      `UPDATE panic_alerts SET status = ?, resolved_at = datetime('now'), resolution_note = ?
       WHERE id = ?`
    ).run(body.status, body.note, req.params.id));

    await audit(req.user.id, 'panic.resolved', 'panic_alert', Number(req.params.id), { status: body.status }, req.ip);
    res.json({ ok: true });
  })
);

/* ================================================================= breaks === */

export const breaksRouter = Router();
breaksRouter.use(requireAuth);

async function openEntry(userId) {
  return (await db
    .prepare(`SELECT * FROM time_entries WHERE user_id = ? AND clock_out_at IS NULL LIMIT 1`)
    .get(userId));
}

breaksRouter.get(
  '/current',
  wrap(async (req, res) => {
    const entry = await openEntry(req.user.id);
    if (!entry) return res.json({ onBreak: null, breaks: [] });

    const breaks = (await db
      .prepare(`SELECT * FROM breaks WHERE time_entry_id = ? ORDER BY started_at`)
      .all(entry.id));

    const active = breaks.find((b) => !b.ended_at) || null;

    res.json({
      onBreak: active
        ? {
            ...isoFields(active, ['started_at', 'ended_at']),
            minutes_so_far: minutesBetween(sqlToIso(active.started_at), new Date().toISOString()),
          }
        : null,
      breaks: breaks.map((b) => isoFields(b, ['started_at', 'ended_at'])),
      totalUnpaidMinutes: entry.unpaid_break_minutes || 0,
    });
  })
);

const startBreakSchema = z.object({
  type: z.enum(BREAK_TYPES).default('meal'),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
});

breaksRouter.post(
  '/start',
  wrap(async (req, res) => {
    const body = parse(startBreakSchema, req.body);
    const entry = await openEntry(req.user.id);
    if (!entry) throw new HttpError(409, 'You must be clocked in to start a break.');

    const active = (await db
      .prepare(`SELECT id FROM breaks WHERE time_entry_id = ? AND ended_at IS NULL`)
      .get(entry.id));
    if (active) throw new HttpError(409, 'You are already on a break.');

    // Rest breaks stay paid; meal breaks are deducted from the shift.
    const paid = body.type === 'rest' ? 1 : 0;

    const info = (await db
      .prepare(
        `INSERT INTO breaks (time_entry_id, user_id, type, paid, started_at, start_lat, start_lng)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(entry.id, req.user.id, body.type, paid, toSql(new Date()), body.latitude ?? null, body.longitude ?? null));

    await audit(req.user.id, 'break.started', 'time_entry', entry.id, { type: body.type }, req.ip);
    res.status(201).json({ break: (await db.prepare(`SELECT * FROM breaks WHERE id = ?`).get(info.lastInsertRowid)) });
  })
);

breaksRouter.post(
  '/end',
  wrap(async (req, res) => {
    const entry = await openEntry(req.user.id);
    if (!entry) throw new HttpError(409, 'You are not clocked in.');

    const active = (await db
      .prepare(`SELECT * FROM breaks WHERE time_entry_id = ? AND ended_at IS NULL LIMIT 1`)
      .get(entry.id));
    if (!active) throw new HttpError(409, 'You are not on a break.');

    const now = new Date();
    const minutes = Math.max(0, minutesBetween(sqlToIso(active.started_at), now.toISOString()));

    await db.transaction(async () => {
      (await db.prepare(`UPDATE breaks SET ended_at = ?, minutes = ? WHERE id = ?`).run(
        toSql(now),
        minutes,
        active.id
      ));

      // Keep the running unpaid total on the time entry so payroll reads one number.
      const unpaid = (await db
        .prepare(
          `SELECT COALESCE(SUM(minutes),0) AS m FROM breaks
           WHERE time_entry_id = ? AND paid = 0 AND ended_at IS NOT NULL`
        )
        .get(entry.id)).m;
      (await db.prepare(`UPDATE time_entries SET unpaid_break_minutes = ? WHERE id = ?`).run(unpaid, entry.id));
    })();

    await audit(req.user.id, 'break.ended', 'time_entry', entry.id, { minutes }, req.ip);
    res.json({ minutes, paid: Boolean(active.paid) });
  })
);
