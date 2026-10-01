/**
 * Time corrections: an officer asks for one of their punches to be fixed.
 *
 * The officer says what the times should have been and why; an administrator
 * approves it, which changes the entry through the same path as their own
 * corrections (original times kept, closed pay periods refused), or declines
 * it with a reason. Supervisors can see the queue. A request is only for the
 * officer's own recent shifts, and one at a time per shift.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, idParam, sqlToIso, toDateString } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, RULES, FLAG_TYPES, CORRECTION_WINDOW_DAYS, CORRECTION_STATUS_LABEL, minutesBetween } from '../shared.js';
import { toSql } from '../services/compliance.js';
import { closedPeriodOn, periodLabel } from '../services/payPeriods.js';
import { adjustEntry, resolveTimes } from '../services/timeEntries.js';
import { pushAsync } from '../services/push.js';

export const correctionsRouter = Router();
correctionsRouter.use(requireAuth);

const onlySupervisor = requireRole(ROLES.SUPERVISOR);
const onlyAdmin = requireRole(ROLES.ADMIN);

const TIMES = ['proposed_clock_in_at', 'proposed_clock_out_at', 'recorded_clock_in_at', 'recorded_clock_out_at', 'decided_at', 'created_at'];
const ENTRY_TIMES = ['clock_in_at', 'clock_out_at', 'original_clock_in_at', 'original_clock_out_at'];

const correctionSelect = `
  SELECT c.*, u.employee_code, u.first_name || ' ' || u.last_name AS officer,
         d.first_name || ' ' || d.last_name AS decided_by_name,
         te.clock_in_at, te.clock_out_at, te.minutes_worked, te.adjusted_by,
         p.name AS post_name, s.name AS site_name
  FROM time_corrections c
  JOIN users u ON u.id = c.user_id
  JOIN time_entries te ON te.id = c.time_entry_id
  JOIN posts p ON p.id = te.post_id
  JOIN sites s ON s.id = p.site_id
  LEFT JOIN users d ON d.id = c.decided_by`;

const present = (c) => {
  const out = isoFields(c, [...TIMES, 'clock_in_at', 'clock_out_at']);
  out.status_label = CORRECTION_STATUS_LABEL[c.status] || c.status;
  // What the shift would come to if approved, against what it says now.
  const inAt = out.proposed_clock_in_at || out.recorded_clock_in_at;
  const outAt = out.proposed_clock_out_at || out.recorded_clock_out_at;
  out.proposed_minutes = inAt && outAt ? minutesBetween(inAt, outAt) : null;
  out.recorded_minutes = out.recorded_clock_out_at ? minutesBetween(out.recorded_clock_in_at, out.recorded_clock_out_at) : null;
  return out;
};

async function load(id) {
  const row = await db.prepare(`${correctionSelect} WHERE c.id = ?`).get(idParam(id, 'request'));
  if (!row) throw new HttpError(404, 'Request not found.');
  return row;
}

/* ------------------------------------------------------------ the officer -- */

/** My punches from the last two weeks, each with its latest request. */
correctionsRouter.get(
  '/mine',
  wrap(async (req, res) => {
    const since = toSql(new Date(Date.now() - CORRECTION_WINDOW_DAYS * 86400000));
    const entries = await db
      .prepare(
        `SELECT te.id, te.clock_in_at, te.clock_out_at, te.minutes_worked, te.late_minutes, te.adjusted_by,
                te.original_clock_in_at, te.original_clock_out_at, te.adjustment_reason,
                p.name AS post_name, s.name AS site_name,
                (SELECT f.id FROM flags f WHERE f.ref_type = 'time_entry' AND f.ref_id = te.id AND f.type = ? AND f.resolved_at IS NULL LIMIT 1) AS auto_closed_flag
         FROM time_entries te JOIN posts p ON p.id = te.post_id JOIN sites s ON s.id = p.site_id
         WHERE te.user_id = ? AND te.clock_in_at >= ?
         ORDER BY te.clock_in_at DESC LIMIT 60`
      )
      .all(FLAG_TYPES.MISSED_CLOCK_OUT, req.user.id, since);
    const requests = await db
      .prepare(`${correctionSelect} WHERE c.user_id = ? AND c.created_at >= ? ORDER BY c.created_at DESC`)
      .all(req.user.id, toSql(new Date(Date.now() - 60 * 86400000)));
    const latest = new Map();
    for (const r of requests) if (!latest.has(r.time_entry_id)) latest.set(r.time_entry_id, present(r));
    res.json({
      windowDays: CORRECTION_WINDOW_DAYS,
      entries: entries.map((e) => ({
        ...isoFields(e, ENTRY_TIMES),
        auto_closed: Boolean(e.auto_closed_flag),
        adjusted: e.adjusted_by != null,
        correction: latest.get(e.id) || null,
      })),
      requests: requests.map(present),
    });
  })
);

