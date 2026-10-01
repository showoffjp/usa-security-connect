/**
 * Dispatch: calls for service, from raised to cleared.
 *
 * Supervisors run the board - raise a call the office took by phone, send it
 * to an officer, cancel it. The officer it was sent to acknowledges it, says
 * when they are on scene and clears it with what they found, or turns it back
 * if they cannot go. Officers see only the calls sent to them.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam, limitParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, atLeast, CALL_TYPES, CALL_PRIORITIES, CALL_DISPOSITIONS, OPEN_CALL_STATUSES } from '../shared.js';
import { toSql } from '../services/compliance.js';
import {
  callSelect,
  loadCall,
  presentCall,
  eventsFor,
  logEvent,
  candidatesFor,
  onDutyEntry,
  pushToOfficer,
  OPEN_SQL,
} from '../services/dispatch.js';
import { notifyCallCleared } from '../services/email.js';
import { pushAsync } from '../services/push.js';

export const dispatchRouter = Router();
dispatchRouter.use(requireAuth);

const onlySupervisor = requireRole(ROLES.SUPERVISOR);
const isSupervisor = (req) => atLeast(req.user.role, ROLES.SUPERVISOR);

async function findCall(id) {
  const call = await loadCall(idParam(id, 'call'));
  if (!call) throw new HttpError(404, 'Call not found.');
  return call;
}

/** The officer the call was sent to, or a supervisor acting for them. */
function assertHolder(req, call) {
  if (call.assigned_to === req.user.id || isSupervisor(req)) return;
  // An officer has no business learning about somebody else's call.
  throw new HttpError(404, 'Call not found.');
}

/* ------------------------------------------------------------ the officer -- */

/** The calls sent to me that are still open, and what I cleared in the last twelve hours. */
dispatchRouter.get(
  '/mine',
  wrap(async (req, res) => {
    const active = await db
      .prepare(`${callSelect} WHERE c.assigned_to = ? AND c.status IN (${OPEN_SQL}) ORDER BY c.priority, c.created_at`)
      .all(req.user.id);
    const recent = await db
      .prepare(`${callSelect} WHERE c.assigned_to = ? AND c.status = 'cleared' AND c.cleared_at >= ? ORDER BY c.cleared_at DESC LIMIT 10`)
      .all(req.user.id, toSql(new Date(Date.now() - 12 * 3600000)));
    const now = new Date();
    res.json({ active: active.map((c) => presentCall(c, now)), recent: recent.map((c) => presentCall(c, now)) });
  })
);

dispatchRouter.post(
  '/:id/acknowledge',
  wrap(async (req, res) => {
    const call = await findCall(req.params.id);
    assertHolder(req, call);
    if (call.status !== 'assigned') {
      throw new HttpError(409, call.status === 'open' ? 'That call has not been sent to anyone yet.' : 'That call has already been acknowledged.');
    }
    await db.prepare(`UPDATE service_calls SET status = 'en_route', acknowledged_at = now() WHERE id = ?`).run(call.id);
    await logEvent(call.id, 'acknowledged', { userId: req.user.id });
    res.json({ call: presentCall(await loadCall(call.id)) });
  })
);

dispatchRouter.post(
  '/:id/arrive',
  wrap(async (req, res) => {
    const call = await findCall(req.params.id);
    assertHolder(req, call);
    if (!['assigned', 'en_route'].includes(call.status)) {
      throw new HttpError(409, call.status === 'on_scene' ? 'Already marked on scene.' : 'That call is not on its way to anyone.');
    }
    // Arriving without pressing "on my way" first still counts as acknowledging it.
    await db
      .prepare(`UPDATE service_calls SET status = 'on_scene', arrived_at = now(), acknowledged_at = COALESCE(acknowledged_at, now()) WHERE id = ?`)
      .run(call.id);
    await logEvent(call.id, 'arrived', { userId: req.user.id });
    res.json({ call: presentCall(await loadCall(call.id)) });
  })
);

const clearSchema = z.object({
  disposition: z.enum(CALL_DISPOSITIONS),
  outcome: z.string().trim().min(5, 'Say what you found and what you did.').max(1000),
  incidentId: z.number().int().positive().nullable().optional(),
});

