import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import {
  ROLES,
  atLeast,
  CERTIFICATION_TYPES,
  TIME_OFF_TYPES,
  expiryState,
} from '../shared.js';
import { toSql } from '../services/compliance.js';
import { pushAsync, supervisorIds } from '../services/push.js';

/* ========================================================= certifications === */

export const certificationsRouter = Router();
certificationsRouter.use(requireAuth);

/** Officers see their own; supervisors can look at anyone's. */
function targetUserId(req) {
  const requested = Number(req.query.userId || req.body?.userId);
  if (!requested || requested === req.user.id) return req.user.id;
  if (!atLeast(req.user.role, ROLES.SUPERVISOR)) {
    throw new HttpError(403, 'You can only view your own certifications.');
  }
  return requested;
}

certificationsRouter.get(
  '/',
  wrap(async (req, res) => {
    const userId = targetUserId(req);
    const rows = (await db
      .prepare(
        `SELECT c.*, v.first_name || ' ' || v.last_name AS verified_by_name
         FROM certifications c
         LEFT JOIN users v ON v.id = c.verified_by
         WHERE c.user_id = ?
         ORDER BY c.expires_on IS NULL, c.expires_on`
      )
      .all(userId));

    res.json({
      certifications: rows.map((c) => ({
        ...isoFields(c, ['created_at', 'verified_at']),
        expiry: expiryState(c.expires_on),
      })),
    });
  })
);

/** Everything expiring across the company - the compliance officer's view. */
certificationsRouter.get(
  '/expiring',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 365);

    const certs = (await db
      .prepare(
        `SELECT c.*, u.employee_code, u.first_name || ' ' || u.last_name AS officer, u.status
         FROM certifications c
         JOIN users u ON u.id = c.user_id
         WHERE c.expires_on IS NOT NULL
           AND u.status IN ('active','on_leave')
           AND date(c.expires_on) <= date('now', '+' || ? || ' days')
         ORDER BY c.expires_on`
      )
      .all(days));

    // The licence fields on the user record predate the certifications table,
    // so they are folded in here rather than being silently missed.
    const licences = (await db
      .prepare(
        `SELECT id AS user_id, employee_code, first_name || ' ' || last_name AS officer,
                license_type AS type, license_number AS number, license_expires_on AS expires_on
         FROM users
         WHERE license_expires_on IS NOT NULL
           AND status IN ('active','on_leave')
           AND date(license_expires_on) <= date('now', '+' || ? || ' days')
         ORDER BY license_expires_on`
      )
      .all(days));

    const insurance = (await db
      .prepare(
        `SELECT id AS user_id, employee_code, first_name || ' ' || last_name AS officer,
                'Certificate of Insurance' AS type, NULL AS number, insurance_expires_on AS expires_on
         FROM users
         WHERE insurance_expires_on IS NOT NULL
           AND employment_type = '1099'
           AND status IN ('active','on_leave')
           AND date(insurance_expires_on) <= date('now', '+' || ? || ' days')
         ORDER BY insurance_expires_on`
      )
      .all(days));

    const decorate = (row, source) => ({
      ...row,
      source,
      expiry: expiryState(row.expires_on),
    });

    res.json({
      items: [
        ...certs.map((c) => decorate(c, 'certification')),
        ...licences.map((l) => decorate(l, 'licence')),
        ...insurance.map((i) => decorate(i, 'insurance')),
      ].sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on))),
    });
  })
);

const certSchema = z.object({
  userId: z.number().int().positive(),
  type: z.string().trim().min(2).max(120),
  number: z.string().trim().max(80).optional(),
  issuingAuthority: z.string().trim().max(120).optional(),
  issuedOn: z.string().nullable().optional(),
  expiresOn: z.string().nullable().optional(),
  notes: z.string().max(1000).optional(),
});

