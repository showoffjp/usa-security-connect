import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, idParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, BROADCAST_PRIORITY } from '../shared.js';
import { toSql } from '../services/compliance.js';
import { notifyBroadcast, notifyMessage } from '../services/push.js';

/* ============================================================ broadcasts === */

export const broadcastsRouter = Router();
broadcastsRouter.use(requireAuth);

broadcastsRouter.get(
  '/',
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT b.*, u.first_name || ' ' || u.last_name AS author,
                r.read_at, r.acknowledged_at
         FROM broadcasts b
         LEFT JOIN users u ON u.id = b.created_by
         LEFT JOIN broadcast_receipts r ON r.broadcast_id = b.id AND r.user_id = ?
         WHERE (b.expires_at IS NULL OR b.expires_at > datetime('now'))
           AND (b.audience_role IS NULL OR b.audience_role = ?)
           AND (b.audience_site_id IS NULL OR b.audience_site_id = ?
                OR b.audience_site_id IN (SELECT p.site_id FROM time_entries te
                                          JOIN posts p ON p.id = te.post_id
                                          WHERE te.user_id = ?))
         ORDER BY
           CASE b.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
           b.published_at DESC`
      )
      .all(req.user.id, req.user.role, req.user.default_site_id ?? -1, req.user.id));

    res.json({
      broadcasts: rows.map((r) => ({
        ...isoFields(r, ['published_at', 'expires_at', 'read_at', 'acknowledged_at']),
        unread: !r.read_at,
        needs_ack: Boolean(r.requires_ack) && !r.acknowledged_at,
      })),
    });
  })
);

broadcastsRouter.post(
  '/:id/receipt',
  wrap(async (req, res) => {
    const acknowledge = req.body?.acknowledge === true;
    const id = idParam(req.params.id, 'message');
    if (!(await db.prepare(`SELECT id FROM broadcasts WHERE id = ?`).get(id))) {
      throw new HttpError(404, 'That message no longer exists.');
    }
    // The existing row's columns are named in full: bare "read_at" in the
    // update is ambiguous between the row and EXCLUDED, which made every
    // second receipt - acknowledging a message already opened - fail.
    (await db.prepare(
      `INSERT INTO broadcast_receipts (broadcast_id, user_id, read_at, acknowledged_at)
       VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(broadcast_id, user_id) DO UPDATE SET
         read_at = COALESCE(broadcast_receipts.read_at, datetime('now')),
         acknowledged_at = COALESCE(broadcast_receipts.acknowledged_at, excluded.acknowledged_at)`
    ).run(id, req.user.id, acknowledge ? toSql(new Date()) : null));
    res.json({ ok: true });
  })
);

const broadcastSchema = z.object({
  title: z.string().trim().min(3, 'Give the message a title.').max(200),
  body: z.string().trim().min(3, 'Write the message.').max(5000),
  priority: z.enum(BROADCAST_PRIORITY).default('normal'),
  requiresAck: z.boolean().default(false),
  audienceRole: z.enum([ROLES.OFFICER, ROLES.SUPERVISOR, ROLES.ADMIN]).nullable().optional(),
  audienceSiteId: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});

broadcastsRouter.post(
  '/',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const body = parse(broadcastSchema, req.body);
    const info = (await db
      .prepare(
        `INSERT INTO broadcasts (title, body, priority, requires_ack, audience_role, audience_site_id, expires_at, created_by)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        body.title,
        body.body,
        body.priority,
        body.requiresAck ? 1 : 0,
        body.audienceRole ?? null,
        body.audienceSiteId ?? null,
        body.expiresAt ? toSql(new Date(body.expiresAt)) : null,
        req.user.id
      ));
    await audit(req.user.id, 'broadcast.published', 'broadcast', Number(info.lastInsertRowid), { title: body.title }, req.ip);

    const broadcast = (await db.prepare(`SELECT * FROM broadcasts WHERE id = ?`).get(info.lastInsertRowid));
    await notifyBroadcast(broadcast);

    res.status(201).json({ broadcast });
  })
);

