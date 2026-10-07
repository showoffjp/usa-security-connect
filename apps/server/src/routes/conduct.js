/**
 * Coaching and discipline. Supervisors record coaching and verbal or written
 * warnings; a final warning or a suspension is an administrator's call. The
 * officer reads each record and signs it, with their side if they want.
 * Clients never see any of it.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam, isoFields, toDateString } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, CONDUCT_LEVELS, CONDUCT_ADMIN_LEVELS, CONDUCT_CATEGORIES, CONDUCT_LEVEL_LABEL } from '../shared.js';
import { conductBoard, conductById, officerConduct, presentForOfficer, standing, CONDUCT_SELECT } from '../services/conduct.js';
import { pushAsync } from '../services/push.js';

export const conductRouter = Router();
conductRouter.use(requireAuth);

const DAY = 86400000;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date.');
const fullName = (u) => `${u.first_name} ${u.last_name}`;
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/* ============================================================ the officer === */

/** The signed-in officer's own record. */
conductRouter.get(
  '/mine',
  wrap(async (req, res) => {
    const rows = await db.prepare(`${CONDUCT_SELECT} WHERE c.user_id = ? ORDER BY c.occurred_on DESC, c.id DESC`).all(req.user.id);
    const records = rows.map(presentForOfficer);
    res.json({ records, awaiting: records.filter((r) => r.awaiting_signature).length });
  })
);

/**
 * Sign a record: the officer types their name, and may add their side of it.
 * Signing says they have read it, not that they agree.
 */
conductRouter.post(
  '/mine/:id/acknowledge',
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'record');
    const body = parse(
      z.object({
        signature: z.string().trim().min(2, 'Type your full name to sign.').max(120),
        statement: z.string().trim().max(2000).optional(),
      }),
      req.body
    );
    const row = await db.prepare(`SELECT * FROM conduct_records WHERE id = ?`).get(id);
    if (!row || row.user_id !== req.user.id) throw new HttpError(404, 'Record not found.');
    if (row.status !== 'issued') throw new HttpError(409, row.status === 'rescinded' ? 'That record was withdrawn.' : 'You have already answered this one.');
    const me = await db.prepare(`SELECT first_name, last_name FROM users WHERE id = ?`).get(req.user.id);
    if (norm(body.signature) !== norm(fullName(me))) {
      throw new HttpError(422, `Type your full name as we have it: ${fullName(me)}.`, [{ field: 'signature', message: 'Your full name.' }]);
    }
    await db
      .prepare(`UPDATE conduct_records SET status = 'acknowledged', acknowledged_at = now(), signature = ?, officer_statement = ? WHERE id = ?`)
      .run(body.signature, body.statement || null, id);
    await audit(req.user.id, 'conduct.acknowledged', 'conduct_record', id, { statement: Boolean(body.statement) }, req.ip);
    const saved = await db.prepare(`${CONDUCT_SELECT} WHERE c.id = ?`).get(id);
    res.json({ record: presentForOfficer(saved) });
  })
);

/* ============================================================ the office === */

const supervisor = requireRole(ROLES.SUPERVISOR);

conductRouter.get(
  '/',
  supervisor,
  wrap(async (req, res) => {
    res.json(await conductBoard({ includeSupervisors: req.user.role === ROLES.ADMIN }));
  })
);

/** One officer's record and where they stand, for their employee page. */
conductRouter.get(
  '/officers/:userId',
  supervisor,
  wrap(async (req, res) => {
    const userId = idParam(req.params.userId, 'officer');
    const officer = await db.prepare(`SELECT id, first_name, last_name, role, status FROM users WHERE id = ?`).get(userId);
    if (!officer) throw new HttpError(404, 'Officer not found.');
    if (officer.role !== 'officer' && req.user.role !== ROLES.ADMIN) throw new HttpError(403, "Only an administrator reads a supervisor's record.");
    const records = await officerConduct(userId);
    res.json({ officer: { id: officer.id, name: fullName(officer), role: officer.role }, records, standing: standing(records) });
  })
);

const issueSchema = z.object({
  userId: z.number().int().positive(),
  category: z.enum(CONDUCT_CATEGORIES),
  level: z.enum(CONDUCT_LEVELS),
  occurredOn: ymd,
  summary: z.string().trim().min(20, 'Say what happened, with times and places.').max(3000),
  expectations: z.string().trim().min(10, 'Say what is expected from now on.').max(2000),
  suspensionStartsOn: ymd.optional().nullable(),
  suspensionEndsOn: ymd.optional().nullable(),
});

