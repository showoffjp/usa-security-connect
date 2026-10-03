/**
 * Commendations, for officers and staff. (Client contacts commend through
 * the portal routes in client.js.)
 *
 *   * An officer reads every commendation they have had, and marks the new
 *     ones seen.
 *   * A supervisor commends an officer, never themselves, and sees them all.
 *   * An administrator can remove one - a client's words are theirs, but a
 *     message that should never have been sent can be taken down, on the
 *     audit log.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam, limitParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, COMMENDATION_CATEGORIES } from '../shared.js';
import { pushAsync } from '../services/push.js';
import { COMMENDATION_SELECT, presentCommendation } from '../services/commendations.js';

export const commendationsRouter = Router();
commendationsRouter.use(requireAuth);

/** Mine, newest first, with how many I have not seen. */
commendationsRouter.get(
  '/mine',
  wrap(async (req, res) => {
    const rows = await db.prepare(`${COMMENDATION_SELECT} WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT 50`).all(req.user.id);
    const list = rows.map(presentCommendation);
    res.json({ commendations: list, unseen: list.filter((c) => !c.seen).length });
  })
);

commendationsRouter.post(
  '/mine/seen',
  wrap(async (req, res) => {
    const r = await db.prepare(`UPDATE commendations SET seen_at = now() WHERE user_id = ? AND seen_at IS NULL`).run(req.user.id);
    res.json({ seen: r.changes });
  })
);

/** Every commendation, or one officer's. */
commendationsRouter.get(
  '/',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const userId = idParam(req.query.userId, 'employee');
    const limit = limitParam(req.query.limit, 100, 300);
    const rows = await db
      .prepare(`${COMMENDATION_SELECT} ${userId ? 'WHERE c.user_id = ?' : ''} ORDER BY c.created_at DESC LIMIT ?`)
      .all(...(userId ? [userId] : []), limit);
    res.json({ commendations: rows.map(presentCommendation) });
  })
);

const commendSchema = z.object({
  userId: z.coerce.number().int().positive(),
  siteId: z.coerce.number().int().positive().optional().nullable(),
  category: z.enum(COMMENDATION_CATEGORIES, { errorMap: () => ({ message: 'Pick what it was for.' }) }),
  message: z.string().trim().min(10, 'Say what they did, in a sentence or two.').max(1000),
});

commendationsRouter.post(
  '/',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const body = parse(commendSchema, req.body);
    if (body.userId === req.user.id) throw new HttpError(403, 'Commend someone else.');
    const officer = await db.prepare(`SELECT id, status FROM users WHERE id = ? AND role IN ('officer','supervisor')`).get(body.userId);
    if (!officer || officer.status !== 'active') throw new HttpError(404, 'Officer not found.');
    if (body.siteId && !(await db.prepare(`SELECT id FROM sites WHERE id = ?`).get(body.siteId))) throw new HttpError(404, 'Site not found.');
    const info = await db
      .prepare(`INSERT INTO commendations (user_id, site_id, category, message, staff_user_id) VALUES (?,?,?,?,?)`)
      .run(body.userId, body.siteId ?? null, body.category, body.message, req.user.id);
    const id = Number(info.lastInsertRowid);
    await audit(req.user.id, 'commendation.created', 'commendation', id, { userId: body.userId, category: body.category }, req.ip);
    pushAsync([body.userId], {
      title: 'You were commended',
      body: `${req.user.first_name} ${req.user.last_name}: ${body.message.slice(0, 120)}`,
      data: { type: 'commendation', id },
    });
    res.status(201).json({ commendation: presentCommendation(await db.prepare(`${COMMENDATION_SELECT} WHERE c.id = ?`).get(id)) });
  })
);

commendationsRouter.delete(
  '/:id',
  requireRole(ROLES.ADMIN),
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'commendation');
    const row = await db.prepare(`SELECT * FROM commendations WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Commendation not found.');
    await db.prepare(`DELETE FROM commendations WHERE id = ?`).run(id);
    await audit(req.user.id, 'commendation.removed', 'commendation', id, { userId: row.user_id, message: row.message }, req.ip);
    res.json({ ok: true });
  })
);
