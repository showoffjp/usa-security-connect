/**
 * Hiring: from an application on the website to an officer with a code and
 * a PIN.
 *
 *   POST /api/apply                    the public form (no session)
 *   /api/admin/hiring/...              the office's pipeline (supervisors read
 *                                      and move applicants; only an
 *                                      administrator hires)
 *
 * An applicant is not a user. They get a users row - and with it an employee
 * code, a starting PIN and access - only when they are hired, and only once
 * the required checks are done: a verified licence, a clear background check
 * and the right to work.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, idParam, rateLimit } from '../lib/http.js';
import { requireAuth, requireRole, hashPin, generatePin, generateEmployeeCode, publicUser } from '../lib/auth.js';
import {
  ROLES, HIRING_STAGES, OPEN_HIRING_STAGES, HIRING_CHECKS, LICENCE_CLASSES, APPLICANT_SOURCES, EMPLOYMENT_TYPES, PAY_TYPES,
} from '../shared.js';
import { send } from '../services/email.js';
import { recordPayHistory } from '../services/payHistory.js';

export const applyRouter = Router();
export const hiringRouter = Router();
hiringRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));
const onlyAdmin = requireRole(ROLES.ADMIN);

const DAY = 86400000;
const REQUIRED = HIRING_CHECKS.filter((c) => c.required).map((c) => c.key);
const CHECK_KEYS = HIRING_CHECKS.map((c) => c.key);

const applicationFields = {
  firstName: z.string().trim().min(1, 'Enter your first name.').max(60),
  lastName: z.string().trim().min(1, 'Enter your last name.').max(60),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(160),
  phone: z
    .string()
    .trim()
    .max(30)
    .refine((v) => v.replace(/\D/g, '').length >= 10, 'Enter a phone number we can call.'),
  city: z.string().trim().max(80).optional().nullable(),
  licenceClass: z.enum(LICENCE_CLASSES).default('none'),
  licenceNumber: z.string().trim().max(30).optional().nullable(),
  licenceExpiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the expiry date.').optional().nullable(),
  experience: z.string().trim().max(2000).optional().nullable(),
  availability: z.string().trim().max(300).optional().nullable(),
};

async function insertApplicant(body, source, referredBy) {
  const info = await db
    .prepare(
      `INSERT INTO applicants (first_name, last_name, email, phone, city, licence_class, licence_number, licence_expires_on,
         experience, availability, source, referred_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      body.firstName, body.lastName, body.email, body.phone, body.city || null, body.licenceClass,
      body.licenceNumber || null, body.licenceExpiresOn || null, body.experience || null, body.availability || null,
      source, referredBy || null
    );
  return Number(info.lastInsertRowid);
}

/* --------------------------------------------------------- public form --- */

/**
 * Apply. No session; five tries an hour from one address, a hidden field a
 * person never fills in, and one open application per email address.
 */
applyRouter.post(
  '/',
  rateLimit({ windowMs: 60 * 60000, max: Number(process.env.USC_APPLY_LIMIT_PER_IP) || 5, key: (req) => `apply:${req.ip}` }),
  wrap(async (req, res) => {
    const body = parse(z.object({ ...applicationFields, website: z.string().max(200).optional().nullable() }), req.body);
    // A bot fills in every field it finds. Say thank you and keep nothing.
    if (body.website) return res.status(201).json({ ok: true });

    const open = await db
      .prepare(`SELECT id FROM applicants WHERE lower(email) = ? AND stage NOT IN ('hired', 'rejected') LIMIT 1`)
      .get(body.email);
    if (open) {
      throw new HttpError(409, 'We already have an application from this email address. We will be in touch.', [
        { field: 'email', message: 'Already applied.' },
      ]);
    }
    const id = await insertApplicant(body, 'website', null);
    await send({
      to: body.email,
      name: `${body.firstName} ${body.lastName}`,
      kind: 'application_received',
      entity: 'applicant',
      entityId: id,
      subject: 'Your application to USA Security & Protection Group',
      body: [
        `Dear ${body.firstName},`,
        '',
        'Thank you for applying to work with us. Your application has reached our hiring team, and someone will call you on the number you gave us, usually within two working days.',
        '',
        body.licenceClass === 'none'
          ? 'Florida requires a Class D security licence to work as an officer. If you do not hold one yet, we can tell you how to get it when we call.'
          : 'Please have your security licence card to hand when we call.',
        '',
        'USA Security & Protection Group',
      ].join('\n'),
    });
    res.status(201).json({ ok: true });
  })
);