/** Who has read / acknowledged a broadcast - the supervisor's proof of delivery. */
broadcastsRouter.get(
  '/:id/receipts',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT u.id, u.employee_code, u.first_name || ' ' || u.last_name AS name, u.role,
                r.read_at, r.acknowledged_at
         FROM users u
         LEFT JOIN broadcast_receipts r ON r.user_id = u.id AND r.broadcast_id = ?
         WHERE u.status = 'active'
         ORDER BY r.read_at IS NULL, u.last_name`
      )
      .all(req.params.id));
    res.json({ receipts: rows.map((r) => isoFields(r, ['read_at', 'acknowledged_at'])) });
  })
);

broadcastsRouter.delete(
  '/:id',
  requireRole(ROLES.ADMIN),
  wrap(async (req, res) => {
    (await db.prepare(`DELETE FROM broadcasts WHERE id = ?`).run(req.params.id));
    await audit(req.user.id, 'broadcast.deleted', 'broadcast', Number(req.params.id), null, req.ip);
    res.json({ ok: true });
  })
);

/* ============================================================== training === */

export const trainingRouter = Router();
trainingRouter.use(requireAuth);

trainingRouter.get(
  '/',
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT t.*, tp.seconds_watched, tp.completed_at
         FROM trainings t
         LEFT JOIN training_progress tp ON tp.training_id = t.id AND tp.user_id = ?
         WHERE t.audience_role IS NULL OR t.audience_role = ?
         ORDER BY t.required DESC, t.created_at DESC`
      )
      .all(req.user.id, req.user.role));

    res.json({
      trainings: rows.map((r) => ({
        ...isoFields(r, ['due_at', 'created_at', 'completed_at']),
        watched: Boolean(r.completed_at),
        percent: r.duration_seconds
          ? Math.min(100, Math.round(((r.seconds_watched || 0) / r.duration_seconds) * 100))
          : 0,
        overdue: Boolean(r.required && r.due_at && !r.completed_at && new Date(r.due_at + 'Z') < new Date()),
      })),
    });
  })
);

const progressSchema = z.object({
  secondsWatched: z.number().int().nonnegative(),
  completed: z.boolean().optional(),
});

trainingRouter.post(
  '/:id/progress',
  wrap(async (req, res) => {
    const body = parse(progressSchema, req.body);
    const training = (await db.prepare(`SELECT * FROM trainings WHERE id = ?`).get(req.params.id));
    if (!training) throw new HttpError(404, 'Training not found.');

    // A required video only counts as complete once it has actually been
    // watched through - 95% allows for rounding on the client's timer.
    const threshold = Math.floor(training.duration_seconds * 0.95);
    const completed =
      body.completed && (!training.required || !training.duration_seconds || body.secondsWatched >= threshold);

    if (body.completed && !completed) {
      throw new HttpError(409, 'This video must be watched in full before it can be marked complete.');
    }

    (await db.prepare(
      `INSERT INTO training_progress (training_id, user_id, seconds_watched, completed_at)
       VALUES (?,?,?,?)
       ON CONFLICT(training_id, user_id) DO UPDATE SET
         seconds_watched = GREATEST(training_progress.seconds_watched, excluded.seconds_watched),
         completed_at = COALESCE(training_progress.completed_at, excluded.completed_at)`
    ).run(training.id, req.user.id, body.secondsWatched, completed ? toSql(new Date()) : null));

    if (completed) {
      await audit(req.user.id, 'training.completed', 'training', training.id, { title: training.title }, req.ip);
    }
    res.json({ ok: true, completed: Boolean(completed) });
  })
);

const trainingSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).optional(),
  videoUrl: z.string().trim().max(1000).optional(),
  durationSeconds: z.number().int().nonnegative().default(0),
  required: z.boolean().default(false),
  dueAt: z.string().nullable().optional(),
  audienceRole: z.enum([ROLES.OFFICER, ROLES.SUPERVISOR, ROLES.ADMIN]).nullable().optional(),
});

trainingRouter.post(
  '/',
  requireRole(ROLES.ADMIN),
  wrap(async (req, res) => {
    const body = parse(trainingSchema, req.body);
    const info = (await db
      .prepare(
        `INSERT INTO trainings (title, description, video_url, duration_seconds, required, due_at, audience_role, created_by)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        body.title,
        body.description ?? null,
        body.videoUrl ?? null,
        body.durationSeconds,
        body.required ? 1 : 0,
        body.dueAt ? toSql(new Date(body.dueAt)) : null,
        body.audienceRole ?? null,
        req.user.id
      ));
    res.status(201).json({ training: (await db.prepare(`SELECT * FROM trainings WHERE id = ?`).get(info.lastInsertRowid)) });
  })
);

/** Completion matrix for the admin's compliance view. */
trainingRouter.get(
  '/:id/completion',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT u.id, u.employee_code, u.first_name || ' ' || u.last_name AS name,
                tp.seconds_watched, tp.completed_at
         FROM users u
         LEFT JOIN training_progress tp ON tp.user_id = u.id AND tp.training_id = ?
         WHERE u.status = 'active'
         ORDER BY tp.completed_at IS NULL DESC, u.last_name`
      )
      .all(req.params.id));
    res.json({ completion: rows.map((r) => isoFields(r, ['completed_at'])) });
  })
);

/* ============================================================== messages === */

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