const requestSchema = z
  .object({
    entryId: z.number().int().positive(),
    clockInAt: z.string().min(10).nullable().optional(),
    clockOutAt: z.string().min(10).nullable().optional(),
    reason: z.string().trim().min(10, 'Say what happened, so the office can check it.').max(500),
  })
  .refine((b) => b.clockInAt || b.clockOutAt, { message: 'Give the clock-in or clock-out time it should have been.', path: ['clockInAt'] });

correctionsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = parse(requestSchema, req.body);
    const entry = await db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(body.entryId);
    // Somebody else's shift is not somewhere to look.
    if (!entry || entry.user_id !== req.user.id) throw new HttpError(404, 'Shift not found.');
    const recordedIn = new Date(sqlToIso(entry.clock_in_at));
    if (recordedIn < new Date(Date.now() - CORRECTION_WINDOW_DAYS * 86400000)) {
      throw new HttpError(409, `Corrections can be asked for up to ${CORRECTION_WINDOW_DAYS} days after a shift. Talk to the office about older ones.`);
    }
    if (!entry.clock_out_at && body.clockOutAt) {
      throw new HttpError(409, 'You are still clocked in on that shift. Clock out first, then ask for the time to be fixed.');
    }
    const pending = await db.prepare(`SELECT id FROM time_corrections WHERE time_entry_id = ? AND status = 'pending'`).get(entry.id);
    if (pending) throw new HttpError(409, 'There is already a request waiting for that shift. Withdraw it to change it.');

    const { clockIn, clockOut } = resolveTimes(entry, { clockInAt: body.clockInAt || undefined, clockOutAt: body.clockOutAt || undefined });
    const now = Date.now();
    if (clockIn.getTime() > now || (clockOut && clockOut.getTime() > now)) {
      throw new HttpError(422, 'A corrected time cannot be in the future.', [{ field: clockOut && clockOut.getTime() > now ? 'clockOutAt' : 'clockInAt', message: 'Not in the future.' }]);
    }
    if (Math.abs(clockIn - recordedIn) > 12 * 3600000) {
      throw new HttpError(422, 'That clock-in is more than 12 hours from the recorded one. Talk to the office.', [{ field: 'clockInAt', message: 'Too far from the recorded time.' }]);
    }
    if (clockOut && clockOut - clockIn > RULES.maxShiftHours * 3600000) {
      throw new HttpError(422, `A shift can be at most ${RULES.maxShiftHours} hours.`, [{ field: 'clockOutAt', message: 'Too long.' }]);
    }
    const sameIn = clockIn.getTime() === recordedIn.getTime();
    const sameOut = (clockOut?.getTime() ?? null) === (entry.clock_out_at ? new Date(sqlToIso(entry.clock_out_at)).getTime() : null);
    if (sameIn && sameOut) throw new HttpError(422, 'Those are the times already recorded.');
    // Paid hours are paid: only the office can reopen a closed period.
    const day = toDateString(recordedIn);
    const closed = await closedPeriodOn(day);
    if (closed) {
      throw new HttpError(409, `Payroll for ${periodLabel(closed)} is closed: those hours have been paid. Talk to the office about this shift.`, { code: 'period_closed' });
    }

    const info = await db
      .prepare(
        `INSERT INTO time_corrections (time_entry_id, user_id, proposed_clock_in_at, proposed_clock_out_at,
           recorded_clock_in_at, recorded_clock_out_at, reason)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(entry.id, req.user.id, sameIn ? null : toSql(clockIn), sameOut ? null : clockOut ? toSql(clockOut) : null,
        entry.clock_in_at, entry.clock_out_at, body.reason);
    const id = Number(info.lastInsertRowid);
    await audit(req.user.id, 'correction.requested', 'time_correction', id, { entry: entry.id }, req.ip);
    res.status(201).json({ correction: present(await load(id)) });
  })
);

correctionsRouter.post(
  '/:id/withdraw',
  wrap(async (req, res) => {
    const c = await load(req.params.id);
    if (c.user_id !== req.user.id) throw new HttpError(404, 'Request not found.');
    if (c.status !== 'pending') throw new HttpError(409, 'Only a request still waiting can be withdrawn.');
    await db.prepare(`UPDATE time_corrections SET status = 'withdrawn', decided_at = now() WHERE id = ?`).run(c.id);
    await audit(req.user.id, 'correction.withdrawn', 'time_correction', c.id, null, req.ip);
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------- the office -- */

correctionsRouter.get(
  '/',
  onlySupervisor,
  wrap(async (req, res) => {
    const status = ['pending', 'approved', 'declined', 'withdrawn', 'all'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = await db
      .prepare(
        `${correctionSelect} ${status === 'all' ? '' : 'WHERE c.status = ?'}
         ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`
      )
      .all(...(status === 'all' ? [] : [status]));
    const pending = Number((await db.prepare(`SELECT COUNT(*) AS n FROM time_corrections WHERE status = 'pending'`).get()).n);
    res.json({ corrections: rows.map(present), pending });
  })
);

const decide = (c) => {
  if (c.status !== 'pending') throw new HttpError(409, c.status === 'withdrawn' ? 'The officer withdrew that request.' : 'That request has already been decided.');
};

correctionsRouter.post(
  '/:id/approve',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(z.object({ note: z.string().trim().max(300).nullable().optional() }), req.body || {});
    const c = await load(req.params.id);
    decide(c);
    const entry = await db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(c.time_entry_id);
    const updated = await adjustEntry(entry, {
      clockInAt: c.proposed_clock_in_at ? sqlToIso(c.proposed_clock_in_at) : undefined,
      clockOutAt: c.proposed_clock_out_at ? sqlToIso(c.proposed_clock_out_at) : undefined,
      reason: `Officer's correction request: ${c.reason}`,
      userId: req.user.id,
      ip: req.ip,
    });

    // A late clock-in recomputed against the shift, so the flag and the
    // timesheet agree with the corrected time.
    if (c.proposed_clock_in_at && updated.shift_id) {
      const shift = await db.prepare(`SELECT starts_at FROM shifts WHERE id = ?`).get(updated.shift_id);
      if (shift) {
        const late = Math.max(0, minutesBetween(sqlToIso(shift.starts_at), sqlToIso(updated.clock_in_at)) - RULES.lateGraceMinutes);
        await db.prepare(`UPDATE time_entries SET late_minutes = ? WHERE id = ?`).run(late, updated.id);
        if (late === 0) await resolveFlags(updated.id, [FLAG_TYPES.LATE_CLOCK_IN], req.user.id, 'Clock-in corrected on the officer\'s request.');
      }
    }
    // The missing clock-out the sweep had to guess is now known.
    if (c.proposed_clock_out_at) {
      await resolveFlags(updated.id, [FLAG_TYPES.MISSED_CLOCK_OUT], req.user.id, 'Clock-out corrected on the officer\'s request.');
    }

    await db
      .prepare(`UPDATE time_corrections SET status = 'approved', decided_by = ?, decided_at = now(), decision_note = ? WHERE id = ?`)
      .run(req.user.id, body.note || null, c.id);
    await audit(req.user.id, 'correction.approved', 'time_correction', c.id, { entry: c.time_entry_id }, req.ip);
    pushAsync([c.user_id], {
      title: 'Time correction approved',
      body: `${c.post_name}: your hours have been corrected.`,
      data: { type: 'correction', id: c.id },
    });
    res.json({ correction: present(await load(c.id)) });
  })
);

correctionsRouter.post(
  '/:id/decline',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(z.object({ note: z.string().trim().min(5, 'Tell the officer why.').max(300) }), req.body);
    const c = await load(req.params.id);
    decide(c);
    await db
      .prepare(`UPDATE time_corrections SET status = 'declined', decided_by = ?, decided_at = now(), decision_note = ? WHERE id = ?`)
      .run(req.user.id, body.note, c.id);
    await audit(req.user.id, 'correction.declined', 'time_correction', c.id, null, req.ip);
    pushAsync([c.user_id], {
      title: 'Time correction declined',
      body: `${c.post_name}: ${body.note}`.slice(0, 160),
      data: { type: 'correction', id: c.id },
    });
    res.json({ correction: present(await load(c.id)) });
  })
);

async function resolveFlags(entryId, types, userId, note) {
  await db
    .prepare(
      `UPDATE flags SET resolved_at = now(), resolved_by = ?, resolution_note = ?
       WHERE ref_type = 'time_entry' AND ref_id = ? AND resolved_at IS NULL AND type IN (${types.map(() => '?').join(',')})`
    )
    .run(userId, note, entryId, ...types);
}