/* ------------------------------------------------------------ pipeline --- */

const applicantSelect = `
  SELECT a.*, u.employee_code AS hired_code,
         (SELECT COUNT(*) FROM applicant_checks c WHERE c.applicant_id = a.id) AS checks_done,
         (SELECT COUNT(*) FROM applicant_checks c WHERE c.applicant_id = a.id AND c.key IN (${REQUIRED.map(() => '?').join(',')})) AS required_done,
         (SELECT COUNT(*) FROM applicant_notes n WHERE n.applicant_id = a.id) AS note_count
  FROM applicants a LEFT JOIN users u ON u.id = a.hired_user_id`;

const present = (a) => {
  const row = isoFields(a, ['stage_changed_at', 'created_at']);
  return {
    ...row,
    licence_expires_on: a.licence_expires_on ? String(a.licence_expires_on).slice(0, 10) : null,
    checks_done: Number(a.checks_done || 0),
    required_done: Number(a.required_done || 0),
    ready_to_hire: Number(a.required_done || 0) === REQUIRED.length,
    note_count: Number(a.note_count || 0),
    days_in_stage: Math.floor((Date.now() - new Date(row.stage_changed_at).getTime()) / DAY),
  };
};

const loadApplicant = async (id) => {
  const a = await db.prepare(`${applicantSelect} WHERE a.id = ?`).get(...REQUIRED, idParam(id, 'applicant'));
  if (!a) throw new HttpError(404, 'Applicant not found.');
  return a;
};

async function detail(id) {
  const a = await loadApplicant(id);
  const checks = await db
    .prepare(
      `SELECT c.key, c.done_at, c.note, u.first_name || ' ' || u.last_name AS done_by_name
       FROM applicant_checks c LEFT JOIN users u ON u.id = c.done_by WHERE c.applicant_id = ?`
    )
    .all(a.id);
  const notes = await db
    .prepare(
      `SELECT n.id, n.body, n.created_at, u.first_name || ' ' || u.last_name AS author_name
       FROM applicant_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.applicant_id = ? ORDER BY n.created_at DESC, n.id DESC`
    )
    .all(a.id);
  const byKey = new Map(checks.map((c) => [c.key, isoFields(c, ['done_at'])]));
  return {
    applicant: present(a),
    checks: HIRING_CHECKS.map((c) => ({ ...c, done: byKey.has(c.key), ...(byKey.get(c.key) || {}) })),
    notes: notes.map((n) => isoFields(n, ['created_at'])),
  };
}

const note = (applicantId, authorId, body) =>
  db.prepare(`INSERT INTO applicant_notes (applicant_id, author_id, body) VALUES (?,?,?)`).run(applicantId, authorId, body);

/** Everyone in the pipeline, or one stage of it, with a count per stage. */
hiringRouter.get(
  '/',
  wrap(async (req, res) => {
    const stage = HIRING_STAGES.includes(req.query.stage) ? req.query.stage : null;
    const rows = await db
      .prepare(
        `${applicantSelect} WHERE ${stage ? 'a.stage = ?' : `a.stage IN (${OPEN_HIRING_STAGES.map(() => '?').join(',')})`}
         ORDER BY a.stage_changed_at, a.id LIMIT 300`
      )
      .all(...REQUIRED, ...(stage ? [stage] : OPEN_HIRING_STAGES));
    const counts = Object.fromEntries(HIRING_STAGES.map((s) => [s, 0]));
    for (const r of await db.prepare(`SELECT stage, COUNT(*) AS n FROM applicants GROUP BY stage`).all()) counts[r.stage] = Number(r.n);
    res.json({ applicants: rows.map(present), counts });
  })
);

