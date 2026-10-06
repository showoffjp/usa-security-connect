/**
 * Site training: who is cleared to work each post alone.
 *
 * Supervisors see every post that needs it, sign an officer off once they
 * have learned the post, and withdraw it when they should not work it alone
 * any more. Officers see the posts they are cleared for.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam, isoFields } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, TRAINING_METHODS, trainingState } from '../shared.js';
import { trainingBoard, officerTraining, qualificationById, TRAINING_ROSTER_DAYS } from '../services/training.js';
import { pushAsync } from '../services/push.js';
import { toSql } from '../services/compliance.js';

export const siteTrainingRouter = Router();
siteTrainingRouter.use(requireAuth);

/** The posts the signed-in officer is cleared for, and any training shifts coming up. */
siteTrainingRouter.get(
  '/mine',
  wrap(async (req, res) => {
    res.json(await officerTraining(req.user.id));
  })
);

const supervisor = requireRole(ROLES.SUPERVISOR);

siteTrainingRouter.get(
  '/',
  supervisor,
  wrap(async (_req, res) => {
    res.json(await trainingBoard());
  })
);

/** One officer's site training, for their record. */
siteTrainingRouter.get(
  '/officers/:userId',
  supervisor,
  wrap(async (req, res) => {
    res.json(await officerTraining(idParam(req.params.userId, 'officer')));
  })
);

/**
 * One post: everyone trained there, and everyone else who could be signed off,
 * with how often they have worked it.
 */
siteTrainingRouter.get(
  '/posts/:postId',
  supervisor,
  wrap(async (req, res) => {
    const postId = idParam(req.params.postId, 'post');
    const post = await db
      .prepare(`SELECT p.id, p.name, p.training_required, p.armed, s.name AS site_name FROM posts p JOIN sites s ON s.id = p.site_id WHERE p.id = ?`)
      .get(postId);
    if (!post) throw new HttpError(404, 'Post not found.');
    const people = await db
      .prepare(
        `SELECT u.id AS user_id, u.first_name || ' ' || u.last_name AS name, u.employee_code, u.role,
                q.id AS qualification_id, q.status, q.trained_at,
                (SELECT COUNT(*) FROM time_entries te WHERE te.post_id = ? AND te.user_id = u.id AND te.clock_out_at IS NOT NULL) AS shifts_here,
                (SELECT MAX(te.clock_in_at) FROM time_entries te WHERE te.post_id = ? AND te.user_id = u.id AND te.clock_out_at IS NOT NULL) AS last_worked_at
         FROM users u
         LEFT JOIN post_qualifications q ON q.post_id = ? AND q.user_id = u.id
         WHERE u.status = 'active' AND u.role IN ('officer','supervisor')
         ORDER BY u.last_name, u.first_name`
      )
      .all(postId, postId, postId);
    res.json({
      post: { ...post, training_required: Boolean(post.training_required), armed: Boolean(post.armed) },
      people: people
        .map((p) => {
          const state = trainingState(p.qualification_id ? { status: p.status, trained_at: p.trained_at } : null, p.last_worked_at);
          const { status: _s, trained_at, ...rest } = p;
          return { ...isoFields({ ...rest, trained_at }, ['trained_at', 'last_worked_at']), shifts_here: Number(p.shifts_here), state };
        })
        // Those who know the post best first, then everyone else by name.
        .sort((a, b) => b.shifts_here - a.shifts_here || a.name.localeCompare(b.name)),
    });
  })
);

const signOffSchema = z.object({
  postId: z.number().int().positive(),
  userId: z.number().int().positive(),
  method: z.enum(TRAINING_METHODS),
  note: z.string().trim().max(500).optional(),
});

