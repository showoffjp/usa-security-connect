/**
 * Outbound text messages, through Twilio.
 *
 * The same two rules as email.js. Nothing here may break a request or a
 * sweep: a failed text is recorded and the caller carries on. And every
 * message is written to `sms_messages` before it is sent, keeping its
 * outcome, so with no provider configured the rows land as 'skipped' and
 * "was Vince told?" still has an answer.
 *
 * Settings:
 *   USC_SMS_TWILIO_SID     the Twilio account SID (AC...)
 *   USC_SMS_TWILIO_TOKEN   its auth token
 *   USC_SMS_FROM           the sending number (+1...) or a messaging service SID (MG...)
 *   USC_SMS_DISABLED=1     keep the settings but send nothing
 */

import { db } from '../lib/db.js';

const SID = process.env.USC_SMS_TWILIO_SID || '';
const TOKEN = process.env.USC_SMS_TWILIO_TOKEN || '';
const FROM = process.env.USC_SMS_FROM || '';
const DISABLED = process.env.USC_SMS_DISABLED === '1';

export const smsConfigured = Boolean(SID && TOKEN && FROM) && !DISABLED;
export const smsKind = smsConfigured ? 'twilio' : DISABLED ? 'disabled' : 'not-configured';

/**
 * A phone number as E.164, or null. Ten digits are taken as a US number;
 * anything else needs its country code.
 */
export function normalizePhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (!raw.startsWith('+')) {
    if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1') && /^[2-9]/.test(digits[1])) return `+${digits}`;
    return null;
  }
  return digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0') ? `+${digits}` : null;
}

/** +19045550100 as (904) 555-0100; other countries as given. */
export function displayPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
}

/** The last four digits only, for lists other people can see. */
export const maskPhone = (e164) => (e164 ? `•••• ${String(e164).slice(-4)}` : '');

async function record({ to, userId, body, kind, entity, entityId, status, error }) {
  const row = await db
    .prepare(
      `INSERT INTO sms_messages (to_phone, to_user_id, body, kind, entity, entity_id, status, provider, error)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(to, userId ?? null, body, kind, entity ?? null, entityId ?? null, status, smsConfigured ? 'twilio' : null, error ?? null);
  return Number(row.lastInsertRowid);
}

/**
 * Send one text. Always resolves; `ok` says whether it actually went out.
 * `logged` is what the outbox keeps instead of the body, for a text with a
 * secret in it: a verification code is sent, never stored.
 */
export async function sendSms({ to, userId, body, logged, kind, entity, entityId }) {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, reason: 'invalid_number' };
  const text = String(body).slice(0, 600);
  const kept = logged ? String(logged).slice(0, 600) : text;

  if (!smsConfigured) {
    const id = await record({
      to: phone, userId, body: kept, kind, entity, entityId, status: 'skipped',
      error: DISABLED ? 'Text messages are switched off.' : 'No Twilio account is set (USC_SMS_TWILIO_SID, USC_SMS_TWILIO_TOKEN, USC_SMS_FROM).',
    });
    return { ok: false, reason: smsKind, id };
  }

  const id = await record({ to: phone, userId, body: kept, kind, entity, entityId, status: 'queued' });
  const form = new URLSearchParams({ To: phone, Body: text });
  form.set(FROM.startsWith('MG') ? 'MessagingServiceSid' : 'From', FROM);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(SID)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const message = payload?.message || `Twilio returned ${res.status}.`;
      await db.prepare(`UPDATE sms_messages SET status = 'failed', error = ? WHERE id = ?`).run(String(message).slice(0, 500), id);
      console.error('[usc] text failed:', message);
      return { ok: false, reason: 'provider_error', id, error: message };
    }
    await db.prepare(`UPDATE sms_messages SET status = 'sent', provider_id = ?, sent_at = now() WHERE id = ?`).run(payload?.sid || null, id);
    return { ok: true, id };
  } catch (err) {
    await db.prepare(`UPDATE sms_messages SET status = 'failed', error = ? WHERE id = ?`).run(String(err.message).slice(0, 500), id);
    console.error('[usc] text failed:', err.message);
    return { ok: false, reason: 'network_error', id, error: err.message };
  }
}
