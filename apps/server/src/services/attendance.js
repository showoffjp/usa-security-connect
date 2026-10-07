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
 * A new stage goes to every supervisor and administrator who asked to hear
 * about it - a text to their verified phone, a push to the app, or both. Only
 * the latest fresh stage is sent, so a sweep that has not run for half an
 * hour sends "no-show", not "late" and then "no-show". The unique key on
 * (shift, officer, stage) is what keeps two sweeps from sending twice.
 */

import { db } from '../lib/db.js';
import { sqlToIso } from '../lib/http.js';
import { RULES, ROLES } from '../shared.js';
import { toSql } from './compliance.js';
import { pushAsync } from './push.js';
import { sendSms, displayPhone, maskPhone, smsConfigured, smsKind } from './sms.js';
import { publicUrl } from './email.js';

const MIN = 60000;
/** How far back the sweep looks for shifts that started. */
const WATCH_HOURS = 12;
/** A stage older than this when first seen is recorded, not sent. */
export const FRESH_MINUTES = 20;

export const STAGES = ['late', 'no_show', 'arrived', 'covered'];
export const STAGE_LABEL = { late: 'Late', no_show: 'No-show', arrived: 'Arrived late', covered: 'Covered' };

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

  for (const sh of shifts) {
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
    if (send) {
      await db.prepare(`UPDATE attendance_events SET notified = true WHERE id = ?`).run(send.id);
      result.sent += await announce(sh, send);
    }
  }
  return result;
}

/* ---------------------------------------------------------- the message --- */

