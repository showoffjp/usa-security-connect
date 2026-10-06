/**
 * Client sign-off of the week's hours, staff side: every property's recent
 * weeks and where each stands - signed off, waiting, disputed, or changed
 * since it was signed. Supervisors read the board; replying to a dispute is
 * an administrator's job, since it is about what the client is billed.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES } from '../shared.js';
import { signoffBoard, presentSignoff } from '../services/signoffs.js';
import { notifySignoffReply } from '../services/email.js';

export const signoffsRouter = Router();
signoffsRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

signoffsRouter.get(
  '/',
  wrap(async (req, res) => {
    const weeks = Math.min(Math.max(Number(req.query.weeks) || 4, 1), 6);
    res.json(await signoffBoard(weeks));
  })
);

/** Answer a client's dispute. The reply reaches them in the portal and by email. */
signoffsRouter.post(
  '/:id/reply',
  requireRole(ROLES.ADMIN),
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'sign-off');
    const body = parse(z.object({ response: z.string().trim().min(5, 'Write a reply the client can read.').max(2000) }), req.body);
    const row = await db.prepare(`SELECT * FROM hours_signoffs WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Sign-off not found.');
    if (row.status !== 'disputed') throw new HttpError(409, 'Only a disputed week needs a reply.');
    await db
      .prepare(`UPDATE hours_signoffs SET response = ?, responded_by = ?, responded_at = now() WHERE id = ?`)
      .run(body.response, req.user.id, id);
    await audit(req.user.id, 'signoff.replied', 'site', row.site_id, { signoffId: id, weekOf: presentSignoff(row).week_start }, req.ip);
    const saved = await db
      .prepare(
        `SELECT h.*, s.name AS site_name, c.name AS client_name, c.email AS client_email, c.status AS client_status
         FROM hours_signoffs h JOIN sites s ON s.id = h.site_id LEFT JOIN client_users c ON c.id = h.client_user_id
         WHERE h.id = ?`
      )
      .get(id);
    await notifySignoffReply(saved);
    const { fingerprint: _fp, client_email: _e, ...shown } = presentSignoff(saved);
    res.json({ signoff: shown });
  })
);