dispatchRouter.post(
  '/:id/clear',
  wrap(async (req, res) => {
    const call = await findCall(req.params.id);
    assertHolder(req, call);
    const body = parse(clearSchema, req.body);
    if (!OPEN_CALL_STATUSES.includes(call.status)) throw new HttpError(409, 'That call is already closed.');
    // The response time is the point of the record: the officer says they
    // got there before they say how it ended. A supervisor can close a call
    // that never needed anyone on scene.
    if (!isSupervisor(req) && call.status !== 'on_scene') {
      throw new HttpError(409, 'Mark yourself on scene first.');
    }
    if (call.status === 'open' && body.disposition !== 'referred' && body.disposition !== 'nothing_found') {
      throw new HttpError(409, 'Send the call to an officer first, or cancel it.');
    }
    if (body.incidentId) {
      const incident = await db
        .prepare(`SELECT i.id FROM incidents i LEFT JOIN posts p ON p.id = i.post_id WHERE i.id = ? AND (i.site_id = ? OR p.site_id = ?)`)
        .get(body.incidentId, call.site_id, call.site_id);
      if (!incident) throw new HttpError(422, 'That incident report is not from this site.', [{ field: 'incidentId', message: 'Pick a report from this site.' }]);
    }
    await db
      .prepare(
        `UPDATE service_calls SET status = 'cleared', cleared_at = now(), cleared_by = ?, disposition = ?, outcome = ?, incident_id = ?
         WHERE id = ?`
      )
      .run(req.user.id, body.disposition, body.outcome, body.incidentId ?? null, call.id);
    await logEvent(call.id, 'cleared', { userId: req.user.id, note: body.outcome });
    await audit(req.user.id, 'call.cleared', 'service_call', call.id, { disposition: body.disposition }, req.ip);
    const cleared = await loadCall(call.id);
    if (cleared.client_user_id) notifyCallCleared(cleared).catch((err) => console.error('[usc] call email', err.message));
    res.json({ call: presentCall(cleared) });
  })
);

/** I cannot go. The call goes back on the board with the reason, and the supervisors are told. */
dispatchRouter.post(
  '/:id/decline',
  wrap(async (req, res) => {
    const call = await findCall(req.params.id);
    if (call.assigned_to !== req.user.id) throw new HttpError(404, 'Call not found.');
    const body = parse(z.object({ reason: z.string().trim().min(3, 'Say why, so the supervisor can send someone else.').max(300) }), req.body);
    if (!['assigned', 'en_route'].includes(call.status)) {
      throw new HttpError(409, 'Once you are on scene, clear the call instead.');
    }
    await db
      .prepare(
        `UPDATE service_calls SET status = 'open', assigned_to = NULL, assigned_by = NULL, assigned_at = NULL, acknowledged_at = NULL
         WHERE id = ?`
      )
      .run(call.id);
    await logEvent(call.id, 'declined', { userId: req.user.id, note: body.reason });
    res.json({ ok: true });
  })
);

/* -------------------------------------------------------- the supervisor -- */

dispatchRouter.get(
  '/',
  onlySupervisor,
  wrap(async (req, res) => {
    const view = req.query.view === 'closed' ? 'closed' : 'active';
    const siteId = idParam(req.query.siteId, 'site');
    const now = new Date();
    let rows;
    if (view === 'active') {
      rows = await db
        .prepare(
          `${callSelect} WHERE c.status IN (${OPEN_SQL}) ${siteId ? 'AND c.site_id = ?' : ''}
           ORDER BY CASE c.status WHEN 'open' THEN 0 ELSE 1 END, c.priority, c.created_at`
        )
        .all(...(siteId ? [siteId] : []));
    } else {
      const days = limitParam(req.query.days, 7, 92);
      rows = await db
        .prepare(
          `${callSelect} WHERE c.status IN ('cleared','cancelled') AND c.created_at >= ? ${siteId ? 'AND c.site_id = ?' : ''}
           ORDER BY c.created_at DESC LIMIT 300`
        )
        .all(toSql(new Date(now.getTime() - days * 86400000)), ...(siteId ? [siteId] : []));
    }
    const calls = rows.map((c) => presentCall(c, now));

    // Today's numbers for the header, whatever the view.
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const today = (await db.prepare(`${callSelect} WHERE c.created_at >= ?`).all(toSql(midnight))).map((c) => presentCall(c, now));
    const arrived = today.map((c) => c.timings.toArrive).filter((m) => m != null);
    const open = await db.prepare(`SELECT status, COUNT(*) AS n FROM service_calls WHERE status IN (${OPEN_SQL}) GROUP BY status`).all();
    const byStatus = Object.fromEntries(open.map((r) => [r.status, Number(r.n)]));
    res.json({
      view,
      calls,
      summary: {
        waiting: byStatus.open || 0,
        active: Object.values(byStatus).reduce((n, v) => n + v, 0),
        today: today.length,
        clearedToday: today.filter((c) => c.status === 'cleared').length,
        avgArriveToday: arrived.length ? Math.round(arrived.reduce((n, m) => n + m, 0) / arrived.length) : null,
        withinTargetToday: arrived.length ? Math.round((today.filter((c) => c.timings.withinTarget).length / arrived.length) * 100) : null,
      },
    });
  })
);

dispatchRouter.get(
  '/:id',
  onlySupervisor,
  wrap(async (req, res) => {
    const call = await findCall(req.params.id);
    const open = OPEN_CALL_STATUSES.includes(call.status);
    res.json({
      call: presentCall(call),
      events: await eventsFor(call.id),
      candidates: open ? await candidatesFor(call) : [],
    });
  })
);

const callSchema = z.object({
  siteId: z.number().int().positive(),
  postId: z.number().int().positive().nullable().optional(),
  callType: z.enum(CALL_TYPES),
  priority: z.number().int().refine((n) => CALL_PRIORITIES.includes(n), 'Pick a priority.'),
  location: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().min(5, 'Say what is happening.').max(1000),
  callerName: z.string().trim().max(80).nullable().optional(),
  callerPhone: z.string().trim().max(30).nullable().optional(),
  assignTo: z.number().int().positive().nullable().optional(),
});

