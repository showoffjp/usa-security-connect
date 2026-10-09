/**
 * Late arrivals and no-shows, as they happen.
 *
 * Every shift that has started in the last twelve hours is checked against
 * the clock-ins. Each stage it reaches is written once to attendance_events:
 *
 *   late     no clock-in RULES.lateGraceMinutes after the start
 *   no_show  none RULES.noShowMinutes after it
 *   arrived  the officer clocked in after all (and how late)
 *   covered  the shift was given to somebody else
 *
 * and two the officer gives before it gets that far, from their own app:
 *
 *   running_late  they are on their way, and when they expect to arrive
 *   called_off    they cannot come; the shift is opened for cover at once
 *
 * A new stage goes to every supervisor and administrator who asked to hear
 * about it - a text to their verified phone, a push to the app, or both. Only
 * the latest fresh stage is sent, so a sweep that has not run for half an
 * hour sends "no-show", not "late" and then "no-show". The unique key on
 * (shift, officer, stage) is what keeps two sweeps from sending twice.
 */

import { db } from '../lib/db.js';
import { sqlToIso } from '../lib/http.js';
import { RULES, ROLES, CALL_OFF_REASONS, CALL_OFF_LABEL, ATTENDANCE_POINTS, attendancePointsFor, CONDUCT_LEVEL_LABEL } from '../shared.js';
import { HttpError } from '../lib/http.js';
import { toSql } from './compliance.js';
import { pushAsync } from './push.js';
import { sendSms, displayPhone, maskPhone, smsConfigured, smsKind } from './sms.js';
import { publicUrl } from './email.js';

const MIN = 60000;
/** How far back the sweep looks for shifts that started. */
const WATCH_HOURS = 12;
/** A stage older than this when first seen is recorded, not sent. */
export const FRESH_MINUTES = 20;

export const STAGES = ['running_late', 'called_off', 'late', 'no_show', 'arrived', 'covered'];
export const STAGE_LABEL = {
  running_late: 'Running late', called_off: 'Called off', late: 'Late', no_show: 'No-show', arrived: 'Arrived late', covered: 'Covered',
};

/** What somebody with no settings saved hears: no-shows and what follows, by push. */
export const DEFAULT_SETTINGS = { sms_enabled: false, push_enabled: true, on_late: false, on_no_show: true, on_update: true };

const fmtTime = (d) =>
  new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const minutesAfter = (from, to) => Math.max(0, Math.round((new Date(to) - new Date(from)) / MIN));

/* ------------------------------------------------------------- the watch --- */

/** Shifts started in the watch window, with the assigned officer's first clock-in. */
async function startedShifts(now) {
  return db
    .prepare(
      `SELECT sh.id, sh.user_id, sh.post_id, sh.starts_at, sh.ends_at, sh.status,
              u.first_name || ' ' || u.last_name AS officer, u.employee_code, u.phone,
              p.name AS post_name, s.name AS site_name,
              (SELECT MIN(te.clock_in_at) FROM time_entries te
                WHERE te.user_id = sh.user_id
                  AND (te.shift_id = sh.id
                       OR (te.shift_id IS NULL AND te.post_id = sh.post_id
                           AND te.clock_in_at BETWEEN sh.starts_at - interval '30 minutes' AND sh.ends_at))) AS clock_in_at
       FROM shifts sh
       JOIN users u ON u.id = sh.user_id
       JOIN posts p ON p.id = sh.post_id
       JOIN sites s ON s.id = p.site_id
       WHERE sh.user_id IS NOT NULL AND sh.status <> 'cancelled'
         AND sh.starts_at <= ? AND sh.starts_at > ?
       ORDER BY sh.starts_at, sh.id`
    )
    .all(toSql(now), toSql(new Date(now.getTime() - WATCH_HOURS * 3600000)));
}

/** The stages a shift has reached for its assigned officer, with when. */
export function stagesFor({ starts_at, clock_in_at }, now = new Date()) {
  const start = new Date(sqlToIso(starts_at));
  const lateAt = new Date(start.getTime() + RULES.lateGraceMinutes * MIN);
  const noShowAt = new Date(start.getTime() + RULES.noShowMinutes * MIN);
  const inAt = clock_in_at ? new Date(sqlToIso(clock_in_at)) : null;
  const until = inAt || now;
  const out = [];
  if (until > lateAt) out.push({ stage: 'late', at: lateAt, minutes: RULES.lateGraceMinutes });
  if (until > noShowAt) out.push({ stage: 'no_show', at: noShowAt, minutes: RULES.noShowMinutes });
  if (inAt && out.length) out.push({ stage: 'arrived', at: inAt, minutes: minutesAfter(start, inAt) });
  return out;
}

/** Every recorded stage for a set of shifts. */
async function eventsFor(shiftIds) {
  if (!shiftIds.length) return [];
  const rows = await db
    .prepare(
      `SELECT e.shift_id, e.user_id, e.stage, e.occurred_at, e.minutes_late, e.detail,
              u.first_name || ' ' || u.last_name AS officer
       FROM attendance_events e JOIN users u ON u.id = e.user_id
       WHERE e.shift_id IN (${shiftIds.map(() => '?').join(',')})
       ORDER BY e.occurred_at, e.id`
    )
    .all(...shiftIds);
  return rows.map((e) => ({ ...e, occurred_at: sqlToIso(e.occurred_at), detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail }));
}

/** What officers have said about a set of shifts, by shift: { running_late: {..}, call_off: {..} } per officer. */
async function noticesFor(shiftIds) {
  const out = new Map();
  if (!shiftIds.length) return out;
  const rows = await db
    .prepare(
      `SELECT n.*, u.first_name || ' ' || u.last_name AS officer FROM attendance_notices n JOIN users u ON u.id = n.user_id
       WHERE n.shift_id IN (${shiftIds.map(() => '?').join(',')}) ORDER BY n.created_at`
    )
    .all(...shiftIds);
  for (const n of rows) {
    if (!out.has(n.shift_id)) out.set(n.shift_id, []);
    out.get(n.shift_id).push(publicNotice(n));
  }
  return out;
}

