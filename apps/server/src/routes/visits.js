/**
 * Field supervisor visits: a supervisor stands at a post, checks the officer
 * and the site, and records what they found.
 *
 * A visit carries two notes. `notes` is ours - what the supervisor saw and
 * coached the officer on - and never leaves the staff side. `client_note` is
 * what the property's contacts read in the portal. Supervisors and managers
 * see every visit; an officer sees the visits made to them.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, idParam, limitParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, atLeast, VISIT_CHECKS, VISIT_DUE_DAYS } from '../shared.js';
import { toSql } from '../services/compliance.js';

export const visitsRouter = Router();
visitsRouter.use(requireAuth);

const CHECK_KEYS = VISIT_CHECKS.map((c) => c.key);

const visitSelect = `
  SELECT v.*, s.name AS site_name, p.name AS post_name,
         sup.first_name || ' ' || sup.last_name AS supervisor_name,
         o.first_name || ' ' || o.last_name AS officer_name
  FROM supervisor_visits v
  LEFT JOIN sites s ON s.id = v.site_id
  LEFT JOIN posts p ON p.id = v.post_id
  JOIN users sup ON sup.id = v.supervisor_id
  LEFT JOIN users o ON o.id = v.officer_id`;

/** A visit as staff see it, with the checks that failed spelled out. */
export const presentVisit = (v) => {
  const out = isoFields(v, ['visited_at', 'created_at']);
  for (const k of CHECK_KEYS) out[k] = v[k] == null ? null : Boolean(v[k]);
  out.failed = VISIT_CHECKS.filter((c) => out[c.key] === false).map((c) => c.label);
  return out;
};

