/**
 * An officer telling the supervisors, before it becomes a no-show, that they
 * are running late for their next shift or cannot come at all. The rules and
 * what happens next are in services/attendance.js.
 */

import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../lib/db.js';
import { wrap, parse, idParam, rateLimit } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { RULES, CALL_OFF_REASONS, CALL_OFF_LABEL } from '../shared.js';
import { headsUpFor, reportRunningLate, callOff } from '../services/attendance.js';

export const headsUpRouter = Router();
headsUpRouter.use(requireAuth);

const limit = rateLimit({ windowMs: 60 * 60000, max: 10, key: (req) => `heads-up:${req.user.id}` });

/** The shift the officer can say something about, and what they have said. */
headsUpRouter.get(
  '/',
  wrap(async (req, res) => {
    res.json({
      ...(await headsUpFor(req.user.id)),
      rules: { headsUpHours: RULES.headsUpHours, maxEtaMinutes: RULES.maxEtaMinutes, lateGraceMinutes: RULES.lateGraceMinutes },
      reasons: CALL_OFF_REASONS.map((value) => ({ value, label: CALL_OFF_LABEL[value] })),
    });
  })
);

headsUpRouter.post(
  '/:shiftId/running-late',
  limit,
  wrap(async (req, res) => {
    const shiftId = idParam(req.params.shiftId, 'shift');
    const body = parse(
      z.object({
        etaMinutes: z.number().int().min(5, 'At least five minutes from now.').max(RULES.maxEtaMinutes, `At most ${RULES.maxEtaMinutes / 60} hours from now.`),
        note: z.string().trim().max(200).optional(),
      }),
      req.body
    );
    const result = await reportRunningLate({ userId: req.user.id, shiftId, etaMinutes: body.etaMinutes, note: body.note || null });
    await audit(req.user.id, 'shift.running_late', 'shift', shiftId, { eta_at: result.notice.eta_at }, req.ip);
    res.status(201).json(result);
  })
);

headsUpRouter.post(
  '/:shiftId/call-off',
  limit,
  wrap(async (req, res) => {
    const shiftId = idParam(req.params.shiftId, 'shift');
    const body = parse(
      z.object({
        reason: z.enum(CALL_OFF_REASONS, { errorMap: () => ({ message: 'Choose why you cannot come.' }) }),
        note: z.string().trim().max(300).optional(),
      }),
      req.body
    );
    const result = await callOff({ userId: req.user.id, shiftId, reason: body.reason, note: body.note || null });
    await audit(req.user.id, 'shift.called_off', 'shift', shiftId, { reason: body.reason }, req.ip);
    res.status(201).json(result);
  })
);
