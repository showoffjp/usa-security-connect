import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, atLeast, shiftEligibility, blocksAssignment, SHIFT_REQUEST_LABEL } from '../shared.js';
import { pushAsync, supervisorIds } from '../services/push.js';

export const shiftRequestsRouter = Router();
shiftRequestsRouter.use(requireAuth);

const SHIFT_TIMES = ['starts_at', 'ends_at', 'created_at'];
const REQUEST_TIMES = ['created_at', 'decided_at'];

/* --------------------------------------------------------- eligibility --- */

/**
 * Gather everything needed to judge whether an officer can work a shift, then
 * ask the shared rule. Kept in one place so claiming, swapping and a
 * supervisor's manual assignment all answer the same question.
 */
async function checkEligibility(userId, shift) {
  const officer = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!officer) throw new HttpError(404, 'Officer not found.');

  const post = await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(shift.post_id);

  const certifications = await db
    .prepare(`SELECT type, expires_on FROM certifications WHERE user_id = ?`)
    .all(userId);

  const conflicts = await db
    .prepare(
      `SELECT id FROM shifts
       WHERE user_id = ? AND id != ? AND status != 'cancelled'
         AND starts_at < ? AND ends_at > ?`
    )
    .all(userId, shift.id, shift.ends_at, shift.starts_at);

  const timeOff = await db
    .prepare(
      `SELECT id FROM time_off_requests
       WHERE user_id = ? AND status = 'approved'
         AND starts_on <= ?::date AND ends_on >= ?::date`
    )
    .all(userId, shift.starts_at, shift.starts_at);

  // Postgres: Sunday is 0 from EXTRACT(DOW), matching the availability table.
  const weekday = new Date(shift.starts_at).getDay();
  const availability = await db
    .prepare(`SELECT * FROM availability WHERE user_id = ? AND weekday = ?`)
    .get(userId, weekday);

  return shiftEligibility({ post, officer, certifications, conflicts, timeOff, availability });
}

/** Exposed so the scheduling screen can warn before an assignment is made. */
shiftRequestsRouter.get(
  '/eligibility/:shiftId/:userId',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(req.params.shiftId);
    if (!shift) throw new HttpError(404, 'Shift not found.');

    const reasons = await checkEligibility(Number(req.params.userId), shift);
    res.json({ reasons, blocked: blocksAssignment(reasons) });
  })
);

/* ---------------------------------------------------------- open shifts --- */

/**
 * Shifts nobody is covering, with this officer's eligibility already worked
 * out, so the app can grey out what they cannot take and say why.
 */
shiftRequestsRouter.get(
  '/open',
  wrap(async (req, res) => {
    const shifts = await db
      .prepare(
        `SELECT sh.*, p.name AS post_name, p.post_code, p.armed, p.instructions,
                s.name AS site_name, s.address, s.city, s.state,
                (SELECT COUNT(*) FROM shift_requests sr
                  WHERE sr.shift_id = sh.id AND sr.kind = 'claim' AND sr.status = 'pending') AS claim_count,
                EXISTS(SELECT 1 FROM shift_requests sr
                  WHERE sr.shift_id = sh.id AND sr.requested_by = ? AND sr.status IN ('pending','accepted')) AS already_requested
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE sh.user_id IS NULL
           AND sh.status = 'scheduled'
           AND sh.starts_at > now()
         ORDER BY sh.starts_at
         LIMIT 60`
      )
      .all(req.user.id);

    const withEligibility = [];
    for (const shift of shifts) {
      const reasons = await checkEligibility(req.user.id, shift);
      withEligibility.push({
        ...isoFields(shift, SHIFT_TIMES),
        eligibility: reasons,
        canClaim: !blocksAssignment(reasons) && !shift.already_requested,
      });
    }

    res.json({ shifts: withEligibility });
  })
);

/* -------------------------------------------------------------- claim ---- */

