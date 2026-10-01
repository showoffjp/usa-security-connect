/**
 * Shift confirmations: the officer on a shift says they will be there.
 *
 * A confirmation belongs to one officer, one post and one set of times. The
 * shift stores a key of those alongside the confirmation, and a shift is
 * confirmed only while the key still matches - so a shift that is moved,
 * reassigned or swapped falls back to unconfirmed on its own, whichever of
 * the many update paths changed it.
 */

import { db } from '../lib/db.js';
import { sqlToIso } from '../lib/http.js';
import { CONFIRM_AHEAD_DAYS, CONFIRM_REMIND_HOURS, CONFIRM_ALERT_HOURS, CONFIRM_URGENT_HOURS } from '../shared.js';
import { toSql } from './compliance.js';
import { pushAsync } from './push.js';

const HOUR = 3600000;

export const confirmKey = (s) =>
  s.user_id ? `${s.user_id}|${s.post_id}|${sqlToIso(s.starts_at)}|${sqlToIso(s.ends_at)}` : null;

export const isConfirmed = (s) => Boolean(s.user_id && s.confirmed_key && s.confirmed_key === confirmKey(s));

/** The confirmation fields as callers present them: only when it still holds. */
export function confirmationOf(s) {
  if (!isConfirmed(s)) return { confirmed: false, confirmed_at: null, confirm_method: null };
  return { confirmed: true, confirmed_at: sqlToIso(s.confirmed_at), confirm_method: s.confirm_method || 'app' };
}

/** A shift row as it goes to its officer: the confirmation fields in place of the bookkeeping columns. */
export function withConfirmation(s) {
  const { confirmed_by, confirm_note, confirmed_key, reminded_key, confirmed_at, confirm_method, ...rest } = s;
  return { ...rest, ...confirmationOf(s) };
}

/** Whether its officer can confirm a shift now: still to come, not clocked in, inside the window. */
export function confirmable(s, now = Date.now()) {
  const starts = new Date(sqlToIso(s.starts_at)).getTime();
  return s.status === 'scheduled' && !s.clock_in_at && starts > now && starts - now <= CONFIRM_AHEAD_DAYS * 24 * HOUR;
}

export async function confirmShift(shift, { byUserId, method = 'app', note = null }) {
  await db
    .prepare(
      `UPDATE shifts SET confirmed_at = now(), confirmed_by = ?, confirm_method = ?, confirm_note = ?, confirmed_key = ?
       WHERE id = ?`
    )
    .run(byUserId, method, note, confirmKey(shift), shift.id);
  return db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shift.id);
}

/**
 * Shifts with an officer that start within `hours` and are not confirmed,
 * soonest first. Shifts already clocked in to are left out: the officer is
 * plainly there.
 */
export async function unconfirmedSoon(hours = CONFIRM_ALERT_HOURS, now = new Date()) {
  const rows = await db
    .prepare(
      `SELECT sh.*, u.first_name, u.last_name, u.phone, u.employee_code, p.name AS post_name, s.name AS site_name, s.id AS site_id
       FROM shifts sh
       JOIN users u ON u.id = sh.user_id
       JOIN posts p ON p.id = sh.post_id
       JOIN sites s ON s.id = p.site_id
       WHERE sh.user_id IS NOT NULL AND sh.status = 'scheduled' AND sh.starts_at > ? AND sh.starts_at <= ?
         AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.shift_id = sh.id)
       ORDER BY sh.starts_at`
    )
    .all(toSql(now), toSql(new Date(now.getTime() + hours * HOUR)));
  return rows
    .filter((s) => !isConfirmed(s))
    .map((s) => {
      const startsIn = Math.round((new Date(sqlToIso(s.starts_at)) - now) / 60000);
      return {
        id: s.id,
        user_id: s.user_id,
        officer: `${s.first_name} ${s.last_name}`,
        employee_code: s.employee_code,
        phone: s.phone,
        post_name: s.post_name,
        site_name: s.site_name,
        site_id: s.site_id,
        starts_at: sqlToIso(s.starts_at),
        ends_at: sqlToIso(s.ends_at),
        starts_in_minutes: startsIn,
        urgent: startsIn <= CONFIRM_URGENT_HOURS * 60,
        reminded: Boolean(s.reminded_key && s.reminded_key === confirmKey(s)),
      };
    });
}

/**
 * A push to every officer with an unconfirmed shift in the next day, once per
 * shift as it stands (moving the shift earns a fresh reminder). Run by the
 * sweep.
 */
export async function sendConfirmReminders(now = new Date()) {
  const due = await unconfirmedSoon(CONFIRM_REMIND_HOURS, now);
  let sent = 0;
  for (const s of due) {
    if (s.reminded) continue;
    const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(s.id);
    const when = new Date(s.starts_at).toLocaleString('en-US', {
      weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    });
    pushAsync([s.user_id], {
      title: 'Confirm your shift',
      body: `${when} at ${s.post_name}, ${s.site_name}. Tap to confirm you will be there.`,
      data: { type: 'confirm', shiftId: s.id },
      priority: 'high',
    });
    await db.prepare(`UPDATE shifts SET reminded_key = ? WHERE id = ?`).run(confirmKey(shift), s.id);
    sent += 1;
  }
  return sent;
}