const publicNotice = (n) => ({
  kind: n.kind, user_id: n.user_id, officer: n.officer, reason: n.reason, reason_label: n.reason ? CALL_OFF_LABEL[n.reason] : null,
  note: n.note, eta_at: n.eta_at ? sqlToIso(n.eta_at) : null, created_at: sqlToIso(n.created_at),
});

async function insertEvent({ shiftId, userId, stage, at, minutes, detail }) {
  const row = await db
    .prepare(
      `INSERT INTO attendance_events (shift_id, user_id, stage, occurred_at, minutes_late, detail)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT (shift_id, user_id, stage) DO NOTHING
       RETURNING id`
    )
    .get(shiftId, userId, stage, toSql(at), minutes ?? null, detail ? JSON.stringify(detail) : null);
  return row ? Number(row.id) : null;
}

/**
 * Record every stage reached since the last pass, and send the fresh ones.
 * Returns how many stages were new and how many were sent.
 */
export async function sweepAttendance(now = new Date()) {
  const result = { recorded: 0, sent: 0 };
  const shifts = await startedShifts(now);
  if (!shifts.length) return result;
  const fresh = now.getTime() - FRESH_MINUTES * MIN;

  // What is already recorded for these shifts, by shift and officer.
  const seen = new Map();
  for (const e of await eventsFor(shifts.map((sh) => sh.id))) {
    const key = `${e.shift_id}:${e.user_id}`;
    if (!seen.has(key)) seen.set(key, { shiftId: e.shift_id, userId: e.user_id, officer: e.officer, stages: new Set() });
    seen.get(key).stages.add(e.stage);
  }

  const notices = await noticesFor(shifts.map((sh) => sh.id));

  for (const sh of shifts) {
    sh.notice = (notices.get(sh.id) || []).find((n) => n.kind === 'running_late' && n.user_id === sh.user_id) || null;
    const created = [];
    const mine = seen.get(`${sh.id}:${sh.user_id}`)?.stages || new Set();
    // An officer given somebody else's late shift is cover, on the way as
    // fast as they can: their lateness is not counted from the start.
    const covering = [...seen.values()].some((o) => o.shiftId === sh.id && o.userId !== sh.user_id);
    for (const st of covering ? [] : stagesFor(sh, now)) {
      if (mine.has(st.stage)) continue;
      const id = await insertEvent({ shiftId: sh.id, userId: sh.user_id, stage: st.stage, at: st.at, minutes: st.minutes });
      if (id) created.push({ id, ...st, userId: sh.user_id });
    }

    // Somebody else's late or no-show on this shift, now it is given to this
    // officer: covered, unless the first officer did turn up.
    for (const o of seen.values()) {
      if (o.shiftId !== sh.id || o.userId === sh.user_id) continue;
      if (o.stages.has('arrived') || o.stages.has('covered')) continue;
      const id = await insertEvent({
        shiftId: sh.id, userId: o.userId, stage: 'covered', at: now,
        detail: { by_user_id: sh.user_id, by: sh.officer, was: o.officer },
      });
      if (id) created.push({ id, stage: 'covered', at: now, userId: o.userId, by: sh.officer, was: o.officer });
    }

    result.recorded += created.length;
    // The latest fresh stage only; the older ones are history.
    const send = created.filter((c) => c.at.getTime() >= fresh).pop();
    // Late, but they said so and are not past the time they gave: nobody
    // needs telling again. A no-show is always sent.
    const expected = send?.stage === 'late' && sh.notice && new Date(sh.notice.eta_at) > now;
    if (send && !expected) {
      await db.prepare(`UPDATE attendance_events SET notified = true WHERE id = ?`).run(send.id);
      result.sent += await announce(sh, send);
    }
  }
  result.sent += await coverCallOffs(now);
  return result;
}

/**
 * A called-off shift given to somebody before it started: covered. (Once it
 * has started, the pass above finds it like any other covered shift.)
 */
async function coverCallOffs(now) {
  const rows = await db
    .prepare(
      `SELECT sh.id, sh.user_id, sh.starts_at, sh.post_id, p.name AS post_name, s.name AS site_name,
              u.first_name || ' ' || u.last_name AS officer, u.phone,
              e.user_id AS was_id, w.first_name || ' ' || w.last_name AS was
       FROM attendance_events e
       JOIN shifts sh ON sh.id = e.shift_id
       JOIN users u ON u.id = sh.user_id
       JOIN users w ON w.id = e.user_id
       JOIN posts p ON p.id = sh.post_id JOIN sites s ON s.id = p.site_id
       WHERE e.stage = 'called_off' AND sh.user_id IS NOT NULL AND sh.user_id <> e.user_id
         AND sh.status <> 'cancelled' AND sh.ends_at > ?
         AND NOT EXISTS (SELECT 1 FROM attendance_events c WHERE c.shift_id = e.shift_id AND c.user_id = e.user_id AND c.stage = 'covered')`
    )
    .all(toSql(now));
  let sent = 0;
  for (const r of rows) {
    const id = await insertEvent({ shiftId: r.id, userId: r.was_id, stage: 'covered', at: now, detail: { by_user_id: r.user_id, by: r.officer, was: r.was } });
    if (!id) continue;
    await db.prepare(`UPDATE attendance_events SET notified = true WHERE id = ?`).run(id);
    sent += await announce(r, { id, stage: 'covered', at: now, userId: r.was_id, by: r.officer, was: r.was });
  }
  return sent;
}

/* ------------------------------------------------- what the officer says --- */

/**
 * The shift an officer can say something about: their next one starting in
 * the next RULES.headsUpHours, or one already started that they have not
 * clocked in to and that has not ended. With what they have said about it.
 */