shiftRequestsRouter.post(
  '/:shiftId/claim',
  wrap(async (req, res) => {
    const note = String(req.body?.note || '').slice(0, 500);
    const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(req.params.shiftId);

    if (!shift) throw new HttpError(404, 'Shift not found.');
    if (shift.user_id) throw new HttpError(409, 'Somebody is already assigned to that shift.');
    if (new Date(shift.starts_at) < new Date()) throw new HttpError(409, 'That shift has already started.');

    const reasons = await checkEligibility(req.user.id, shift);
    if (blocksAssignment(reasons)) {
      throw new HttpError(409, reasons.find((r) => !r.advisory).message, { reasons });
    }

    const existing = await db
      .prepare(
        `SELECT id FROM shift_requests
         WHERE shift_id = ? AND requested_by = ? AND status IN ('pending','accepted')`
      )
      .get(shift.id, req.user.id);
    if (existing) throw new HttpError(409, 'You have already asked for that shift.');

    const info = await db
      .prepare(
        `INSERT INTO shift_requests (kind, shift_id, requested_by, note)
         VALUES ('claim', ?, ?, ?)`
      )
      .run(shift.id, req.user.id, note || null);

    await audit(req.user.id, 'shift.claim_requested', 'shift', shift.id, null, req.ip);

    pushAsync(await supervisorIds(), {
      title: 'Open shift claimed',
      body: `${req.user.first_name} ${req.user.last_name} wants the ${new Date(shift.starts_at).toLocaleDateString()} shift.`,
      data: { type: 'shift_request', id: Number(info.lastInsertRowid) },
    });

    res.status(201).json({
      request: await db.prepare(`SELECT * FROM shift_requests WHERE id = ?`).get(info.lastInsertRowid),
      advisories: reasons.filter((r) => r.advisory),
    });
  })
);

/* --------------------------------------------------------------- swap ---- */

const swapSchema = z.object({
  targetUserId: z.number().int().positive(),
  offeredShiftId: z.number().int().positive().nullable().optional(),
  note: z.string().max(500).optional(),
});

shiftRequestsRouter.post(
  '/:shiftId/swap',
  wrap(async (req, res) => {
    const body = parse(swapSchema, req.body);
    const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(req.params.shiftId);

    if (!shift) throw new HttpError(404, 'Shift not found.');
    if (shift.user_id !== req.user.id) throw new HttpError(403, 'That is not your shift to swap.');
    if (new Date(shift.starts_at) < new Date()) throw new HttpError(409, 'That shift has already started.');
    if (body.targetUserId === req.user.id) throw new HttpError(422, 'Pick a different officer.');

    // The other officer has to be able to work it, or the swap is pointless.
    const reasons = await checkEligibility(body.targetUserId, shift);
    if (blocksAssignment(reasons)) {
      throw new HttpError(409, `They cannot take this shift: ${reasons.find((r) => !r.advisory).message}`, { reasons });
    }

    if (body.offeredShiftId) {
      const offered = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(body.offeredShiftId);
      if (!offered || offered.user_id !== body.targetUserId) {
        throw new HttpError(422, 'The shift you asked for is not theirs.');
      }
      // A straight swap only works if you can work theirs too.
      const mine = await checkEligibility(req.user.id, offered);
      if (blocksAssignment(mine)) {
        throw new HttpError(409, `You cannot take their shift: ${mine.find((r) => !r.advisory).message}`, { reasons: mine });
      }
    }

    const info = await db
      .prepare(
        `INSERT INTO shift_requests (kind, shift_id, requested_by, target_user_id, offered_shift_id, note)
         VALUES ('swap', ?, ?, ?, ?, ?)`
      )
      .run(shift.id, req.user.id, body.targetUserId, body.offeredShiftId ?? null, body.note ?? null);

    await audit(req.user.id, 'shift.swap_requested', 'shift', shift.id, { target: body.targetUserId }, req.ip);

    pushAsync([body.targetUserId], {
      title: 'Shift swap request',
      body: `${req.user.first_name} ${req.user.last_name} asked you to take their ${new Date(shift.starts_at).toLocaleDateString()} shift.`,
      data: { type: 'shift_request', id: Number(info.lastInsertRowid) },
    });

    res.status(201).json({
      request: await db.prepare(`SELECT * FROM shift_requests WHERE id = ?`).get(info.lastInsertRowid),
    });
  })
);