hiringRouter.get(
  '/:id',
  wrap(async (req, res) => {
    res.json(await detail(req.params.id));
  })
);

/** The office enters a walk-in or a referral. */
hiringRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        ...applicationFields,
        source: z.enum(APPLICANT_SOURCES).default('walk_in'),
        referredBy: z.string().trim().max(120).optional().nullable(),
      }),
      req.body
    );
    const open = await db
      .prepare(`SELECT id FROM applicants WHERE lower(email) = ? AND stage NOT IN ('hired', 'rejected') LIMIT 1`)
      .get(body.email);
    if (open) throw new HttpError(409, 'That person already has an application in progress.', [{ field: 'email', message: 'Already applied.' }]);
    const id = await insertApplicant(body, body.source, body.referredBy);
    await note(id, req.user.id, 'Added by the office.');
    await audit(req.user.id, 'applicant.added', 'applicant', id, { source: body.source }, req.ip);
    res.status(201).json(await detail(id));
  })
);

/** Move an applicant along, or turn them down with a reason. Hiring has its own route. */
hiringRouter.patch(
  '/:id/stage',
  wrap(async (req, res) => {
    const a = await loadApplicant(req.params.id);
    const body = parse(
      z.object({
        stage: z.enum(HIRING_STAGES.filter((s) => s !== 'hired')),
        reason: z.string().trim().max(500).optional().nullable(),
      }),
      req.body
    );
    if (a.stage === 'hired') throw new HttpError(409, 'This applicant has been hired; manage them under Employees.');
    if (body.stage === a.stage) throw new HttpError(409, 'They are already at that stage.');
    if (body.stage === 'rejected' && (!body.reason || body.reason.length < 5)) {
      throw new HttpError(422, 'Say why they are not being taken on.', [{ field: 'reason', message: 'Give a reason.' }]);
    }
    await db
      .prepare(`UPDATE applicants SET stage = ?, stage_changed_at = now(), rejected_reason = ? WHERE id = ?`)
      .run(body.stage, body.stage === 'rejected' ? body.reason : null, a.id);
    const from = a.stage === 'rejected' ? 'Reopened' : `Moved from ${a.stage}`;
    await note(a.id, req.user.id, body.stage === 'rejected' ? `Not taken on: ${body.reason}` : `${from} to ${body.stage}.${body.reason ? ` ${body.reason}` : ''}`);
    await audit(req.user.id, 'applicant.stage', 'applicant', a.id, { from: a.stage, to: body.stage }, req.ip);
    res.json(await detail(a.id));
  })
);

/** Tick a pre-hire check, or untick one done by mistake. */
hiringRouter.put(
  '/:id/checks/:key',
  wrap(async (req, res) => {
    const a = await loadApplicant(req.params.id);
    if (!CHECK_KEYS.includes(req.params.key)) throw new HttpError(404, 'No such check.');
    const body = parse(z.object({ done: z.boolean(), note: z.string().trim().max(300).optional().nullable() }), req.body);
    if (a.stage === 'hired') throw new HttpError(409, 'This applicant has been hired.');
    if (body.done) {
      await db
        .prepare(
          `INSERT INTO applicant_checks (applicant_id, key, done_by, note) VALUES (?,?,?,?)
           ON CONFLICT (applicant_id, key) DO UPDATE SET done_at = now(), done_by = excluded.done_by, note = excluded.note`
        )
        .run(a.id, req.params.key, req.user.id, body.note || null);
    } else {
      await db.prepare(`DELETE FROM applicant_checks WHERE applicant_id = ? AND key = ?`).run(a.id, req.params.key);
    }
    res.json(await detail(a.id));
  })
);

hiringRouter.post(
  '/:id/notes',
  wrap(async (req, res) => {
    const a = await loadApplicant(req.params.id);
    const body = parse(z.object({ body: z.string().trim().min(2, 'Write a note.').max(2000) }), req.body);
    await note(a.id, req.user.id, body.body);
    res.status(201).json(await detail(a.id));
  })
);