function messageFor(sh, ev) {
  const start = new Date(sqlToIso(sh.starts_at));
  const where = `${sh.post_name}, ${sh.site_name}`;
  const link = publicUrl() ? ` ${publicUrl()}/admin/attendance?shift=${sh.id}` : '';
  const phone = sh.phone ? ` Call ${sh.phone}.` : '';
  switch (ev.stage) {
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
        sms: `USC NO-SHOW: ${sh.officer} has not clocked in at ${where}, ${RULES.noShowMinutes} min after the ${fmtTime(start)} start. Find cover.${phone}${link}`,
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
async function recipientsFor(shiftId, officerId, stage) {
  const people = await db
    .prepare(
      `SELECT u.id, u.first_name || ' ' || u.last_name AS name,
              a.user_id IS NOT NULL AS saved, a.sms_enabled, a.push_enabled, a.on_late, a.on_no_show, a.on_update,
              a.sms_phone, a.sms_verified_at
       FROM users u LEFT JOIN alert_subscriptions a ON a.user_id = u.id
       WHERE u.role IN (?, ?) AND u.status = 'active'`
    )
    .all(ROLES.SUPERVISOR, ROLES.ADMIN);
  const hadNoShow = stage === 'arrived' || stage === 'covered'
    ? Boolean(await db.prepare(`SELECT 1 FROM attendance_events WHERE shift_id = ? AND user_id = ? AND stage = 'no_show'`).get(shiftId, officerId))
    : false;
  return people
    .map((p) => (p.saved ? p : { ...p, ...DEFAULT_SETTINGS }))
    .filter((p) => {
      if (stage === 'late') return p.on_late;
      if (stage === 'no_show') return p.on_no_show;
      // An update is only news to somebody who was told of the problem.
      return p.on_update && (p.on_late || (p.on_no_show && hadNoShow));
    });
}

async function announce(sh, ev, { quiet = false } = {}) {
  const officerId = ev.userId;
  const msg = messageFor(sh, ev);
  const people = await recipientsFor(sh.id, officerId, ev.stage);
  const pushTo = people.filter((p) => p.push_enabled).map((p) => p.id);
  if (pushTo.length && !quiet) {
    pushAsync(pushTo, {
      title: msg.title,
      body: msg.body,
      data: { type: 'attendance', shiftId: sh.id, stage: ev.stage },
      priority: ev.stage === 'no_show' ? 'high' : 'default',
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
  if (e.stage === 'late') return `${e.officer} late at ${e.post_name}: no clock-in ${e.minutes_late} min after the start`;
  if (e.stage === 'no_show') return `${e.officer} is a no-show at ${e.post_name}`;
  if (e.stage === 'arrived') return `${e.officer} clocked in at ${e.post_name}, ${e.minutes_late} min late`;
  return `${e.post_name} covered: ${d.by || 'another officer'} is taking ${e.officer}'s shift`;
};

/** Recent stages, newest first; `since` gives only those after an id. */
export async function attendanceEvents({ since = 0, limit = 40 } = {}) {
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
       WHERE e.id > ?
       ORDER BY e.id DESC LIMIT ?`
    )
    .all(since, limit);
  return rows.map((e) => ({
    id: Number(e.id), shift_id: e.shift_id, user_id: e.user_id, stage: e.stage, label: STAGE_LABEL[e.stage],
    occurred_at: sqlToIso(e.occurred_at), created_at: sqlToIso(e.created_at), minutes_late: e.minutes_late,
    officer: e.officer, post_name: e.post_name, site_name: e.site_name, notified: Boolean(e.notified), texts: Number(e.texts),
    line: eventLine(e),
  }));
}

/**
 * The board: who is late or missing right now, who turned up late or was
 * covered today, and the latest updates.
 */
export async function attendanceBoard({ now = new Date() } = {}) {
  const shifts = await startedShifts(now);
  const byShift = new Map();
  for (const e of await eventsFor(shifts.map((s) => s.id))) {
    if (!byShift.has(e.shift_id)) byShift.set(e.shift_id, []);
    byShift.get(e.shift_id).push(e);
  }

  const open = [];
  const resolved = [];
  for (const sh of shifts) {
    const timeline = byShift.get(sh.id) || [];
    // Given to this officer after somebody else was late or missing.
    const cover = timeline.some((e) => e.user_id !== sh.user_id);
    const reached = cover ? [] : stagesFor(sh, now);
    if (!reached.length && !cover) continue;
    const coveredFrom = timeline.find((e) => e.stage === 'covered' && e.detail?.by_user_id === sh.user_id);
    const start = sqlToIso(sh.starts_at);
    const base = {
      shift_id: sh.id, user_id: sh.user_id, officer: sh.officer, employee_code: sh.employee_code, phone: sh.phone,
      post_id: sh.post_id, post_name: sh.post_name, site_name: sh.site_name, starts_at: start, ends_at: sqlToIso(sh.ends_at),
      timeline: timeline.map((e) => ({
        stage: e.stage, label: STAGE_LABEL[e.stage], officer: e.officer, at: e.occurred_at, minutes_late: e.minutes_late, detail: e.detail,
      })),
      covered_from: cover ? coveredFrom?.detail?.was || timeline.find((e) => e.user_id !== sh.user_id)?.officer : null,
    };
    if (sh.clock_in_at) {
      const inAt = sqlToIso(sh.clock_in_at);
      resolved.push({ ...base, state: cover ? 'covered' : 'arrived', clock_in_at: inAt, minutes_late: minutesAfter(start, inAt) });
      continue;
    }
    // Still nobody there. Past the end of the shift it is history.
    if (new Date(sqlToIso(sh.ends_at)) <= now) {
      resolved.push({ ...base, state: 'missed', minutes_late: null });
      continue;
    }
    const state = cover ? 'covering' : reached[reached.length - 1].stage;
    open.push({ ...base, state, minutes_late: minutesAfter(start, now) });
  }
  const rank = { no_show: 0, late: 1, covering: 2 };
  open.sort((a, b) => rank[a.state] - rank[b.state] || b.minutes_late - a.minutes_late);
  resolved.sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
  return {
    now: now.toISOString(),
    rules: { lateGraceMinutes: RULES.lateGraceMinutes, noShowMinutes: RULES.noShowMinutes },
    open,
    resolved,
    counts: {
      late: open.filter((o) => o.state === 'late').length,
      no_show: open.filter((o) => o.state === 'no_show').length,
      covering: open.filter((o) => o.state === 'covering').length,
      arrived: resolved.filter((o) => o.state === 'arrived').length,
      covered: resolved.filter((o) => o.state === 'covered').length,
    },
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