/** The officer being asked accepts or declines. A supervisor still decides. */
shiftRequestsRouter.post(
  '/requests/:id/respond',
  wrap(async (req, res) => {
    const accept = req.body?.accept === true;
    const request = await db.prepare(`SELECT * FROM shift_requests WHERE id = ?`).get(req.params.id);

    if (!request) throw new HttpError(404, 'Request not found.');
    if (request.target_user_id !== req.user.id) throw new HttpError(403, 'That request was not sent to you.');
    if (request.status !== 'pending') throw new HttpError(409, 'You have already answered that request.');

    await db
      .prepare(`UPDATE shift_requests SET status = ? WHERE id = ?`)
      .run(accept ? 'accepted' : 'declined', request.id);

    await audit(req.user.id, `shift.swap_${accept ? 'accepted' : 'declined'}`, 'shift_request', request.id, null, req.ip);

    pushAsync([request.requested_by], {
      title: accept ? 'Swap accepted' : 'Swap declined',
      body: accept
        ? `${req.user.first_name} agreed to the swap. It now needs a supervisor.`
        : `${req.user.first_name} cannot take that shift.`,
      data: { type: 'shift_request', id: request.id },
    });

    if (accept) {
      pushAsync(await supervisorIds(), {
        title: 'Swap awaiting approval',
        body: 'Two officers have agreed a shift swap.',
        data: { type: 'shift_request', id: request.id },
      });
    }

    res.json({ ok: true, status: accept ? 'accepted' : 'declined' });
  })
);

/* --------------------------------------------------------------- drop ---- */

shiftRequestsRouter.post(
  '/:shiftId/drop',
  wrap(async (req, res) => {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5) throw new HttpError(422, 'Give a reason for dropping the shift.');

    const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(req.params.shiftId);
    if (!shift) throw new HttpError(404, 'Shift not found.');
    if (shift.user_id !== req.user.id) throw new HttpError(403, 'That is not your shift.');
    if (new Date(shift.starts_at) < new Date()) throw new HttpError(409, 'That shift has already started.');

    const info = await db
      .prepare(`INSERT INTO shift_requests (kind, shift_id, requested_by, note) VALUES ('drop', ?, ?, ?)`)
      .run(shift.id, req.user.id, reason);

    await audit(req.user.id, 'shift.drop_requested', 'shift', shift.id, { reason }, req.ip);

    pushAsync(await supervisorIds(), {
      title: 'Shift drop request',
      body: `${req.user.first_name} ${req.user.last_name} asked to drop their ${new Date(shift.starts_at).toLocaleDateString()} shift.`,
      data: { type: 'shift_request', id: Number(info.lastInsertRowid) },
    });

    res.status(201).json({
      request: await db.prepare(`SELECT * FROM shift_requests WHERE id = ?`).get(info.lastInsertRowid),
    });
  })
);

/* ------------------------------------------------------------- listing --- */

shiftRequestsRouter.get(
  '/requests',
  wrap(async (req, res) => {
    const all = req.query.scope === 'all' && atLeast(req.user.role, ROLES.SUPERVISOR);

    const rows = await db
      .prepare(
        `SELECT sr.*,
                r.first_name || ' ' || r.last_name AS requested_by_name, r.employee_code,
                t.first_name || ' ' || t.last_name AS target_name,
                d.first_name || ' ' || d.last_name AS decided_by_name,
                sh.starts_at, sh.ends_at,
                p.name AS post_name, p.armed, s.name AS site_name,
                os.starts_at AS offered_starts_at, os.ends_at AS offered_ends_at,
                op.name AS offered_post_name
         FROM shift_requests sr
         JOIN users r ON r.id = sr.requested_by
         LEFT JOIN users t ON t.id = sr.target_user_id
         LEFT JOIN users d ON d.id = sr.decided_by
         JOIN shifts sh ON sh.id = sr.shift_id
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         LEFT JOIN shifts os ON os.id = sr.offered_shift_id
         LEFT JOIN posts op ON op.id = os.post_id
         ${all ? '' : 'WHERE (sr.requested_by = ? OR sr.target_user_id = ?)'}
         ${req.query.status ? (all ? 'WHERE' : 'AND') + ' sr.status = ?' : ''}
         ORDER BY sr.created_at DESC
         LIMIT 200`
      )
      .all(
        ...(all ? [] : [req.user.id, req.user.id]),
        ...(req.query.status ? [req.query.status] : [])
      );

    res.json({
      requests: rows.map((r) => ({
        ...isoFields(r, [...REQUEST_TIMES, 'starts_at', 'ends_at', 'offered_starts_at', 'offered_ends_at']),
        label: SHIFT_REQUEST_LABEL[r.kind] || r.kind,
      })),
    });
  })
);

/* ------------------------------------------------------------- decision -- */

const decisionSchema = z.object({
  status: z.enum(['approved', 'denied']),
  note: z.string().max(500).optional(),
});

/**
 * The supervisor's decision, and the only place the roster actually changes.
 *
 * Approving is done in a transaction: a half-applied swap would leave a post
 * unmanned, which is the one outcome worth being careful about.
 */