messagesRouter.get(
  '/threads',
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT t.*, tp.last_read_at,
                (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY m.sent_at DESC LIMIT 1) AS preview,
                (SELECT COUNT(*) FROM messages m
                   WHERE m.thread_id = t.id AND m.sender_id != ?
                     AND (tp.last_read_at IS NULL OR m.sent_at > tp.last_read_at)) AS unread,
                (SELECT string_agg(u.first_name || ' ' || u.last_name, ', ')
                   FROM thread_participants x JOIN users u ON u.id = x.user_id
                   WHERE x.thread_id = t.id AND x.user_id != ?) AS participants
         FROM threads t
         JOIN thread_participants tp ON tp.thread_id = t.id AND tp.user_id = ?
         ORDER BY COALESCE(t.last_message_at, t.created_at) DESC`
      )
      .all(req.user.id, req.user.id, req.user.id));

    res.json({ threads: rows.map((r) => isoFields(r, ['created_at', 'last_message_at', 'last_read_at'])) });
  })
);

async function assertParticipant(threadId, userId) {
  const row = (await db
    .prepare(`SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?`)
    .get(threadId, userId));
  if (!row) throw new HttpError(403, 'You are not part of that conversation.');
}

messagesRouter.get(
  '/threads/:id',
  wrap(async (req, res) => {
    await assertParticipant(req.params.id, req.user.id);

    const messages = (await db
      .prepare(
        `SELECT m.*, u.first_name || ' ' || u.last_name AS sender_name, u.role AS sender_role
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.thread_id = ? ORDER BY m.sent_at`
      )
      .all(req.params.id));

    (await db.prepare(
      `UPDATE thread_participants SET last_read_at = datetime('now') WHERE thread_id = ? AND user_id = ?`
    ).run(req.params.id, req.user.id));

    const thread = (await db.prepare(`SELECT * FROM threads WHERE id = ?`).get(req.params.id));
    const participants = (await db
      .prepare(
        `SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.role
         FROM thread_participants tp JOIN users u ON u.id = tp.user_id WHERE tp.thread_id = ?`
      )
      .all(req.params.id));

    res.json({
      thread: isoFields(thread, ['created_at', 'last_message_at']),
      participants,
      messages: messages.map((m) => ({ ...isoFields(m, ['sent_at']), mine: m.sender_id === req.user.id })),
    });
  })
);

const newThreadSchema = z.object({
  subject: z.string().trim().max(200).optional(),
  recipientIds: z.array(z.number().int().positive()).min(1, 'Pick at least one person.'),
  body: z.string().trim().min(1, 'Write a message.').max(4000),
});

messagesRouter.post(
  '/threads',
  wrap(async (req, res) => {
    const body = parse(newThreadSchema, req.body);
    const ids = [...new Set([...body.recipientIds, req.user.id])];

    const found = (await db
      .prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'active'`)
      .all(...ids));
    if (found.length !== ids.length) throw new HttpError(422, 'One or more recipients are not available.');

    const threadId = await db.transaction(async () => {
      const info = (await db
        .prepare(`INSERT INTO threads (subject, created_by, last_message_at) VALUES (?,?,datetime('now'))`)
        .run(body.subject ?? null, req.user.id));
      const id = Number(info.lastInsertRowid);
      for (const uid of ids) {
        (await db.prepare(`INSERT INTO thread_participants (thread_id, user_id) VALUES (?,?)`).run(id, uid));
      }
      (await db.prepare(`INSERT INTO messages (thread_id, sender_id, body) VALUES (?,?,?)`).run(id, req.user.id, body.body));
      (await db.prepare(`UPDATE thread_participants SET last_read_at = datetime('now') WHERE thread_id = ? AND user_id = ?`)
        .run(id, req.user.id));
      return id;
    })();

    res.status(201).json({ threadId });
  })
);

messagesRouter.post(
  '/threads/:id/messages',
  wrap(async (req, res) => {
    const body = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
    await assertParticipant(req.params.id, req.user.id);

    const info = (await db
      .prepare(`INSERT INTO messages (thread_id, sender_id, body) VALUES (?,?,?)`)
      .run(req.params.id, req.user.id, body.body));
    (await db.prepare(`UPDATE threads SET last_message_at = datetime('now') WHERE id = ?`).run(req.params.id));
    (await db.prepare(`UPDATE thread_participants SET last_read_at = datetime('now') WHERE thread_id = ? AND user_id = ?`)
      .run(req.params.id, req.user.id));

    const message = (await db
      .prepare(
        `SELECT m.*, u.first_name || ' ' || u.last_name AS sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
      )
      .get(info.lastInsertRowid));

    await notifyMessage({
      threadId: Number(req.params.id),
      senderId: req.user.id,
      senderName: message.sender_name,
      body: body.body,
    });

    res.status(201).json({ message: { ...isoFields(message, ['sent_at']), mine: true } });
  })
);

/** Directory for starting a conversation. */
messagesRouter.get(
  '/contacts',
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT id, employee_code, first_name || ' ' || last_name AS name, role
         FROM users WHERE status = 'active' AND id != ?
         ORDER BY role DESC, last_name`
      )
      .all(req.user.id));
    res.json({ contacts: rows });
  })
);