const visitSchema = z
  .object({
    siteId: z.number().int().positive().optional().nullable(),
    postId: z.number().int().positive().optional().nullable(),
    officerId: z.number().int().positive().optional().nullable(),
    visitedAt: z.string().optional().nullable(),
    uniformOk: z.boolean().optional().nullable(),
    postOrdersReviewed: z.boolean().optional().nullable(),
    equipmentOk: z.boolean().optional().nullable(),
    siteSecure: z.boolean().optional().nullable(),
    rating: z.number().int().min(1).max(5).optional().nullable(),
    notes: z.string().trim().max(3000).optional().nullable(),
    clientNote: z.string().trim().max(1000).optional().nullable(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
  })
  .refine((b) => b.siteId || b.postId, { message: 'Say which site or post was visited.', path: ['siteId'] });

/** Log a visit. The post decides the site; a visit cannot be dated in the future or more than a week back. */
visitsRouter.post(
  '/',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const body = parse(visitSchema, req.body);

    let siteId = body.siteId ?? null;
    if (body.postId) {
      const post = await db.prepare(`SELECT id, site_id FROM posts WHERE id = ?`).get(body.postId);
      if (!post) throw new HttpError(422, 'That post does not exist.', [{ field: 'postId', message: 'Pick a post.' }]);
      if (siteId && siteId !== post.site_id) {
        throw new HttpError(422, 'That post is at a different site.', [{ field: 'postId', message: 'Pick a post at this site.' }]);
      }
      siteId = post.site_id;
    }
    const site = await db.prepare(`SELECT id FROM sites WHERE id = ?`).get(siteId);
    if (!site) throw new HttpError(422, 'That site does not exist.', [{ field: 'siteId', message: 'Pick a site.' }]);

    if (body.officerId) {
      const officer = await db.prepare(`SELECT status FROM users WHERE id = ?`).get(body.officerId);
      if (!officer || officer.status !== 'active') {
        throw new HttpError(422, 'Pick an active officer.', [{ field: 'officerId', message: 'Pick an active officer.' }]);
      }
    }

    const now = Date.now();
    const visitedAt = body.visitedAt ? new Date(body.visitedAt) : new Date(now);
    if (Number.isNaN(visitedAt.getTime())) {
      throw new HttpError(422, 'That visit time is not valid.', [{ field: 'visitedAt', message: 'Pick a date and time.' }]);
    }
    if (visitedAt.getTime() > now + 5 * 60000) {
      throw new HttpError(422, 'A visit cannot be in the future.', [{ field: 'visitedAt', message: 'A visit cannot be in the future.' }]);
    }
    if (visitedAt.getTime() < now - 7 * 86400000) {
      throw new HttpError(422, 'Log a visit within a week of making it.', [{ field: 'visitedAt', message: 'No more than a week back.' }]);
    }

    const info = await db
      .prepare(
        `INSERT INTO supervisor_visits
         (supervisor_id, officer_id, site_id, post_id, visited_at, uniform_ok, post_orders_reviewed, equipment_ok,
          site_secure, rating, notes, client_note, latitude, longitude)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        req.user.id,
        body.officerId ?? null,
        site.id,
        body.postId ?? null,
        toSql(visitedAt),
        body.uniformOk ?? null,
        body.postOrdersReviewed ?? null,
        body.equipmentOk ?? null,
        body.siteSecure ?? null,
        body.rating ?? null,
        body.notes || null,
        body.clientNote || null,
        body.latitude ?? null,
        body.longitude ?? null
      );

    await audit(req.user.id, 'visit.logged', 'supervisor_visit', Number(info.lastInsertRowid), { siteId: site.id }, req.ip);
    res.status(201).json({ visit: presentVisit(await db.prepare(`${visitSelect} WHERE v.id = ?`).get(info.lastInsertRowid)) });
  })
);

/**
 * Visits, newest first. Supervisors and managers see every one and can narrow
 * by site, officer, supervisor or to the visits that found a problem; an
 * officer sees the visits made to them.
 */
visitsRouter.get(
  '/',
  wrap(async (req, res) => {
    const limit = limitParam(req.query.limit, 50, 200);
    const days = Math.min(365, limitParam(req.query.days, 30, 365));
    const where = ['v.visited_at >= ?'];
    const params = [toSql(new Date(Date.now() - days * 86400000))];

    if (!atLeast(req.user.role, ROLES.SUPERVISOR)) {
      where.push('v.officer_id = ?');
      params.push(req.user.id);
    } else {
      for (const [param, column, what] of [
        ['siteId', 'v.site_id', 'site'],
        ['officerId', 'v.officer_id', 'officer'],
        ['supervisorId', 'v.supervisor_id', 'supervisor'],
      ]) {
        const id = idParam(req.query[param], what);
        if (id) {
          where.push(`${column} = ?`);
          params.push(id);
        }
      }
      if (req.query.issues === '1') where.push(`(${CHECK_KEYS.map((k) => `v.${k} = false`).join(' OR ')} OR v.rating <= 2)`);
    }

    const rows = await db
      .prepare(`${visitSelect} WHERE ${where.join(' AND ')} ORDER BY v.visited_at DESC LIMIT ?`)
      .all(...params, limit);
    res.json({ days, visits: rows.map(presentVisit) });
  })
);

/** Every active site, with its last visit and whether it is due another. */
export async function visitBoard() {
  const since = toSql(new Date(Date.now() - 30 * 86400000));
  const rows = await db
    .prepare(
      `SELECT s.id, s.name, s.client_name, s.city,
              MAX(v.visited_at) AS last_visit,
              SUM(CASE WHEN v.visited_at >= ? THEN 1 ELSE 0 END) AS visits_30,
              ROUND(AVG(CASE WHEN v.visited_at >= ? THEN v.rating END)::numeric, 1) AS rating_30
       FROM sites s LEFT JOIN supervisor_visits v ON v.site_id = s.id
       WHERE s.active = true
       GROUP BY s.id, s.name, s.client_name, s.city`
    )
    .all(since, since);
  const now = Date.now();
  const sites = rows.map((r) => {
    const last = r.last_visit ? new Date(isoFields(r, ['last_visit']).last_visit) : null;
    const daysSince = last ? Math.floor((now - last.getTime()) / 86400000) : null;
    return {
      id: r.id,
      name: r.name,
      client_name: r.client_name,
      city: r.city,
      last_visit: last ? last.toISOString() : null,
      days_since: daysSince,
      visits_30: Number(r.visits_30 || 0),
      rating_30: r.rating_30 == null ? null : Number(r.rating_30),
      due: daysSince === null || daysSince >= VISIT_DUE_DAYS,
    };
  });
  // Longest without a visit first; never visited at the very top.
  sites.sort((a, b) => (b.days_since ?? Infinity) - (a.days_since ?? Infinity) || a.name.localeCompare(b.name));
  return { dueAfterDays: VISIT_DUE_DAYS, sites, due: sites.filter((s) => s.due).length };
}

visitsRouter.get(
  '/board',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (_req, res) => {
    res.json(await visitBoard());
  })
);