export async function headsUpFor(userId, now = new Date()) {
  const sh = await db
    .prepare(
      `SELECT sh.id, sh.user_id, sh.post_id, sh.starts_at, sh.ends_at, sh.status,
              u.first_name || ' ' || u.last_name AS officer, u.phone,
              p.name AS post_name, s.name AS site_name
       FROM shifts sh
       JOIN users u ON u.id = sh.user_id
       JOIN posts p ON p.id = sh.post_id
       JOIN sites s ON s.id = p.site_id
       WHERE sh.user_id = ? AND sh.status IN ('scheduled','missed')
         AND sh.starts_at <= ? AND sh.ends_at > ?
         AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.shift_id = sh.id AND te.user_id = sh.user_id)
       ORDER BY sh.starts_at LIMIT 1`
    )
    .get(userId, toSql(new Date(now.getTime() + RULES.headsUpHours * 3600000)), toSql(now));
  if (!sh) return { shift: null, notice: null };
  const notice = (await noticesFor([sh.id])).get(sh.id)?.find((n) => n.user_id === userId && n.kind === 'running_late') || null;
  const start = new Date(sqlToIso(sh.starts_at));
  return {
    shift: {
      id: sh.id, post_name: sh.post_name, site_name: sh.site_name,
      starts_at: start.toISOString(), ends_at: sqlToIso(sh.ends_at),
      started: start <= now, minutes_to_start: Math.round((start - now) / MIN),
    },
    notice,
  };
}

/** The officer's own shift, as headsUpFor would offer it, or a refusal saying why not. */
async function ownShift(userId, shiftId, now) {
  const { shift } = await headsUpFor(userId, now);
  if (!shift || shift.id !== shiftId) {
    throw new HttpError(409, `You can only do this for your next shift, up to ${RULES.headsUpHours} hours before it starts, until you clock in.`);
  }
  return db
    .prepare(
      `SELECT sh.*, u.first_name || ' ' || u.last_name AS officer, u.phone, p.name AS post_name, s.name AS site_name
       FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN posts p ON p.id = sh.post_id JOIN sites s ON s.id = p.site_id
       WHERE sh.id = ?`
    )
    .get(shiftId);
}

/**
 * "I'm running late": when they expect to arrive. Once per shift; if it
 * changes again, they call. Supervisors who asked for late starts are told
 * now, and the late text at the grace period is not sent while they are
 * within the time they gave.
 */
export async function reportRunningLate({ userId, shiftId, etaMinutes, note, now = new Date() }) {
  const sh = await ownShift(userId, shiftId, now);
  const start = new Date(sqlToIso(sh.starts_at));
  const eta = new Date(Math.ceil((now.getTime() + etaMinutes * MIN) / MIN) * MIN);
  if (eta <= start) throw new HttpError(422, `That gets you there before ${fmtTime(start)}: you are not late.`);
  if (eta >= new Date(sqlToIso(sh.ends_at))) throw new HttpError(422, 'That is after the shift ends. If you cannot make it, call off instead.');
  const row = await db
    .prepare(
      `INSERT INTO attendance_notices (shift_id, user_id, kind, eta_at, note) VALUES (?,?, 'running_late', ?, ?)
       ON CONFLICT (shift_id, user_id, kind) DO NOTHING RETURNING id`
    )
    .get(sh.id, userId, toSql(eta), note || null);
  if (!row) throw new HttpError(409, 'You have already said you are running late for this shift. If it changes again, call your supervisor.');
  const minutes = minutesAfter(start, eta);
  const id = await insertEvent({ shiftId: sh.id, userId, stage: 'running_late', at: now, minutes, detail: { eta_at: eta.toISOString(), note: note || null } });
  await db.prepare(`UPDATE attendance_events SET notified = true WHERE id = ?`).run(id);
  const texts = await announce(sh, {
    id, stage: 'running_late', at: now, userId, eta, note, beyondNoShow: minutes > RULES.noShowMinutes,
  });
  return { notice: { kind: 'running_late', eta_at: eta.toISOString(), note: note || null, minutes_late: minutes }, texts };
}

/**
 * "I can't make it": the shift is taken off them and opened for anyone to
 * claim, any request of theirs on it is withdrawn, and every supervisor who
 * hears of no-shows or late starts is told now, while there is time to cover.
 */
export async function callOff({ userId, shiftId, reason, note, now = new Date() }) {
  if (!CALL_OFF_REASONS.includes(reason)) throw new HttpError(422, 'Choose why you cannot come.');
  if (reason === 'other' && !(note && note.trim().length >= 5)) throw new HttpError(422, 'Say briefly why you cannot come.');
  const sh = await ownShift(userId, shiftId, now);
  let id = null;
  await db.transaction(async () => {
    const row = await db
      .prepare(
        `INSERT INTO attendance_notices (shift_id, user_id, kind, reason, note) VALUES (?,?, 'call_off', ?, ?)
         ON CONFLICT (shift_id, user_id, kind) DO NOTHING RETURNING id`
      )
      .get(sh.id, userId, reason, note || null);
    if (!row) throw new HttpError(409, 'You have already called off this shift.');
    await db
      .prepare(`UPDATE shifts SET user_id = NULL, is_open = true, status = 'scheduled' WHERE id = ?`)
      .run(sh.id);
    await db
      .prepare(
        `UPDATE shift_requests SET status = 'cancelled', decided_at = now(), decision_note = 'Called off by the officer.'
         WHERE shift_id = ? AND requested_by = ? AND status IN ('pending','accepted')`
      )
      .run(sh.id, userId);
    id = await insertEvent({ shiftId: sh.id, userId, stage: 'called_off', at: now, detail: { reason, note: note || null } });
    await db.prepare(`UPDATE attendance_events SET notified = true WHERE id = ?`).run(id);
  })();
  const texts = await announce(sh, { id, stage: 'called_off', at: now, userId, reason, note });
  return { notice: { kind: 'call_off', reason, reason_label: CALL_OFF_LABEL[reason], note: note || null }, texts };
}