/** Record a step on an officer's record. They are told, and asked to sign. */
conductRouter.post(
  '/',
  supervisor,
  wrap(async (req, res) => {
    const b = parse(issueSchema, req.body);
    const officer = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(b.userId);
    if (!officer || officer.status !== 'active' || !['officer', 'supervisor'].includes(officer.role)) {
      throw new HttpError(404, 'Officer not found.');
    }
    if (officer.id === req.user.id) throw new HttpError(403, 'Someone else has to record a step on your own record.');
    const isAdmin = req.user.role === ROLES.ADMIN;
    if (officer.role === 'supervisor' && !isAdmin) throw new HttpError(403, 'Only an administrator records a step for a supervisor.');
    if (CONDUCT_ADMIN_LEVELS.includes(b.level) && !isAdmin) {
      throw new HttpError(403, `A ${CONDUCT_LEVEL_LABEL[b.level].toLowerCase()} is an administrator's decision.`);
    }

    const today = toDateString(new Date());
    const earliest = toDateString(new Date(Date.now() - 60 * DAY));
    if (b.occurredOn > today) throw new HttpError(422, 'That date is still to come.', [{ field: 'occurredOn', message: 'Not in the future.' }]);
    if (b.occurredOn < earliest) throw new HttpError(422, 'Only something from the last 60 days can be recorded.', [{ field: 'occurredOn', message: 'Within 60 days.' }]);

    let suspension = null;
    if (b.level === 'suspension') {
      const { suspensionStartsOn: from, suspensionEndsOn: to } = b;
      if (!from || !to) throw new HttpError(422, 'Give the first and last day of the suspension.', [{ field: 'suspensionStartsOn', message: 'Required.' }]);
      if (to < from) throw new HttpError(422, 'The suspension has to end on or after its first day.', [{ field: 'suspensionEndsOn', message: 'After the start.' }]);
      if (from < b.occurredOn) throw new HttpError(422, 'A suspension starts after what it is for.', [{ field: 'suspensionStartsOn', message: 'On or after the date it happened.' }]);
      const days = Math.round((new Date(`${to}T12:00:00`) - new Date(`${from}T12:00:00`)) / DAY) + 1;
      if (days > 30) throw new HttpError(422, 'A suspension is at most 30 days.', [{ field: 'suspensionEndsOn', message: 'At most 30 days.' }]);
      suspension = { from, to };
    } else if (b.suspensionStartsOn || b.suspensionEndsOn) {
      throw new HttpError(422, 'Only a suspension has dates off work.', [{ field: 'suspensionStartsOn', message: 'Not for this step.' }]);
    }

    const info = await db
      .prepare(
        `INSERT INTO conduct_records (user_id, category, level, occurred_on, summary, expectations, suspension_starts_on, suspension_ends_on, issued_by)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(officer.id, b.category, b.level, b.occurredOn, b.summary, b.expectations, suspension?.from ?? null, suspension?.to ?? null, req.user.id);
    const id = Number(info.lastInsertRowid);
    await audit(req.user.id, 'conduct.issued', 'user', officer.id, { recordId: id, level: b.level, category: b.category }, req.ip);

    // Shifts they are rostered on while suspended need someone else.
    const affected = suspension
      ? (await db
          .prepare(
            `SELECT sh.id, sh.starts_at, sh.ends_at, p.name AS post_name, s.name AS site_name
             FROM shifts sh JOIN posts p ON p.id = sh.post_id JOIN sites s ON s.id = p.site_id
             WHERE sh.user_id = ? AND sh.status = 'scheduled'
               AND sh.starts_at::date BETWEEN ?::date AND ?::date
             ORDER BY sh.starts_at`
          )
          .all(officer.id, suspension.from, suspension.to)).map((s) => isoFields(s, ['starts_at', 'ends_at']))
      : [];

    pushAsync([officer.id], {
      title: `${CONDUCT_LEVEL_LABEL[b.level]} to read`,
      body: 'Please read it and sign it in the app. You can add your side of it.',
      data: { type: 'conduct', id },
    });
    const records = await officerConduct(officer.id);
    res.status(201).json({ record: await conductById(id), standing: standing(records), affected_shifts: affected });
  })
);

/** The officer will not sign: say so, with who saw it. */
conductRouter.post(
  '/:id/refused',
  supervisor,
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'record');
    const body = parse(z.object({ witness: z.string().trim().min(3, 'Name the witness.').max(160) }), req.body);
    const row = await db.prepare(`SELECT * FROM conduct_records WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Record not found.');
    if (row.status !== 'issued') throw new HttpError(409, 'Only a record waiting for a signature can be marked as refused.');
    await db
      .prepare(`UPDATE conduct_records SET status = 'refused', refused_witness = ?, refused_by = ?, refused_at = now() WHERE id = ?`)
      .run(body.witness, req.user.id, id);
    await audit(req.user.id, 'conduct.refused', 'conduct_record', id, { witness: body.witness }, req.ip);
    res.json({ record: await conductById(id) });
  })
);

/** Take a record back. It stays, marked, but no longer counts. */
conductRouter.post(
  '/:id/rescind',
  requireRole(ROLES.ADMIN),
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'record');
    const body = parse(z.object({ reason: z.string().trim().min(5, 'Say why, for the record.').max(500) }), req.body);
    const row = await db.prepare(`SELECT * FROM conduct_records WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Record not found.');
    if (row.status === 'rescinded') throw new HttpError(409, 'That record has already been rescinded.');
    await db
      .prepare(`UPDATE conduct_records SET status = 'rescinded', rescinded_at = now(), rescinded_by = ?, rescind_reason = ? WHERE id = ?`)
      .run(req.user.id, body.reason, id);
    await audit(req.user.id, 'conduct.rescinded', 'conduct_record', id, { reason: body.reason }, req.ip);
    pushAsync([row.user_id], { title: 'A record was withdrawn', body: 'One of the records on your file no longer counts.', data: { type: 'conduct', id } });
    res.json({ record: await conductById(id) });
  })
);