certificationsRouter.post(
  '/',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const body = parse(certSchema, req.body);
    const info = (await db
      .prepare(
        `INSERT INTO certifications
         (user_id, type, number, issuing_authority, issued_on, expires_on, notes, verified_by, verified_at)
         VALUES (?,?,?,?,?,?,?,?,datetime('now'))`
      )
      .run(
        body.userId,
        body.type,
        body.number ?? null,
        body.issuingAuthority ?? null,
        body.issuedOn || null,
        body.expiresOn || null,
        body.notes ?? null,
        req.user.id
      ));

    await audit(req.user.id, 'certification.added', 'user', body.userId, { type: body.type }, req.ip);
    res.status(201).json({
      certification: (await db.prepare(`SELECT * FROM certifications WHERE id = ?`).get(info.lastInsertRowid)),
    });
  })
);

certificationsRouter.delete(
  '/:id',
  requireRole(ROLES.ADMIN),
  wrap(async (req, res) => {
    (await db.prepare(`DELETE FROM certifications WHERE id = ?`).run(req.params.id));
    await audit(req.user.id, 'certification.removed', 'certification', Number(req.params.id), null, req.ip);
    res.json({ ok: true });
  })
);

export { CERTIFICATION_TYPES };

/* ============================================================ availability === */

export const availabilityRouter = Router();
availabilityRouter.use(requireAuth);

availabilityRouter.get(
  '/',
  wrap(async (req, res) => {
    const userId = targetUserId(req);
    const rows = (await db
      .prepare(`SELECT * FROM availability WHERE user_id = ? ORDER BY weekday`)
      .all(userId));
    res.json({ availability: rows });
  })
);

const availabilitySchema = z.object({
  userId: z.number().int().positive().optional(),
  days: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        available: z.boolean(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
        endTime: z.string().regex(/^\d{2}:\d{2}$/).default('23:59'),
        note: z.string().max(200).optional(),
      })
    )
    .max(7),
});

availabilityRouter.put(
  '/',
  wrap(async (req, res) => {
    const body = parse(availabilitySchema, req.body);
    const userId = body.userId && body.userId !== req.user.id ? body.userId : req.user.id;

    if (userId !== req.user.id && !atLeast(req.user.role, ROLES.SUPERVISOR)) {
      throw new HttpError(403, 'You can only set your own availability.');
    }

    await db.transaction(async () => {
      for (const day of body.days) {
        (await db.prepare(
          `INSERT INTO availability (user_id, weekday, start_time, end_time, available, note)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(user_id, weekday) DO UPDATE SET
             start_time = excluded.start_time,
             end_time = excluded.end_time,
             available = excluded.available,
             note = excluded.note`
        ).run(userId, day.weekday, day.startTime, day.endTime, day.available ? 1 : 0, day.note ?? null));
      }
    })();

    await audit(req.user.id, 'availability.updated', 'user', userId, null, req.ip);
    res.json({ availability: (await db.prepare(`SELECT * FROM availability WHERE user_id = ? ORDER BY weekday`).all(userId)) });
  })
);

/* ================================================================ time off === */

export const timeOffRouter = Router();
timeOffRouter.use(requireAuth);

timeOffRouter.get(
  '/',
  wrap(async (req, res) => {
    const all = req.query.scope === 'all' && atLeast(req.user.role, ROLES.SUPERVISOR);
    const rows = (await db
      .prepare(
        `SELECT t.*, u.employee_code, u.first_name || ' ' || u.last_name AS officer,
                d.first_name || ' ' || d.last_name AS decided_by_name
         FROM time_off_requests t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN users d ON d.id = t.decided_by
         ${all ? '' : 'WHERE t.user_id = ?'}
         ${req.query.status ? (all ? 'WHERE' : 'AND') + ' t.status = ?' : ''}
         ORDER BY t.starts_on DESC LIMIT 200`
      )
      .all(...(all ? [] : [req.user.id]), ...(req.query.status ? [req.query.status] : [])));

    res.json({ requests: rows.map((r) => isoFields(r, ['created_at', 'decided_at'])) });
  })
);