/* ---------------------------------------------------------- the message --- */

function messageFor(sh, ev) {
  const start = new Date(sqlToIso(sh.starts_at));
  const where = `${sh.post_name}, ${sh.site_name}`;
  const link = publicUrl() ? ` ${publicUrl()}/admin/attendance?shift=${sh.id}` : '';
  const phone = sh.phone ? ` Call ${sh.phone}.` : '';
  const said = sh.notice?.eta_at ? ` They said they would be there by ${fmtTime(sh.notice.eta_at)}.` : '';
  switch (ev.stage) {
    case 'running_late':
      return {
        title: `${sh.officer} is running late`,
        body: `${where}, ${fmtTime(start)} start: expects to arrive ${fmtTime(ev.eta)}.${ev.note ? ` "${ev.note}"` : ''}`,
        sms: `USC heads-up: ${sh.officer} is running late for ${where} (${fmtTime(start)} start) and expects to arrive by ${fmtTime(ev.eta)}.${ev.note ? ` "${ev.note}"` : ''}${phone}`,
      };
    case 'called_off':
      return {
        title: `Call-off: ${sh.officer}`,
        body: `Can't work the ${fmtTime(start)} shift at ${where} (${CALL_OFF_LABEL[ev.reason] || ev.reason}). It is open: find cover.`,
        sms: `USC CALL-OFF: ${sh.officer} can't work the ${fmtTime(start)} shift at ${where} (${(CALL_OFF_LABEL[ev.reason] || ev.reason).toLowerCase()}). It is open: find cover.${link}`,
      };
    case 'late':
      return {
        title: `${sh.officer} is late`,
        body: `${sh.officer} has not clocked in at ${where}. Shift started ${fmtTime(start)}.`,
        sms: `USC late: ${sh.officer} has not clocked in at ${where}. Shift started ${fmtTime(start)}.${phone}${link}`,
      };
    case 'no_show':
      return {
        title: `No-show: ${sh.officer}`,
        body: `No clock-in at ${where}, ${RULES.noShowMinutes} min after the ${fmtTime(start)} start. Find cover.`,
        sms: `USC NO-SHOW: ${sh.officer} has not clocked in at ${where}, ${RULES.noShowMinutes} min after the ${fmtTime(start)} start.${said} Find cover.${phone}${link}`,
      };
    case 'arrived':
      return {
        title: `${sh.officer} is on post`,
        body: `Clocked in at ${where} at ${fmtTime(ev.at)}, ${ev.minutes} min late.`,
        sms: `USC update: ${sh.officer} clocked in at ${where} at ${fmtTime(ev.at)}, ${ev.minutes} min late.`,
      };
    default:
      return {
        title: `${sh.post_name} is covered`,
        body: `${ev.by} is taking ${ev.was}'s ${fmtTime(start)} shift.`,
        sms: `USC update: ${where} is covered. ${ev.by} is taking ${ev.was}'s ${fmtTime(start)} shift.`,
      };
  }
}

/** Everyone who asked to hear about this stage of this shift. */
async function recipientsFor(shiftId, officerId, stage, ev = {}) {
  const people = await db
    .prepare(
      `SELECT u.id, u.first_name || ' ' || u.last_name AS name,
              a.user_id IS NOT NULL AS saved, a.sms_enabled, a.push_enabled, a.on_late, a.on_no_show, a.on_update,
              a.sms_phone, a.sms_verified_at
       FROM users u LEFT JOIN alert_subscriptions a ON a.user_id = u.id
       WHERE u.role IN (?, ?) AND u.status = 'active'`
    )
    .all(ROLES.SUPERVISOR, ROLES.ADMIN);
  // A call-off is a no-show with warning, for whoever hears of updates.
  const hadNoShow = stage === 'arrived' || stage === 'covered'
    ? Boolean(await db.prepare(`SELECT 1 FROM attendance_events WHERE shift_id = ? AND user_id = ? AND stage IN ('no_show','called_off')`).get(shiftId, officerId))
    : false;
  return people
    .map((p) => (p.saved ? p : { ...p, ...DEFAULT_SETTINGS }))
    .filter((p) => {
      if (stage === 'late') return p.on_late;
      if (stage === 'no_show') return p.on_no_show;
      if (stage === 'called_off') return p.on_no_show || p.on_late;
      // Running late is a late start told in advance; one that will be past the
      // no-show mark is news to those who only want no-shows too.
      if (stage === 'running_late') return p.on_late || (p.on_no_show && ev.beyondNoShow);
      // An update is only news to somebody who was told of the problem.
      return p.on_update && (p.on_late || (p.on_no_show && hadNoShow));
    });
}

async function announce(sh, ev, { quiet = false } = {}) {
  const officerId = ev.userId;
  const msg = messageFor(sh, ev);
  const people = await recipientsFor(sh.id, officerId, ev.stage, ev);
  const pushTo = people.filter((p) => p.push_enabled).map((p) => p.id);
  if (pushTo.length && !quiet) {
    pushAsync(pushTo, {
      title: msg.title,
      body: msg.body,
      data: { type: 'attendance', shiftId: sh.id, stage: ev.stage },
      priority: ev.stage === 'no_show' || ev.stage === 'called_off' ? 'high' : 'default',
    });
  }
  let texts = 0;
  for (const p of people.filter((x) => x.sms_enabled && x.sms_phone && x.sms_verified_at)) {
    await sendSms({ to: p.sms_phone, userId: p.id, body: msg.sms, kind: `attendance_${ev.stage}`, entity: 'attendance_event', entityId: ev.id });
    texts += 1;
  }
  return texts;
}