shiftRequestsRouter.patch(
  '/requests/:id',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const body = parse(decisionSchema, req.body);
    const request = await db.prepare(`SELECT * FROM shift_requests WHERE id = ?`).get(req.params.id);

    if (!request) throw new HttpError(404, 'Request not found.');
    if (['approved', 'denied', 'cancelled'].includes(request.status)) {
      throw new HttpError(409, 'That request has already been decided.');
    }
    if (request.kind === 'swap' && request.status !== 'accepted') {
      throw new HttpError(409, 'The other officer has not accepted this swap yet.');
    }

    if (body.status === 'denied') {
      await db
        .prepare(
          `UPDATE shift_requests SET status = 'denied', decided_by = ?, decided_at = now(), decision_note = ?
           WHERE id = ?`
        )
        .run(req.user.id, body.note ?? null, request.id);

      pushAsync([request.requested_by], {
        title: 'Request denied',
        body: body.note || 'Your shift request was not approved.',
        data: { type: 'shift_request', id: request.id },
      });
      return res.json({ ok: true, status: 'denied' });
    }

    const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(request.shift_id);
    if (!shift) throw new HttpError(404, 'The shift no longer exists.');

    // Re-check at the moment of approval: the roster may have moved since.
    const newOwner =
      request.kind === 'drop' ? null : request.kind === 'claim' ? request.requested_by : request.target_user_id;

    if (newOwner) {
      const reasons = await checkEligibility(newOwner, shift);
      if (blocksAssignment(reasons)) {
        throw new HttpError(409, `No longer possible: ${reasons.find((r) => !r.advisory).message}`, { reasons });
      }
    }

    await db.transaction(async () => {
      if (request.kind === 'drop') {
        await db
          .prepare(`UPDATE shifts SET user_id = NULL, is_open = true WHERE id = ?`)
          .run(shift.id);
      } else if (request.kind === 'claim') {
        await db
          .prepare(`UPDATE shifts SET user_id = ?, is_open = false WHERE id = ?`)
          .run(request.requested_by, shift.id);

        // Everyone else who asked for this shift has lost it.
        await db
          .prepare(
            `UPDATE shift_requests
             SET status = 'denied', decided_by = ?, decided_at = now(),
                 decision_note = 'The shift went to another officer.'
             WHERE shift_id = ? AND id != ? AND status = 'pending' AND kind = 'claim'`
          )
          .run(req.user.id, shift.id, request.id);
      } else {
        // Swap: the shift moves to the target, and any offered shift comes back.
        await db.prepare(`UPDATE shifts SET user_id = ? WHERE id = ?`).run(request.target_user_id, shift.id);
        if (request.offered_shift_id) {
          await db
            .prepare(`UPDATE shifts SET user_id = ? WHERE id = ?`)
            .run(request.requested_by, request.offered_shift_id);
        }
      }

      await db
        .prepare(
          `UPDATE shift_requests SET status = 'approved', decided_by = ?, decided_at = now(), decision_note = ?
           WHERE id = ?`
        )
        .run(req.user.id, body.note ?? null, request.id);
    })();

    await audit(req.user.id, `shift.${request.kind}_approved`, 'shift', shift.id, null, req.ip);

    const tell = [request.requested_by, request.target_user_id].filter(Boolean);
    pushAsync(tell, {
      title: 'Roster updated',
      body:
        request.kind === 'drop'
          ? 'Your shift has been taken off you and reopened.'
          : 'Your shift change was approved.',
      data: { type: 'shift_request', id: request.id },
    });

    res.json({ ok: true, status: 'approved' });
  })
);

/** Withdraw your own request while it is still open. */
shiftRequestsRouter.delete(
  '/requests/:id',
  wrap(async (req, res) => {
    const request = await db.prepare(`SELECT * FROM shift_requests WHERE id = ?`).get(req.params.id);
    if (!request) throw new HttpError(404, 'Request not found.');
    if (request.requested_by !== req.user.id && !atLeast(req.user.role, ROLES.ADMIN)) {
      throw new HttpError(403, 'You can only withdraw your own request.');
    }
    if (['approved', 'denied'].includes(request.status)) {
      throw new HttpError(409, 'That request has already been decided.');
    }

    await db.prepare(`UPDATE shift_requests SET status = 'cancelled' WHERE id = ?`).run(request.id);
    res.json({ ok: true });
  })
);