const timeOffSchema = z
  .object({
    type: z.enum(TIME_OFF_TYPES).default('vacation'),
    startsOn: z.string().min(1),
    endsOn: z.string().min(1),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((d) => new Date(d.endsOn) >= new Date(d.startsOn), {
    message: 'The end date cannot be before the start date.',
    path: ['endsOn'],
  });

timeOffRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = parse(timeOffSchema, req.body);

    // Overlapping requests just create confusion for whoever approves them.
    const clash = (await db
      .prepare(
        `SELECT id FROM time_off_requests
         WHERE user_id = ? AND status IN ('pending','approved')
           AND date(starts_on) <= date(?) AND date(ends_on) >= date(?)`
      )
      .get(req.user.id, body.endsOn, body.startsOn));
    if (clash) throw new HttpError(409, 'You already have a request covering those dates.');

    const info = (await db
      .prepare(
        `INSERT INTO time_off_requests (user_id, type, starts_on, ends_on, reason)
         VALUES (?,?,?,?,?)`
      )
      .run(req.user.id, body.type, body.startsOn, body.endsOn, body.reason ?? null));

    await audit(req.user.id, 'timeoff.requested', 'time_off_request', Number(info.lastInsertRowid), body, req.ip);

    pushAsync(await supervisorIds(), {
      title: 'Time-off request',
      body: `${req.user.first_name} ${req.user.last_name} requested ${body.type} leave from ${body.startsOn}.`,
      data: { type: 'time_off', id: Number(info.lastInsertRowid) },
    });

    res.status(201).json({
      request: (await db.prepare(`SELECT * FROM time_off_requests WHERE id = ?`).get(info.lastInsertRowid)),
    });
  })
);

const decisionSchema = z.object({
  status: z.enum(['approved', 'denied']),
  note: z.string().trim().max(500).optional(),
});

timeOffRouter.patch(
  '/:id',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const body = parse(decisionSchema, req.body);
    const request = (await db.prepare(`SELECT * FROM time_off_requests WHERE id = ?`).get(req.params.id));
    if (!request) throw new HttpError(404, 'Request not found.');
    if (request.status !== 'pending') throw new HttpError(409, 'That request has already been decided.');

    (await db.prepare(
      `UPDATE time_off_requests
       SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?
       WHERE id = ?`
    ).run(body.status, req.user.id, body.note ?? null, request.id));

    // An approved request with shifts already on the roster needs a human to
    // re-cover them, so say so plainly rather than silently unassigning.
    const affected = (await db
      .prepare(
        `SELECT COUNT(*) AS n FROM shifts
         WHERE user_id = ? AND status = 'scheduled'
           AND date(starts_at) BETWEEN date(?) AND date(?)`
      )
      .get(request.user_id, request.starts_on, request.ends_on)).n;

    await audit(req.user.id, `timeoff.${body.status}`, 'time_off_request', request.id, { affected }, req.ip);

    pushAsync([request.user_id], {
      title: `Time off ${body.status}`,
      body: `Your ${request.type} request for ${request.starts_on} was ${body.status}.`,
      data: { type: 'time_off', id: request.id },
    });

    res.json({
      request: (await db.prepare(`SELECT * FROM time_off_requests WHERE id = ?`).get(request.id)),
      shiftsToRecover: body.status === 'approved' ? affected : 0,
    });
  })
);

timeOffRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const request = (await db.prepare(`SELECT * FROM time_off_requests WHERE id = ?`).get(req.params.id));
    if (!request) throw new HttpError(404, 'Request not found.');
    if (request.user_id !== req.user.id && !atLeast(req.user.role, ROLES.ADMIN)) {
      throw new HttpError(403, 'You can only withdraw your own request.');
    }
    if (request.status !== 'pending' && !atLeast(req.user.role, ROLES.ADMIN)) {
      throw new HttpError(409, 'That request has already been decided.');
    }
    (await db.prepare(`DELETE FROM time_off_requests WHERE id = ?`).run(request.id));
    res.json({ ok: true });
  })
);