/**
 * For the demo seed: send every stage not yet sent since `since`, in order,
 * as a sweep running every minute would have, with each text stamped at the
 * time of its stage. No pushes: nobody's phone should buzz for the past.
 */
export async function replayHistory({ since }) {
  const rows = await db
    .prepare(
      `SELECT e.id AS event_id, e.shift_id, e.user_id, e.stage, e.occurred_at, e.minutes_late, e.detail,
              sh.starts_at, u.first_name || ' ' || u.last_name AS officer, u.phone, p.name AS post_name, s.name AS site_name
       FROM attendance_events e
       JOIN shifts sh ON sh.id = e.shift_id JOIN users u ON u.id = e.user_id
       JOIN posts p ON p.id = sh.post_id JOIN sites s ON s.id = p.site_id
       WHERE e.notified = false AND e.occurred_at >= ?
       ORDER BY e.occurred_at, e.id`
    )
    .all(toSql(since));
  let texts = 0;
  for (const e of rows) {
    const detail = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail || {};
    const at = new Date(sqlToIso(e.occurred_at));
    await db.prepare(`UPDATE attendance_events SET notified = true WHERE id = ?`).run(e.event_id);
    texts += await announce({ ...e, id: e.shift_id }, {
      id: e.event_id, stage: e.stage, at, minutes: e.minutes_late, userId: e.user_id, by: detail.by, was: detail.was,
      eta: detail.eta_at, note: detail.note, reason: detail.reason, beyondNoShow: e.minutes_late > RULES.noShowMinutes,
    }, { quiet: true });
    await db
      .prepare(`UPDATE sms_messages SET created_at = ? WHERE entity = 'attendance_event' AND entity_id = ?`)
      .run(toSql(at), e.event_id);
  }
  return texts;
}

/* ------------------------------------------------------------- the board --- */

const eventLine = (e) => {
  const d = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail || {};
  if (e.stage === 'running_late') return `${e.officer} is running late for ${e.post_name}: expects to arrive ${d.eta_at ? fmtTime(d.eta_at) : 'soon'}`;
  if (e.stage === 'called_off') return `${e.officer} called off ${e.post_name} (${(CALL_OFF_LABEL[d.reason] || 'no reason').toLowerCase()}): needs cover`;
  if (e.stage === 'late') return `${e.officer} late at ${e.post_name}: no clock-in ${e.minutes_late} min after the start`;
  if (e.stage === 'no_show') return `${e.officer} is a no-show at ${e.post_name}`;
  if (e.stage === 'arrived') return `${e.officer} clocked in at ${e.post_name}, ${e.minutes_late} min late`;
  return `${e.post_name} covered: ${d.by || 'another officer'} is taking ${e.officer}'s shift`;
};

/**
 * Recent stages, newest first; `since` gives only those after an id. Only the
 * last day's: older ones are the officers' records, not news.
 */
export async function attendanceEvents({ since = 0, limit = 40, now = new Date() } = {}) {
  const rows = await db
    .prepare(
      `SELECT e.id, e.shift_id, e.user_id, e.stage, e.occurred_at, e.minutes_late, e.detail, e.notified, e.created_at,
              u.first_name || ' ' || u.last_name AS officer, p.name AS post_name, s.name AS site_name,
              (SELECT COUNT(*) FROM sms_messages m WHERE m.entity = 'attendance_event' AND m.entity_id = e.id) AS texts
       FROM attendance_events e
       JOIN users u ON u.id = e.user_id
       JOIN shifts sh ON sh.id = e.shift_id
       JOIN posts p ON p.id = sh.post_id
       JOIN sites s ON s.id = p.site_id
       WHERE e.id > ? AND e.occurred_at > ?
       ORDER BY e.id DESC LIMIT ?`
    )
    .all(since, toSql(new Date(now.getTime() - 2 * WATCH_HOURS * 3600000)), limit);
  return rows.map((e) => ({
    id: Number(e.id), shift_id: e.shift_id, user_id: e.user_id, stage: e.stage, label: STAGE_LABEL[e.stage],
    occurred_at: sqlToIso(e.occurred_at), created_at: sqlToIso(e.created_at), minutes_late: e.minutes_late,
    officer: e.officer, post_name: e.post_name, site_name: e.site_name, notified: Boolean(e.notified), texts: Number(e.texts),
    line: eventLine(e),
  }));
}

/**
 * Shifts for the board: every assigned shift started in the last twelve
 * hours, and any shift in the twelve hours either side that an officer has
 * said something about - running late, or called off (left with nobody on it
 * until it is covered).
 */
async function boardShifts(now) {
  const from = toSql(new Date(now.getTime() - WATCH_HOURS * 3600000));
  return db
    .prepare(
      `SELECT sh.id, sh.user_id, sh.post_id, sh.starts_at, sh.ends_at, sh.status,
              u.first_name || ' ' || u.last_name AS officer, u.employee_code, u.phone,
              p.name AS post_name, s.name AS site_name,
              (SELECT MIN(te.clock_in_at) FROM time_entries te
                WHERE te.user_id = sh.user_id
                  AND (te.shift_id = sh.id
                       OR (te.shift_id IS NULL AND te.post_id = sh.post_id
                           AND te.clock_in_at BETWEEN sh.starts_at - interval '30 minutes' AND sh.ends_at))) AS clock_in_at
       FROM shifts sh
       LEFT JOIN users u ON u.id = sh.user_id
       JOIN posts p ON p.id = sh.post_id
       JOIN sites s ON s.id = p.site_id
       WHERE sh.status <> 'cancelled' AND sh.starts_at > ?
         AND ((sh.user_id IS NOT NULL AND sh.starts_at <= ?)
              OR (sh.starts_at <= ? AND EXISTS (SELECT 1 FROM attendance_notices n WHERE n.shift_id = sh.id)))
       ORDER BY sh.starts_at, sh.id`
    )
    .all(from, toSql(now), toSql(new Date(now.getTime() + WATCH_HOURS * 3600000)));
}

