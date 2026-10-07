/**
 * Push delivery via Expo's push service.
 *
 * Nothing here is allowed to break a request. A failed push is logged and
 * dropped - an officer must still be able to clock in when the notification
 * service is down.
 */

import { db } from '../lib/db.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;

/** Expo tokens look like ExponentPushToken[xxxxxxxx]. */
const looksValid = (token) => typeof token === 'string' && /^Expo(nent)?PushToken\[.+\]$/.test(token);

export async function registerDevice({ userId, token, platform, deviceId }) {
  if (!looksValid(token)) return { ok: false, reason: 'invalid_token' };

  // A phone can be handed between officers, so the token belongs to whoever
  // signed in last rather than accumulating across accounts.
  (await db.prepare(
    `INSERT INTO device_tokens (user_id, token, platform, device_id)
     VALUES (?,?,?,?)
     ON CONFLICT(token) DO UPDATE SET
       user_id = excluded.user_id,
       platform = excluded.platform,
       device_id = excluded.device_id,
       last_seen_at = datetime('now')`
  ).run(userId, token, platform ?? null, deviceId ?? null));

  return { ok: true };
}

export async function unregisterDevice(token) {
  (await db.prepare(`DELETE FROM device_tokens WHERE token = ?`).run(token));
}

async function tokensFor(userIds) {
  if (!userIds?.length) return [];
  const placeholders = userIds.map(() => '?').join(',');
  return (await db
    .prepare(`SELECT token FROM device_tokens WHERE user_id IN (${placeholders})`)
    .all(...userIds))
    .map((r) => r.token);
}

/** Everyone who should hear about a compliance problem. */
export async function supervisorIds() {
  return (await db
    .prepare(`SELECT id FROM users WHERE role IN ('supervisor','admin') AND status = 'active'`)
    .all())
    .map((r) => r.id);
}

/**
 * Send to a set of users. Returns immediately if push is switched off or
 * nobody has a registered device.
 */
export async function sendPush(userIds, { title, body, data, priority = 'default' } = {}) {
  if (process.env.USC_PUSH_DISABLED === '1') return { sent: 0, skipped: 'disabled' };

  const tokens = await tokensFor([...new Set(userIds || [])]);
  if (!tokens.length) return { sent: 0, skipped: 'no_devices' };

  const messages = tokens.map((to) => ({
    to,
    title,
    body,
    data: data || {},
    sound: priority === 'high' ? 'default' : null,
    priority: priority === 'high' ? 'high' : 'default',
    channelId: priority === 'high' ? 'urgent' : 'default',
  }));

  let sent = 0;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      const payload = await res.json().catch(() => null);
      const tickets = payload?.data || [];

      for (const [idx, ticket] of tickets.entries()) {
        if (ticket?.status === 'ok') {
          sent += 1;
          continue;
        }
        // A token for an uninstalled app is dead; stop sending to it.
        if (ticket?.details?.error === 'DeviceNotRegistered') {
          await unregisterDevice(batch[idx].to);
        } else {
          console.warn('[usc] push rejected', ticket?.message || ticket?.details?.error);
        }
      }
    } catch (err) {
      console.error('[usc] push delivery failed', err.message);
    }
  }

  return { sent };
}

/** Fire and forget: used from request handlers that must not wait on push. */
export function pushAsync(userIds, message) {
  // Deliberately not awaited: an officer's clock-in must not wait on, or fail
  // because of, a third-party notification service.
  sendPush(userIds, message).catch((err) => console.error('[usc] push error', err.message));
}

/* ----------------------------------------------------- domain messages --- */

export async function notifyBroadcast(broadcast) {
  const audience = (await db
    .prepare(
      `SELECT id FROM users
       WHERE status = 'active'
         AND (? IS NULL OR role = ?)
         AND (? IS NULL OR default_site_id = ?)`
    )
    .all(
      broadcast.audience_role ?? null,
      broadcast.audience_role ?? null,
      broadcast.audience_site_id ?? null,
      broadcast.audience_site_id ?? null
    ))
    .map((r) => r.id);

  const urgent = broadcast.priority === 'urgent';
  pushAsync(audience, {
    title: urgent ? `URGENT: ${broadcast.title}` : broadcast.title,
    body: broadcast.body.slice(0, 160),
    data: { type: 'broadcast', id: broadcast.id },
    priority: urgent || broadcast.priority === 'important' ? 'high' : 'default',
  });
}

/**
 * Nudge officers whose status check-in is due, once each. `notified_at` keeps
 * the sweep from re-sending the same prompt every minute.
 */
export async function notifyDueCheckIns(now = new Date()) {
  const due = (await db
    .prepare(
      `SELECT sc.id, sc.user_id, sc.due_at, p.name AS post_name
       FROM status_checks sc
       JOIN time_entries te ON te.id = sc.time_entry_id
       JOIN posts p ON p.id = te.post_id
       WHERE sc.status = 'pending'
         AND sc.notified_at IS NULL
         AND sc.due_at <= ?`
    )
    .all(now.toISOString().replace('T', ' ').slice(0, 19)));

  for (const check of due) {
    (await db.prepare(`UPDATE status_checks SET notified_at = datetime('now') WHERE id = ?`).run(check.id));
    pushAsync([check.user_id], {
      title: 'Status check-in due',
      body: `Confirm you are on post at ${check.post_name}.`,
      data: { type: 'check_in', id: check.id },
      priority: 'high',
    });
  }
  return due.length;
}

/** Tell supervisors about serious flags, once per flag. */
export async function notifyNewFlags() {
  const flags = (await db
    .prepare(
      `SELECT f.id, f.type, f.severity, u.first_name || ' ' || u.last_name AS officer
       FROM flags f JOIN users u ON u.id = f.user_id
       WHERE f.notified_at IS NULL AND f.resolved_at IS NULL AND f.severity = 'critical'`
    )
    .all());

  if (!flags.length) return 0;
  const recipients = await supervisorIds();

  for (const flag of flags) {
    (await db.prepare(`UPDATE flags SET notified_at = datetime('now') WHERE id = ?`).run(flag.id));
    // No-shows are told by attendance.js, with the post, to the people who
    // asked to hear of them, as a push or a text.
    if (flag.type === 'no_show') continue;
    const labels = {
      missed_check_in: 'missed a status check-in',
      geofence_violation: 'clocked in away from the post',
      no_show: 'did not show for a scheduled shift',
    };
    pushAsync(recipients, {
      title: 'Compliance alert',
      body: `${flag.officer} ${labels[flag.type] || flag.type.replace(/_/g, ' ')}.`,
      data: { type: 'flag', id: flag.id },
      priority: 'high',
    });
  }
  return flags.length;
}

export async function notifyMessage({ threadId, senderId, senderName, body }) {
  const recipients = (await db
    .prepare(`SELECT user_id FROM thread_participants WHERE thread_id = ? AND user_id != ?`)
    .all(threadId, senderId))
    .map((r) => r.user_id);

  pushAsync(recipients, {
    title: senderName,
    body: body.slice(0, 160),
    data: { type: 'message', threadId },
  });
}
