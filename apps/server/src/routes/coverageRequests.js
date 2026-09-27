/**
 * Extra coverage requested by clients from the portal.
 *
 * A supervisor answers each one: schedule it, which puts that many open shifts
 * on one of the site's posts for the roster to fill, or decline it with a
 * reason. Either way the client is emailed and sees the answer in the portal.
 * Supervisors can do this, as they can create shifts; nothing here touches pay.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES } from '../shared.js';
import { notifyCoverageRequestAnswered } from '../services/email.js';

export const coverageRequestsRouter = Router();
coverageRequestsRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

const TIMES = ['starts_at', 'ends_at', 'handled_at', 'created_at'];

async function load(id) {
  const row = await db
    .prepare(
      `SELECT r.*, s.name AS site_name, s.city, c.name AS client_name, c.company AS client_company,
              c.email AS client_email, h.first_name || ' ' || h.last_name AS handled_by_name,
              p.name AS post_name
       FROM coverage_requests r
       JOIN sites s ON s.id = r.site_id
       LEFT JOIN client_users c ON c.id = r.client_user_id
       LEFT JOIN users h ON h.id = r.handled_by
       LEFT JOIN posts p ON p.id = r.post_id
       WHERE r.id = ?`
    )
    .get(Number(id));
  if (!row) throw new HttpError(404, 'Coverage request not found.');
  return row;
}

const present = (r) => ({ ...isoFields(r, TIMES), armed: Boolean(r.armed) });

coverageRequestsRouter.get(
  '/',
  wrap(async (req, res) => {
    const status = ['open', 'scheduled', 'declined', 'cancelled', 'all'].includes(req.query.status)
      ? req.query.status
      : 'all';
    const rows = await db
      .prepare(
        `SELECT r.*, s.name AS site_name, s.city, c.name AS client_name, c.company AS client_company,
                h.first_name || ' ' || h.last_name AS handled_by_name, p.name AS post_name
         FROM coverage_requests r
         JOIN sites s ON s.id = r.site_id
         LEFT JOIN client_users c ON c.id = r.client_user_id
         LEFT JOIN users h ON h.id = r.handled_by
         LEFT JOIN posts p ON p.id = r.post_id
         ${status === 'all' ? '' : 'WHERE r.status = ?'}
         ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.starts_at ${status === 'open' ? 'ASC' : 'DESC'}
         LIMIT 200`
      )
      .all(...(status === 'all' ? [] : [status]));

    // The posts each open request could be scheduled on, so the screen can
    // offer them without another round trip.
    const siteIds = [...new Set(rows.filter((r) => r.status === 'open').map((r) => r.site_id))];
    const posts = siteIds.length
      ? await db
          .prepare(
            `SELECT id, site_id, name, post_code, armed, bill_rate_cents FROM posts
             WHERE active = 1 AND site_id IN (${siteIds.map(() => '?').join(',')}) ORDER BY name`
          )
          .all(...siteIds)
      : [];
    res.json({
      requests: rows.map(present),
      posts: posts.map((p) => ({ ...p, armed: Boolean(p.armed) })),
      counts: {
        open: rows.filter((r) => r.status === 'open').length,
      },
    });
  })
);

const scheduleSchema = z.object({
  postId: z.number().int().positive(),
  note: z.string().trim().max(500).optional().nullable(),
});

/** Turn a request into open shifts on one of the site's posts. */
coverageRequestsRouter.post(
  '/:id/schedule',
  wrap(async (req, res) => {
    const body = parse(scheduleSchema, req.body);
    const request = await load(req.params.id);
    if (request.status !== 'open') throw new HttpError(409, 'This request has already been answered.');
    const post = await db.prepare(`SELECT * FROM posts WHERE id = ? AND active = 1`).get(body.postId);
    if (!post || post.site_id !== request.site_id) {
      throw new HttpError(422, 'Choose one of this site\'s own posts.');
    }
    if (request.armed && !post.armed) {
      throw new HttpError(422, 'The client asked for armed officers; choose an armed post.');
    }

    await db.transaction(async () => {
      for (let i = 0; i < request.officers; i++) {
        await db
          .prepare(
            `INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status, notes, created_by)
             VALUES (NULL, ?, ?, ?, 'scheduled', ?, ?)`
          )
          .run(post.id, request.starts_at, request.ends_at, `Extra coverage requested by the client (request ${request.id})`, req.user.id);
      }
      await db
        .prepare(
          `UPDATE coverage_requests SET status = 'scheduled', post_id = ?, shifts_created = ?, response = ?,
             handled_by = ?, handled_at = now() WHERE id = ?`
        )
        .run(post.id, request.officers, body.note || null, req.user.id, request.id);
    })();

    await audit(req.user.id, 'coverage_request.scheduled', 'coverage_request', request.id, { postId: post.id, shifts: request.officers }, req.ip);
    const updated = await load(request.id);
    await notifyCoverageRequestAnswered(updated).catch((err) => console.error('[usc] coverage email failed', err.message));
    res.json({ request: present(updated) });
  })
);

const declineSchema = z.object({
  response: z.string().trim().min(5, 'Tell the client why - they will see this.').max(500),
});

coverageRequestsRouter.post(
  '/:id/decline',
  wrap(async (req, res) => {
    const body = parse(declineSchema, req.body);
    const request = await load(req.params.id);
    if (request.status !== 'open') throw new HttpError(409, 'This request has already been answered.');
    await db
      .prepare(
        `UPDATE coverage_requests SET status = 'declined', response = ?, handled_by = ?, handled_at = now() WHERE id = ?`
      )
      .run(body.response, req.user.id, request.id);
    await audit(req.user.id, 'coverage_request.declined', 'coverage_request', request.id, null, req.ip);
    const updated = await load(request.id);
    await notifyCoverageRequestAnswered(updated).catch((err) => console.error('[usc] coverage email failed', err.message));
    res.json({ request: present(updated) });
  })
);