/**
 * The board: who is late, missing or called off right now, who has said they
 * are running late, who turned up late or was covered today, and the latest
 * updates.
 */
export async function attendanceBoard({ now = new Date() } = {}) {
  const shifts = await boardShifts(now);
  const ids = shifts.map((s) => s.id);
  const byShift = new Map();
  for (const e of await eventsFor(ids)) {
    if (!byShift.has(e.shift_id)) byShift.set(e.shift_id, []);
    byShift.get(e.shift_id).push(e);
  }
  const notices = await noticesFor(ids);

  const open = [];
  const resolved = [];
  for (const sh of shifts) {
    const timeline = byShift.get(sh.id) || [];
    const said = notices.get(sh.id) || [];
    const callOff = said.find((n) => n.kind === 'call_off') || null;
    const notice = said.find((n) => n.kind === 'running_late' && n.user_id === sh.user_id) || null;
    const start = sqlToIso(sh.starts_at);
    const started = new Date(start) <= now;
    const ended = new Date(sqlToIso(sh.ends_at)) <= now;
    // Given to this officer after somebody else was late, missing or called off.
    const cover = Boolean(sh.user_id) && timeline.some((e) => e.user_id !== sh.user_id);
    const reached = cover || !sh.user_id ? [] : stagesFor(sh, now);
    const coveredFrom = timeline.find((e) => e.stage === 'covered' && e.detail?.by_user_id === sh.user_id);
    const base = {
      shift_id: sh.id, user_id: sh.user_id, officer: sh.officer || callOff?.officer || null, employee_code: sh.employee_code,
      phone: sh.phone, post_id: sh.post_id, post_name: sh.post_name, site_name: sh.site_name, starts_at: start,
      ends_at: sqlToIso(sh.ends_at), started,
      timeline: timeline.map((e) => ({
        stage: e.stage, label: STAGE_LABEL[e.stage], officer: e.officer, at: e.occurred_at, minutes_late: e.minutes_late, detail: e.detail,
      })),
      covered_from: cover ? coveredFrom?.detail?.was || timeline.find((e) => e.user_id !== sh.user_id)?.officer : null,
      notice,
      call_off: callOff,
    };

    // Called off, and nobody on it yet.
    if (!sh.user_id) {
      if (!callOff) continue;
      if (ended) resolved.push({ ...base, state: 'missed', minutes_late: null });
      else open.push({ ...base, state: 'called_off', minutes_late: started ? minutesAfter(start, now) : null });
      continue;
    }
    if (sh.clock_in_at) {
      if (!reached.length && !cover) continue;
      const inAt = sqlToIso(sh.clock_in_at);
      resolved.push({ ...base, state: cover ? 'covered' : 'arrived', clock_in_at: inAt, minutes_late: minutesAfter(start, inAt) });
      continue;
    }
    if (ended) {
      if (reached.length || cover) resolved.push({ ...base, state: 'missed', minutes_late: null });
      continue;
    }
    if (cover) {
      open.push({ ...base, state: 'covering', minutes_late: started ? minutesAfter(start, now) : null });
      continue;
    }
    if (reached.length) {
      open.push({ ...base, state: reached[reached.length - 1].stage, minutes_late: minutesAfter(start, now) });
      continue;
    }
    // Not late yet (not started, or within the grace), but they have said they will be.
    if (notice) open.push({ ...base, state: 'running_late', minutes_late: started ? minutesAfter(start, now) : null });
  }
  const rank = { no_show: 0, called_off: 1, late: 2, running_late: 3, covering: 4 };
  open.sort((a, b) => rank[a.state] - rank[b.state] || (b.minutes_late ?? -1) - (a.minutes_late ?? -1) || new Date(a.starts_at) - new Date(b.starts_at));
  resolved.sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
  const count = (list, state) => list.filter((o) => o.state === state).length;
  return {
    now: now.toISOString(),
    rules: { lateGraceMinutes: RULES.lateGraceMinutes, noShowMinutes: RULES.noShowMinutes, headsUpHours: RULES.headsUpHours },
    open,
    resolved,
    counts: {
      late: count(open, 'late'),
      no_show: count(open, 'no_show'),
      called_off: count(open, 'called_off'),
      running_late: count(open, 'running_late'),
      covering: count(open, 'covering'),
      arrived: count(resolved, 'arrived'),
      covered: count(resolved, 'covered'),
    },
  };
}

/* ------------------------------------------------------------ the record --- */

const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v || null);

/**
 * Shifts officers lost in a period: called off, or a no-show given to
 * somebody else. Either takes the shift off their roster, so the shifts table
 * alone would show them never due at all. One row per shift, with who covered
 * it and anything they said first. For one officer, or everybody.
 */
export async function lostShifts({ from, to, userId = null }) {
  const rows = await db
    .prepare(
      `SELECT e.user_id, e.shift_id, e.stage, e.occurred_at, sh.starts_at, sh.ends_at,
              p.name AS post_name, s.name AS site_name,
              n.reason, n.note, r.eta_at, r.note AS late_note,
              (SELECT c.detail FROM attendance_events c
                WHERE c.shift_id = e.shift_id AND c.user_id = e.user_id AND c.stage = 'covered' LIMIT 1) AS covered
       FROM attendance_events e
       JOIN shifts sh ON sh.id = e.shift_id
       JOIN posts p ON p.id = sh.post_id
       JOIN sites s ON s.id = p.site_id
       LEFT JOIN attendance_notices n ON n.shift_id = e.shift_id AND n.user_id = e.user_id AND n.kind = 'call_off'
       LEFT JOIN attendance_notices r ON r.shift_id = e.shift_id AND r.user_id = e.user_id AND r.kind = 'running_late'
       WHERE e.stage IN ('called_off', 'no_show') AND sh.status <> 'cancelled'
         AND sh.user_id IS DISTINCT FROM e.user_id
         AND e.occurred_at >= ? AND e.occurred_at < ?
         ${userId ? 'AND e.user_id = ?' : ''}
         AND NOT EXISTS (SELECT 1 FROM attendance_events a
                         WHERE a.shift_id = e.shift_id AND a.user_id = e.user_id AND a.stage = 'arrived')
       ORDER BY e.occurred_at DESC, e.id DESC`
    )
    .all(toSql(from), toSql(to), ...(userId ? [userId] : []));
  return rows.map((r) => ({ ...r, covered: json(r.covered) }));
}

