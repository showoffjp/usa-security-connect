/**
 * Shift handovers. Supervisors see every post changing hands in the next two
 * hours, and every officer held over because their relief has not come, and
 * chase the relief from there. Officers see their own: who is coming to
 * relieve them, and whose post they are taking over.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, HANDOVER_WINDOW_MINUTES } from '../shared.js';
import { handovers, myHandovers } from '../services/handovers.js';
import { pushAsync } from '../services/push.js';

export const handoversRouter = Router();
handoversRouter.use(requireAuth);

// Chasing the same relief again inside this many minutes is refused, so two
// supervisors on the board do not send an officer driving in two pushes.
export const CHASE_COOLDOWN_MINUTES = 10;

/** The signed-in officer's handovers: going off post, and coming on. */
handoversRouter.get(
  '/mine',
  wrap(async (req, res) => {
    res.json(await myHandovers(req.user.id));
  })
);

const supervisor = requireRole(ROLES.SUPERVISOR);

handoversRouter.get(
  '/',
  supervisor,
  wrap(async (req, res) => {
    const { window } = parse(
      z.object({ window: z.coerce.number().int().min(30).max(12 * 60).optional() }),
      req.query
    );
    res.json(await handovers({ windowMinutes: window || HANDOVER_WINDOW_MINUTES }));
  })
);

/**
 * Chase the relief for a handover: a push to the relief officer to say they
 * are expected now, and one to the officer on post to ask them to stay on
 * until relieved. `:shiftId` is the outgoing officer's shift.
 */
handoversRouter.post(
  '/:shiftId/chase',
  supervisor,
  wrap(async (req, res) => {
    const shiftId = idParam(req.params.shiftId, 'shift');
    const body = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body || {});
    const { handovers: list } = await handovers({ windowMinutes: 12 * 60 });
    const h = list.find((x) => x.shift_id === shiftId);
    if (!h) throw new HttpError(404, 'That handover is not on the board. The officer may have gone off duty.');
    if (!h.relief) throw new HttpError(409, 'Nobody follows at this post, so there is no relief to chase.');
    if (!h.relief.user_id) throw new HttpError(409, 'Nobody is assigned to relieve this post yet. Find cover for the shift instead.');
    if (h.relief.clocked_in_at) throw new HttpError(409, `${h.relief.officer} is already on post.`);
    if (h.relief.chased_at && Date.now() - new Date(h.relief.chased_at).getTime() < CHASE_COOLDOWN_MINUTES * 60000) {
      const ago = Math.max(1, Math.round((Date.now() - new Date(h.relief.chased_at).getTime()) / 60000));
      throw new HttpError(409, `${h.relief.officer} was chased ${ago} minute${ago === 1 ? '' : 's'} ago. Give them a few minutes, or call them.`);
    }

    await db
      .prepare(`UPDATE shifts SET relief_chased_at = now(), relief_chased_by = ? WHERE id = ?`)
      .run(req.user.id, h.relief.shift_id);
    await audit(req.user.id, 'handover.chased', 'shift', h.relief.shift_id,
      { outgoing_shift_id: h.shift_id, state: h.state, note: body.note || null }, req.ip);

    const where = `${h.post_name} at ${h.site_name}`;
    pushAsync([h.relief.user_id], {
      title: h.state === 'late' ? 'You are late for your shift' : 'Your shift is coming up',
      body: body.note || `${h.officer} is waiting to hand over ${where}. Please confirm you are on your way.`,
      data: { type: 'handover', shiftId: h.relief.shift_id },
    });
    if (h.state === 'late') {
      pushAsync([h.user_id], {
        title: 'Please stay on post',
        body: `Your relief is running late and we are chasing them. Stay on ${h.post_name} until you hand over; the extra time is paid.`,
        data: { type: 'handover', shiftId: h.shift_id },
      });
    }
    const fresh = (await handovers({ windowMinutes: 12 * 60 })).handovers.find((x) => x.shift_id === shiftId);
    res.json({ handover: fresh || h });
  })
);
