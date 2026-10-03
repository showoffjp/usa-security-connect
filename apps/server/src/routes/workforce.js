import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, idParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import {
  ROLES,
  atLeast,
  CERTIFICATION_TYPES,
  TIME_OFF_TYPES,
  expiryState,
  PTO_CAP_HOURS,
  PTO_DAY_MAX_HOURS,
  ptoEligible,
} from '../shared.js';
import { toSql } from '../services/compliance.js';
import { pushAsync, supervisorIds } from '../services/push.js';
import { ptoBalance, ptoHistory, daysIn, PTO_RULES } from '../services/pto.js';
import { dayString } from '../services/payPeriods.js';

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
                d.first_name || ' ' || d.last_name AS decided_by_name,
                (SELECT COALESCE(SUM(l.hours), 0) FROM pto_ledger l WHERE l.user_id = t.user_id) AS pto_balance,
                pp.period_start AS pto_period_start, pp.period_end AS pto_period_end
         FROM time_off_requests t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN users d ON d.id = t.decided_by
         LEFT JOIN pay_periods pp ON pp.id = t.pto_paid_period_id
         ${all ? '' : 'WHERE t.user_id = ?'}
         ${req.query.status ? (all ? 'WHERE' : 'AND') + ' t.status = ?' : ''}
         ORDER BY t.starts_on DESC LIMIT 200`
      )
      .all(...(all ? [] : [req.user.id]), ...(req.query.status ? [req.query.status] : [])));

    res.json({ requests: rows.map(presentTimeOff) });
  })
);

/** A request as the screens read it: dates as days, paid time off as numbers. */
function presentTimeOff(r) {
  const out = isoFields(r, ['created_at', 'decided_at']);
  out.starts_on = dayString(r.starts_on);
  out.ends_on = dayString(r.ends_on);
  out.pto_hours = r.pto_hours == null ? null : Number(r.pto_hours);
  out.pto_pay = r.pto_pay_cents == null ? null : r.pto_pay_cents / 100;
  if ('pto_balance' in r) out.pto_balance = Math.round(Number(r.pto_balance) * 100) / 100;
  out.pto_paid_in = r.pto_period_start ? `${dayString(r.pto_period_start)} to ${dayString(r.pto_period_end)}` : null;
  delete out.pto_period_start;
  delete out.pto_period_end;
  return out;
}

async function ptoPerson(userId) {
  const u = await db.prepare(`SELECT id, employment_type, pay_type FROM users WHERE id = ?`).get(userId);
  if (!u) throw new HttpError(404, 'Employee not found.');
  return u;
}

/** My paid time off: the balance, the rules and the statement. */
timeOffRouter.get(
  '/pto',
  wrap(async (req, res) => {
    const u = await ptoPerson(req.user.id);
    res.json({ eligible: ptoEligible(u), ...(await ptoBalance(u.id)), rules: PTO_RULES, history: await ptoHistory(u.id) });
  })
);

/** Someone's paid time off, for the people who approve it. */
timeOffRouter.get(
  '/pto/:userId',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const u = await ptoPerson(idParam(req.params.userId, 'employee'));
    res.json({ eligible: ptoEligible(u), ...(await ptoBalance(u.id)), rules: PTO_RULES, history: await ptoHistory(u.id) });
  })
);

const adjustSchema = z.object({
  hours: z.coerce
    .number({ invalid_type_error: 'How many hours?' })
    .refine((h) => h !== 0, 'How many hours?')
    .refine((h) => Math.abs(h) <= 200, 'An adjustment is at most 200 hours.'),
  note: z.string().trim().min(5, 'Say why, for the record.').max(300),
});

/** The office corrects a balance: a carry-over, a payout on leaving, a mistake. */
timeOffRouter.post(
  '/pto/:userId/adjust',
  requireRole(ROLES.ADMIN),
  wrap(async (req, res) => {
    const body = parse(adjustSchema, req.body);
    const u = await ptoPerson(idParam(req.params.userId, 'employee'));
    if (!ptoEligible(u)) throw new HttpError(409, 'Only W-2 employees paid by the hour have paid time off.');
    const hours = Math.round(body.hours * 100) / 100;
    const { balance } = await ptoBalance(u.id);
    if (balance + hours < 0) {
      throw new HttpError(422, `That would take the balance below nothing: it is ${balance} h.`, [{ field: 'hours', message: `At most -${balance}.` }]);
    }
    if (balance + hours > PTO_CAP_HOURS) {
      throw new HttpError(422, `The balance is capped at ${PTO_CAP_HOURS} h.`, [{ field: 'hours', message: `At most ${Math.round((PTO_CAP_HOURS - balance) * 100) / 100}.` }]);
    }
    await db
      .prepare(`INSERT INTO pto_ledger (user_id, kind, hours, note, created_by) VALUES (?, 'adjustment', ?, ?, ?)`)
      .run(u.id, hours, body.note, req.user.id);
    await audit(req.user.id, 'pto.adjusted', 'user', u.id, { hours, note: body.note }, req.ip);
    res.status(201).json({ ...(await ptoBalance(u.id)), history: await ptoHistory(u.id) });
  })
);

const timeOffSchema = z
  .object({
    type: z.enum(TIME_OFF_TYPES).default('vacation'),
    startsOn: z.string().min(1),
    endsOn: z.string().min(1),
    reason: z.string().trim().max(1000).optional(),
    ptoHours: z.coerce.number().positive('How many hours?').max(1000).optional(),
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

    // Paid from the balance: only for those who earn it, never for unpaid
    // leave, no more than a long day each day, and no more than is left.
    const ptoHours = body.ptoHours ? Math.round(body.ptoHours * 100) / 100 : null;
    if (ptoHours) {
      const u = await ptoPerson(req.user.id);
      if (!ptoEligible(u)) throw new HttpError(422, 'Paid time off is for W-2 employees paid by the hour.', [{ field: 'ptoHours', message: 'Not for your pay type.' }]);
      if (body.type === 'unpaid') throw new HttpError(422, 'Unpaid leave is not paid from your balance.', [{ field: 'ptoHours', message: 'Pick another type, or leave this empty.' }]);
      const days = daysIn(body.startsOn, body.endsOn);
      if (ptoHours > days * PTO_DAY_MAX_HOURS) {
        throw new HttpError(422, `That is more than ${PTO_DAY_MAX_HOURS} hours a day.`, [{ field: 'ptoHours', message: `At most ${days * PTO_DAY_MAX_HOURS} for ${days} day${days === 1 ? '' : 's'}.` }]);
      }
      const { available } = await ptoBalance(u.id);
      if (ptoHours > available) {
        throw new HttpError(422, `You have ${available} hours of paid time off to use.`, [{ field: 'ptoHours', message: `At most ${available}.` }]);
      }
    }

    const info = (await db
      .prepare(
        `INSERT INTO time_off_requests (user_id, type, starts_on, ends_on, reason, pto_hours)
         VALUES (?,?,?,?,?,?)`
      )
      .run(req.user.id, body.type, body.startsOn, body.endsOn, body.reason ?? null, ptoHours));

    await audit(req.user.id, 'timeoff.requested', 'time_off_request', Number(info.lastInsertRowid), body, req.ip);

    pushAsync(await supervisorIds(), {
      title: 'Time-off request',
      body: `${req.user.first_name} ${req.user.last_name} requested ${body.type} leave from ${body.startsOn}.`,
      data: { type: 'time_off', id: Number(info.lastInsertRowid) },
    });

    res.status(201).json({
      request: presentTimeOff(await db.prepare(`SELECT * FROM time_off_requests WHERE id = ?`).get(info.lastInsertRowid)),
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

    // Approving paid time off spends it, so there has to be enough to spend.
    const ptoHours = request.pto_hours == null ? 0 : Number(request.pto_hours);
    if (body.status === 'approved' && ptoHours > 0) {
      const { balance } = await ptoBalance(request.user_id);
      if (ptoHours > balance) {
        throw new HttpError(409, `Only ${balance} hours of paid time off are left for this; ${ptoHours} were asked for.`);
      }
    }

    await db.transaction(async () => {
      await db.prepare(
        `UPDATE time_off_requests
         SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?
         WHERE id = ?`
      ).run(body.status, req.user.id, body.note ?? null, request.id);
      if (body.status === 'approved' && ptoHours > 0) {
        await db
          .prepare(`INSERT INTO pto_ledger (user_id, kind, hours, time_off_request_id, created_by) VALUES (?, 'used', ?, ?, ?)`)
          .run(request.user_id, -ptoHours, request.id, req.user.id);
      }
    })();

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
      request: presentTimeOff(await db.prepare(`SELECT * FROM time_off_requests WHERE id = ?`).get(request.id)),
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
    // Paid out already: taking it away now would leave the payroll wrong.
    if (request.pto_paid_period_id) {
      throw new HttpError(409, 'This paid time off has been paid with a closed payroll. Reopen that pay period first.');
    }
    // Deleting it hands its hours back: the ledger line goes with it.
    (await db.prepare(`DELETE FROM time_off_requests WHERE id = ?`).run(request.id));
    res.json({ ok: true });
  })
);