/**
 * Hire: make them an employee. Needs an offer made and the required checks
 * done. Returns the employee code and a starting PIN, shown once.
 */
hiringRouter.post(
  '/:id/hire',
  onlyAdmin,
  wrap(async (req, res) => {
    const a = await loadApplicant(req.params.id);
    const body = parse(
      z.object({
        role: z.enum([ROLES.OFFICER, ROLES.SUPERVISOR]).default(ROLES.OFFICER),
        employmentType: z.enum(EMPLOYMENT_TYPES).default('w2'),
        payType: z.enum(PAY_TYPES).default('hourly'),
        payRate: z.number().positive().max(500),
        defaultSiteId: z.number().int().positive().optional().nullable(),
        w9OnFile: z.boolean().default(false),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
      }),
      req.body
    );
    if (a.stage === 'hired') throw new HttpError(409, 'This applicant has already been hired.');
    if (a.stage !== 'offer') throw new HttpError(409, 'Make them an offer before hiring them.');
    if (Number(a.required_done) !== REQUIRED.length) {
      const missing = HIRING_CHECKS.filter((c) => c.required).map((c) => c.label);
      throw new HttpError(409, `Finish the required checks first: ${missing.join('; ')}.`);
    }
    if (body.employmentType === '1099' && !body.w9OnFile) {
      throw new HttpError(422, 'A 1099 contractor cannot start until their W-9 is on file.', [{ field: 'w9OnFile', message: 'W-9 needed.' }]);
    }
    if (body.defaultSiteId && !(await db.prepare(`SELECT id FROM sites WHERE id = ?`).get(body.defaultSiteId))) {
      throw new HttpError(422, 'That site does not exist.', [{ field: 'defaultSiteId', message: 'Pick a site.' }]);
    }
    if (a.email && (await db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(String(a.email).toLowerCase()))) {
      throw new HttpError(409, 'Someone on the staff list already uses this email address.');
    }

    const code = await generateEmployeeCode();
    const pin = generatePin(4);
    const { hash, salt } = hashPin(pin);
    const today = new Date().toISOString().slice(0, 10);
    const licenceType = { D: 'Class D', G: 'Class G', DG: 'Class D + G' }[a.licence_class] || null;
    const info = await db
      .prepare(
        `INSERT INTO users (employee_code, first_name, last_name, email, phone, role, status, hire_date,
           license_number, license_type, license_expires_on, default_site_id, employment_type, pay_type, pay_rate_cents,
           w9_on_file, city, pin_hash, pin_salt, pin_set_at, must_change_pin, notes)
         VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,now(),true,?)`
      )
      .run(
        code, a.first_name, a.last_name, a.email, a.phone, body.role, body.startDate || today,
        a.licence_number, licenceType, a.licence_expires_on ? String(a.licence_expires_on).slice(0, 10) : null,
        body.defaultSiteId ?? null, body.employmentType, body.payType, Math.round(body.payRate * 100),
        body.w9OnFile, a.city, hash, salt, `Hired through the pipeline (applicant #${a.id}).`
      );
    const userId = Number(info.lastInsertRowid);
    await recordPayHistory(userId, { changedBy: req.user.id, reason: 'Starting rate', effectiveOn: body.startDate || today });
    await db.prepare(`UPDATE applicants SET stage = 'hired', stage_changed_at = now(), hired_user_id = ? WHERE id = ?`).run(userId, a.id);
    await note(a.id, req.user.id, `Hired as employee ${code}.`);
    await audit(req.user.id, 'applicant.hired', 'applicant', a.id, { userId, code }, req.ip);
    res.status(201).json({
      ...(await detail(a.id)),
      employee: publicUser(await db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId)),
      credentials: {
        employeeCode: code,
        pin,
        note: 'Give these to the new officer now - the PIN is not stored in readable form and cannot be shown again.',
      },
    });
  })
);