/** Where a call can go: an active officer on the clock right now. */
async function assertAssignable(userId) {
  const officer = await db.prepare(`SELECT id, status FROM users WHERE id = ?`).get(userId);
  if (!officer || officer.status !== 'active') throw new HttpError(422, 'Pick an active officer.', [{ field: 'userId', message: 'Pick an active officer.' }]);
  if (!(await onDutyEntry(userId))) {
    throw new HttpError(422, 'That officer is not on duty. Send the call to someone on the clock.', [{ field: 'userId', message: 'Not on duty.' }]);
  }
}

dispatchRouter.post(
  '/',
  onlySupervisor,
  wrap(async (req, res) => {
    const body = parse(callSchema, req.body);
    const site = await db.prepare(`SELECT id, active FROM sites WHERE id = ?`).get(body.siteId);
    if (!site || !site.active) throw new HttpError(422, 'Pick an active site.', [{ field: 'siteId', message: 'Pick a site.' }]);
    if (body.postId) {
      const post = await db.prepare(`SELECT site_id FROM posts WHERE id = ?`).get(body.postId);
      if (!post || post.site_id !== site.id) throw new HttpError(422, 'That post is not at this site.', [{ field: 'postId', message: 'Pick a post at this site.' }]);
    }
    if (body.assignTo) await assertAssignable(body.assignTo);

    const info = await db
      .prepare(
        `INSERT INTO service_calls (site_id, post_id, call_type, priority, location, description, caller_name, caller_phone, source, created_by)
         VALUES (?,?,?,?,?,?,?,?, 'office', ?)`
      )
      .run(site.id, body.postId ?? null, body.callType, body.priority, body.location || null, body.description,
        body.callerName || null, body.callerPhone || null, req.user.id);
    const id = Number(info.lastInsertRowid);
    await logEvent(id, 'raised', { userId: req.user.id });
    if (body.assignTo) {
      await db.prepare(`UPDATE service_calls SET status = 'assigned', assigned_to = ?, assigned_by = ?, assigned_at = now() WHERE id = ?`)
        .run(body.assignTo, req.user.id, id);
      await logEvent(id, 'assigned', { userId: req.user.id, note: await nameOf(body.assignTo) });
    }
    await audit(req.user.id, 'call.raised', 'service_call', id, { priority: body.priority, type: body.callType }, req.ip);
    const call = await loadCall(id);
    if (body.assignTo) pushToOfficer(call, body.assignTo);
    res.status(201).json({ call: presentCall(call) });
  })
);

const nameOf = async (userId) => {
  const u = await db.prepare(`SELECT first_name || ' ' || last_name AS name FROM users WHERE id = ?`).get(userId);
  return u?.name || null;
};

/** Send, or re-send, a call to an officer on duty. */
dispatchRouter.post(
  '/:id/assign',
  onlySupervisor,
  wrap(async (req, res) => {
    const call = await findCall(req.params.id);
    const body = parse(z.object({ userId: z.number().int().positive() }), req.body);
    if (!['open', 'assigned', 'en_route'].includes(call.status)) {
      throw new HttpError(409, call.status === 'on_scene' ? 'An officer is already on scene.' : 'That call is closed.');
    }
    if (call.assigned_to === body.userId) throw new HttpError(409, 'That officer already has the call.');
    await assertAssignable(body.userId);
    const previous = call.assigned_to;
    await db
      .prepare(
        `UPDATE service_calls SET status = 'assigned', assigned_to = ?, assigned_by = ?, assigned_at = now(), acknowledged_at = NULL
         WHERE id = ?`
      )
      .run(body.userId, req.user.id, call.id);
    await logEvent(call.id, previous ? 'reassigned' : 'assigned', { userId: req.user.id, note: await nameOf(body.userId) });
    await audit(req.user.id, 'call.assigned', 'service_call', call.id, { to: body.userId, from: previous }, req.ip);
    const updated = await loadCall(call.id);
    pushToOfficer(updated, body.userId);
    res.json({ call: presentCall(updated) });
  })
);

dispatchRouter.post(
  '/:id/cancel',
  onlySupervisor,
  wrap(async (req, res) => {
    const call = await findCall(req.params.id);
    const body = parse(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled.').max(300) }), req.body);
    if (!OPEN_CALL_STATUSES.includes(call.status)) throw new HttpError(409, 'That call is already closed.');
    await db
      .prepare(`UPDATE service_calls SET status = 'cancelled', cancelled_at = now(), cancel_reason = ? WHERE id = ?`)
      .run(body.reason, call.id);
    await logEvent(call.id, 'cancelled', { userId: req.user.id, note: body.reason });
    await audit(req.user.id, 'call.cancelled', 'service_call', call.id, null, req.ip);
    if (call.assigned_to && call.assigned_to !== req.user.id) {
      pushAsync([call.assigned_to], { title: 'Call cancelled', body: `${call.site_name}: ${body.reason}`.slice(0, 160), data: { type: 'call', id: call.id } });
    }
    res.json({ call: presentCall(await loadCall(call.id)) });
  })
);