/** Officers' own shifts started in a period, with the first clock-in to each and anything said beforehand. */
async function ownShifts({ from, to, userId = null }) {
  return db
    .prepare(
      `SELECT sh.id AS shift_id, sh.user_id, sh.starts_at, sh.ends_at, sh.status, p.name AS post_name, s.name AS site_name,
              te.clock_in_at, r.eta_at, r.note AS late_note,
              EXISTS (SELECT 1 FROM attendance_events ns
                      WHERE ns.shift_id = sh.id AND ns.user_id = sh.user_id AND ns.stage = 'no_show') AS no_show_seen
       FROM shifts sh
       JOIN posts p ON p.id = sh.post_id
       JOIN sites s ON s.id = p.site_id
       LEFT JOIN LATERAL (
         SELECT clock_in_at FROM time_entries x WHERE x.shift_id = sh.id ORDER BY x.clock_in_at LIMIT 1
       ) te ON true
       LEFT JOIN attendance_notices r ON r.shift_id = sh.id AND r.user_id = sh.user_id AND r.kind = 'running_late'
       WHERE sh.user_id IS NOT NULL ${userId ? 'AND sh.user_id = ?' : ''}
         AND sh.status <> 'cancelled' AND sh.starts_at >= ? AND sh.starts_at < ?
       ORDER BY sh.starts_at DESC`
    )
    .all(...(userId ? [userId] : []), toSql(from), toSql(to));
}

/**
 * Officers' attendance from their own shifts and the shifts they lost: per
 * officer, the counts and an item for every lapse - late past the grace, a
 * no-show, a call-off - each with when it happened and the points it scores.
 */
function tally(own, lost) {
  const grace = RULES.lateGraceMinutes;
  const people = new Map();
  const of = (id) => {
    if (!people.has(id)) {
      people.set(id, {
        t: { worked: 0, onTime: 0, lateMinutes: 0, noShows: 0, headsUps: 0, keptWord: 0, calledOff: 0, shortNotice: 0 },
        items: [], byReason: {},
      });
    }
    return people.get(id);
  };
  const shiftOf = (r) => ({
    shift_id: r.shift_id, post_name: r.post_name, site_name: r.site_name,
    starts_at: sqlToIso(r.starts_at), ends_at: sqlToIso(r.ends_at),
  });
  const saidLate = (r) => (r.eta_at ? { eta_at: sqlToIso(r.eta_at), note: r.late_note || null } : null);
  const add = (p, item) => p.items.push({ ...item, points: attendancePointsFor(item) });

  for (const r of own) {
    const p = of(r.user_id);
    const t = p.t;
    const start = new Date(sqlToIso(r.starts_at));
    const notice = saidLate(r);
    if (notice) t.headsUps += 1;
    if (r.clock_in_at) {
      t.worked += 1;
      const inAt = new Date(sqlToIso(r.clock_in_at));
      const kept = notice ? inAt <= new Date(notice.eta_at) : null;
      if (kept) t.keptWord += 1;
      if (inAt.getTime() <= start.getTime() + grace * MIN) {
        t.onTime += 1;
        continue;
      }
      const late = minutesAfter(start, inAt);
      t.lateMinutes += late;
      add(p, { kind: 'late', ...shiftOf(r), at: inAt.toISOString(), clock_in_at: inAt.toISOString(), minutes_late: late, notice, kept_word: kept });
    } else if (r.status === 'missed' || r.status === 'no_show' || r.no_show_seen) {
      t.noShows += 1;
      add(p, { kind: 'no_show', ...shiftOf(r), at: start.toISOString(), notice, covered_by: null });
    }
  }

  for (const l of lost) {
    const p = of(l.user_id);
    const t = p.t;
    const notice = saidLate(l);
    if (notice) t.headsUps += 1;
    if (l.stage === 'no_show') {
      t.noShows += 1;
      add(p, { kind: 'no_show', ...shiftOf(l), at: sqlToIso(l.starts_at), notice, covered_by: l.covered?.by || null });
      continue;
    }
    const hours = Math.max(0, (new Date(sqlToIso(l.starts_at)) - new Date(sqlToIso(l.occurred_at))) / 3600000);
    const short = hours < RULES.shortNoticeHours;
    t.calledOff += 1;
    if (short) t.shortNotice += 1;
    if (l.reason) p.byReason[l.reason] = (p.byReason[l.reason] || 0) + 1;
    add(p, {
      // Rounded down, so notice just short of the line never reads as on it.
      kind: 'called_off', ...shiftOf(l), at: sqlToIso(l.occurred_at), called_off_at: sqlToIso(l.occurred_at),
      notice_hours: Math.floor(hours * 10) / 10, short_notice: short,
      reason: l.reason, reason_label: l.reason ? CALL_OFF_LABEL[l.reason] : null, note: l.note || null,
      covered_by: l.covered?.by || null,
    });
  }
  for (const p of people.values()) p.items.sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
  return people;
}

/**
 * Attendance points over the last ATTENDANCE_POINTS.windowDays, for one
 * officer or everybody: the total, the lapses that score, and whether a
 * supervisor has dealt with it - an attendance coaching or warning recorded
 * since the latest of them. Over the threshold and not dealt with is what
 * the alerts inbox flags.
 */