/** Sign an officer off at a post, or again after a lapse or a withdrawal. */
siteTrainingRouter.post(
  '/',
  supervisor,
  wrap(async (req, res) => {
    const body = parse(signOffSchema, req.body);
    const post = await db
      .prepare(`SELECT p.*, s.name AS site_name FROM posts p JOIN sites s ON s.id = p.site_id WHERE p.id = ?`)
      .get(body.postId);
    if (!post || !post.active) throw new HttpError(404, 'Post not found.');
    const officer = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(body.userId);
    if (!officer || officer.status !== 'active' || !['officer', 'supervisor'].includes(officer.role)) {
      throw new HttpError(404, 'Officer not found.');
    }
    if (officer.id === req.user.id) throw new HttpError(403, 'Someone else has to sign off your own training.');
    if (body.method === 'shadow_shift' && !body.note) {
      throw new HttpError(422, 'Say who they shadowed, and when.', [{ field: 'note', message: 'Who they shadowed.' }]);
    }

    const existing = await db
      .prepare(`SELECT q.*, (SELECT MAX(te.clock_in_at) FROM time_entries te WHERE te.post_id = q.post_id AND te.user_id = q.user_id AND te.clock_out_at IS NOT NULL) AS last_worked_at
                FROM post_qualifications q WHERE q.post_id = ? AND q.user_id = ?`)
      .get(post.id, officer.id);
    if (existing && trainingState(existing, existing.last_worked_at) === 'trained') {
      throw new HttpError(409, `${officer.first_name} is already trained at ${post.name}.`);
    }

    await db
      .prepare(
        `INSERT INTO post_qualifications (post_id, user_id, status, method, note, trained_at, signed_off_by)
         VALUES (?, ?, 'trained', ?, ?, now(), ?)
         ON CONFLICT (post_id, user_id) DO UPDATE SET
           status = 'trained', method = excluded.method, note = excluded.note, trained_at = now(),
           signed_off_by = excluded.signed_off_by, revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL`
      )
      .run(post.id, officer.id, body.method, body.note || null, req.user.id);
    const saved = await db.prepare(`SELECT id FROM post_qualifications WHERE post_id = ? AND user_id = ?`).get(post.id, officer.id);
    await audit(req.user.id, 'training.signed_off', 'user', officer.id,
      { postId: post.id, method: body.method, again: Boolean(existing) }, req.ip);

    pushAsync([officer.id], {
      title: 'Cleared for a post',
      body: `You are signed off to work ${post.name} at ${post.site_name}.`,
      data: { type: 'site_training', postId: post.id },
    });
    res.status(existing ? 200 : 201).json({ qualification: await qualificationById(saved.id) });
  })
);

/** Withdraw an officer's training at a post. They can be signed off again later. */
siteTrainingRouter.post(
  '/:id/revoke',
  supervisor,
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'training record');
    const body = parse(z.object({ reason: z.string().trim().min(5, 'Say why, for their record.').max(500) }), req.body);
    const q = await db.prepare(`SELECT * FROM post_qualifications WHERE id = ?`).get(id);
    if (!q) throw new HttpError(404, 'Training record not found.');
    if (q.status === 'revoked') throw new HttpError(409, 'That training has already been withdrawn.');

    await db
      .prepare(`UPDATE post_qualifications SET status = 'revoked', revoked_at = now(), revoked_by = ?, revoke_reason = ? WHERE id = ?`)
      .run(req.user.id, body.reason, id);
    await audit(req.user.id, 'training.revoked', 'user', q.user_id, { postId: q.post_id, reason: body.reason }, req.ip);

    // Shifts they are already rostered on there now want a trained officer
    // alongside, or someone else; say how many so the supervisor can act.
    const upcoming = (await db
      .prepare(
        `SELECT sh.id, sh.starts_at, sh.ends_at FROM shifts sh
         WHERE sh.user_id = ? AND sh.post_id = ? AND sh.status = 'scheduled' AND sh.starts_at > now() AND sh.starts_at < ?
         ORDER BY sh.starts_at`
      )
      .all(q.user_id, q.post_id, toSql(new Date(Date.now() + TRAINING_ROSTER_DAYS * 86400000))))
      .map((s) => isoFields(s, ['starts_at', 'ends_at']));

    const saved = await qualificationById(id);
    pushAsync([q.user_id], {
      title: 'Site training withdrawn',
      body: `You are no longer cleared to work ${saved.post_name} alone. Your supervisor will be in touch.`,
      data: { type: 'site_training', postId: q.post_id },
    });
    res.json({ qualification: saved, upcoming });
  })
);