export async function attendancePoints({ now = new Date(), userId = null } = {}) {
  const from = new Date(now.getTime() - ATTENDANCE_POINTS.windowDays * 86400000);
  const [own, lost] = await Promise.all([ownShifts({ from, to: now, userId }), lostShifts({ from, to: now, userId })]);
  const reviews = new Map(
    (await db
      .prepare(
        `SELECT DISTINCT ON (user_id) id, user_id, level, created_at FROM conduct_records
         WHERE category = 'attendance' AND status <> 'rescinded' AND created_at >= ? ${userId ? 'AND user_id = ?' : ''}
         ORDER BY user_id, created_at DESC`
      )
      .all(toSql(from), ...(userId ? [userId] : []))).map((r) => [r.user_id, r])
  );
  const out = new Map();
  for (const [id, p] of tally(own, lost)) {
    const scoring = p.items.filter((i) => i.points > 0);
    const points = scoring.reduce((a, i) => a + i.points, 0);
    const latest = scoring.reduce((a, i) => (!a || new Date(i.at) > new Date(a) ? i.at : a), null);
    const review = reviews.get(id);
    const reviewed = review && latest && new Date(sqlToIso(review.created_at)) >= new Date(latest)
      ? { id: review.id, level: review.level, level_label: CONDUCT_LEVEL_LABEL[review.level], created_at: sqlToIso(review.created_at) }
      : null;
    out.set(id, {
      points, threshold: ATTENDANCE_POINTS.threshold, windowDays: ATTENDANCE_POINTS.windowDays,
      over: points >= ATTENDANCE_POINTS.threshold, latest_at: latest, reviewed,
      needs_review: points >= ATTENDANCE_POINTS.threshold && !reviewed,
      items: scoring.map((i) => ({ kind: i.kind, shift_id: i.shift_id, post_name: i.post_name, starts_at: i.starts_at, at: i.at, points: i.points })),
    });
  }
  return out;
}

const noPoints = () => ({
  points: 0, threshold: ATTENDANCE_POINTS.threshold, windowDays: ATTENDANCE_POINTS.windowDays,
  over: false, latest_at: null, reviewed: null, needs_review: false, items: [],
});

/**
 * One officer's attendance over a period, for their employee record and for
 * their own profile: shifts due and worked, on time or how late, no-shows,
 * call-offs (and how much notice they gave), and the times they said they
 * were running late - and whether they got there by the time they said.
 * The same counts the scorecard scores, with their attendance points.
 */
export async function attendanceRecord(userId, { days = 90, now = new Date() } = {}) {
  const from = new Date(now.getTime() - days * 86400000);
  const [own, lost, standing] = await Promise.all([
    ownShifts({ from, to: now, userId }),
    lostShifts({ from, to: now, userId }),
    attendancePoints({ now, userId }),
  ]);
  const p = tally(own, lost).get(userId) || { t: { worked: 0, onTime: 0, lateMinutes: 0, noShows: 0, headsUps: 0, keptWord: 0, calledOff: 0, shortNotice: 0 }, items: [], byReason: {} };
  const { t } = p;
  const late = t.worked - t.onTime;
  return {
    days,
    from: from.toISOString(),
    to: now.toISOString(),
    rules: { lateGraceMinutes: RULES.lateGraceMinutes, shortNoticeHours: RULES.shortNoticeHours, points: ATTENDANCE_POINTS },
    summary: {
      due: t.worked + t.noShows + t.calledOff,
      worked: t.worked,
      onTime: t.onTime,
      onTimePct: t.worked ? Math.round((t.onTime / t.worked) * 1000) / 10 : null,
      late,
      avgLateMin: late ? Math.round(t.lateMinutes / late) : 0,
      noShows: t.noShows,
      calledOff: t.calledOff,
      shortNotice: t.shortNotice,
      headsUps: t.headsUps,
      keptWord: t.keptWord,
    },
    standing: standing.get(userId) || noPoints(),
    byReason: CALL_OFF_REASONS.filter((r) => p.byReason[r]).map((r) => ({ reason: r, label: CALL_OFF_LABEL[r], count: p.byReason[r] })),
    items: p.items.slice(0, 60),
  };
}

/* ----------------------------------------------------------- the texts --- */

export async function recentTexts({ limit = 20 } = {}) {
  const rows = await db
    .prepare(
      `SELECT m.id, m.to_phone, m.to_user_id, m.body, m.kind, m.status, m.error, m.created_at, m.sent_at,
              u.first_name || ' ' || u.last_name AS to_name
       FROM sms_messages m LEFT JOIN users u ON u.id = m.to_user_id
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(limit);
  return rows.map((m) => ({
    id: Number(m.id), to: maskPhone(m.to_phone), to_name: m.to_name, body: m.body, kind: m.kind, status: m.status,
    error: m.error, created_at: sqlToIso(m.created_at), sent_at: m.sent_at ? sqlToIso(m.sent_at) : null,
  }));
}

/** One person's settings, as the settings card shows them. */
export async function settingsFor(userId) {
  const row = await db.prepare(`SELECT * FROM alert_subscriptions WHERE user_id = ?`).get(userId);
  const s = row || { ...DEFAULT_SETTINGS };
  return {
    saved: Boolean(row),
    sms_enabled: Boolean(s.sms_enabled),
    push_enabled: Boolean(s.push_enabled),
    on_late: Boolean(s.on_late),
    on_no_show: Boolean(s.on_no_show),
    on_update: Boolean(s.on_update),
    phone: s.sms_phone ? displayPhone(s.sms_phone) : null,
    phone_verified: Boolean(s.sms_phone && s.sms_verified_at),
    pending_phone: s.pending_phone && s.pending_expires_at && new Date(sqlToIso(s.pending_expires_at)) > new Date() ? displayPhone(s.pending_phone) : null,
    provider: { configured: smsConfigured, kind: smsKind },
  };
}
