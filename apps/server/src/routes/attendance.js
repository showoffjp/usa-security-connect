/**
 * Late arrivals and no-shows: the live board, and each supervisor's and
 * administrator's own alert settings - what they hear about, by push and by
 * text, and the phone number the texts go to.
 *
 * A number only receives alerts once its owner has typed back the code sent
 * to it, so nobody can sign a stranger's phone up for texts. With no text
 * provider configured, the code is shown on screen instead of sent.
 */

import { Router } from 'express';
import { z } from 'zod';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, rateLimit, sqlToIso } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES } from '../shared.js';
import { attendanceBoard, attendanceEvents, recentTexts, settingsFor, sweepAttendance, DEFAULT_SETTINGS } from '../services/attendance.js';
import { sendSms, normalizePhone, displayPhone, smsConfigured } from '../services/sms.js';

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

const CODE_MINUTES = 10;
const MAX_CODE_TRIES = 5;
const hashCode = (userId, code) => createHash('sha256').update(`${userId}:${code}`).digest('hex');

/**
 * The board. Runs the late and no-show pass first, so the page is never
 * behind the clock-ins and an alert goes out even with no timer running.
 * `since` returns only the updates after that id, for the live feed.
 */
attendanceRouter.get(
  '/',
  wrap(async (req, res) => {
    const { since } = parse(z.object({ since: z.coerce.number().int().min(0).optional() }), req.query);
    await sweepAttendance();
    const [board, events, texts, settings] = await Promise.all([
      attendanceBoard(),
      attendanceEvents({ since: since || 0 }),
      recentTexts(),
      settingsFor(req.user.id),
    ]);
    res.json({ ...board, events, texts, settings });
  })
);

/* ---------------------------------------------------------- my settings --- */

attendanceRouter.get(
  '/settings',
  wrap(async (req, res) => {
    res.json({ settings: await settingsFor(req.user.id) });
  })
);

const settingsSchema = z.object({
  smsEnabled: z.boolean(),
  pushEnabled: z.boolean(),
  onLate: z.boolean(),
  onNoShow: z.boolean(),
  onUpdate: z.boolean(),
});

/** Make sure the caller has a row, with the defaults they were already getting. */
async function ensureRow(userId) {
  await db
    .prepare(
      `INSERT INTO alert_subscriptions (user_id, sms_enabled, push_enabled, on_late, on_no_show, on_update)
       VALUES (?,?,?,?,?,?) ON CONFLICT (user_id) DO NOTHING`
    )
    .run(userId, DEFAULT_SETTINGS.sms_enabled, DEFAULT_SETTINGS.push_enabled, DEFAULT_SETTINGS.on_late,
      DEFAULT_SETTINGS.on_no_show, DEFAULT_SETTINGS.on_update);
  return db.prepare(`SELECT * FROM alert_subscriptions WHERE user_id = ?`).get(userId);
}

attendanceRouter.put(
  '/settings',
  wrap(async (req, res) => {
    const body = parse(settingsSchema, req.body);
    const row = await ensureRow(req.user.id);
    if (body.smsEnabled && !(row.sms_phone && row.sms_verified_at)) {
      throw new HttpError(409, 'Add and confirm a phone number before turning texts on.');
    }
    await db
      .prepare(
        `UPDATE alert_subscriptions SET sms_enabled = ?, push_enabled = ?, on_late = ?, on_no_show = ?, on_update = ?, updated_at = now()
         WHERE user_id = ?`
      )
      .run(body.smsEnabled, body.pushEnabled, body.onLate, body.onNoShow, body.onUpdate, req.user.id);
    await audit(req.user.id, 'alerts.settings', 'user', req.user.id, body, req.ip);
    res.json({ settings: await settingsFor(req.user.id) });
  })
);

/** Send a code to a new number. Three an hour, so this cannot be used to pester a phone. */
attendanceRouter.post(
  '/settings/phone',
  rateLimit({ windowMs: 60 * 60000, max: 3, key: (req) => `sms-code:${req.user.id}` }),
  wrap(async (req, res) => {
    const { phone } = parse(z.object({ phone: z.string().trim().min(7).max(24) }), req.body);
    const e164 = normalizePhone(phone);
    if (!e164) throw new HttpError(422, 'Enter a mobile number: ten digits for a US number, or + and the country code.');
    await ensureRow(req.user.id);
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    await db
      .prepare(
        `UPDATE alert_subscriptions
         SET pending_phone = ?, pending_code_hash = ?, pending_expires_at = now() + interval '${CODE_MINUTES} minutes', pending_attempts = 0, updated_at = now()
         WHERE user_id = ?`
      )
      .run(e164, hashCode(req.user.id, code), req.user.id);
    const sent = await sendSms({
      to: e164, userId: req.user.id, kind: 'verify_phone',
      body: `USA Security Connect: your code is ${code}. It confirms this phone for late and no-show alerts, and expires in ${CODE_MINUTES} minutes.`,
      logged: `USA Security Connect: your code is ••••••. It confirms this phone for late and no-show alerts, and expires in ${CODE_MINUTES} minutes.`,
    });
    await audit(req.user.id, 'alerts.phone_code', 'user', req.user.id, { phone: displayPhone(e164), sent: sent.ok }, req.ip);
    res.status(201).json({
      settings: await settingsFor(req.user.id),
      sent: sent.ok,
      // Nothing can be texted without a provider, so the code is shown instead.
      ...(smsConfigured ? {} : { code }),
    });
  })
);

attendanceRouter.post(
  '/settings/phone/verify',
  wrap(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'The code is six digits.') }), req.body);
    const row = await db.prepare(`SELECT * FROM alert_subscriptions WHERE user_id = ?`).get(req.user.id);
    if (!row?.pending_phone || !row.pending_code_hash) throw new HttpError(409, 'Ask for a code first.');
    if (new Date(sqlToIso(row.pending_expires_at)) <= new Date()) throw new HttpError(410, 'That code has expired. Ask for a new one.');
    if (row.pending_attempts >= MAX_CODE_TRIES) throw new HttpError(429, 'Too many wrong codes. Ask for a new one.');
    const ok = timingSafeEqual(Buffer.from(hashCode(req.user.id, code)), Buffer.from(row.pending_code_hash));
    if (!ok) {
      await db.prepare(`UPDATE alert_subscriptions SET pending_attempts = pending_attempts + 1 WHERE user_id = ?`).run(req.user.id);
      throw new HttpError(422, 'That code is not right.');
    }
    await db
      .prepare(
        `UPDATE alert_subscriptions
         SET sms_phone = pending_phone, sms_verified_at = now(), sms_enabled = true,
             pending_phone = NULL, pending_code_hash = NULL, pending_expires_at = NULL, pending_attempts = 0, updated_at = now()
         WHERE user_id = ?`
      )
      .run(req.user.id);
    await audit(req.user.id, 'alerts.phone_verified', 'user', req.user.id, { phone: displayPhone(row.pending_phone) }, req.ip);
    res.json({ settings: await settingsFor(req.user.id) });
  })
);

attendanceRouter.delete(
  '/settings/phone',
  wrap(async (req, res) => {
    await db
      .prepare(
        `UPDATE alert_subscriptions
         SET sms_phone = NULL, sms_verified_at = NULL, sms_enabled = false,
             pending_phone = NULL, pending_code_hash = NULL, pending_expires_at = NULL, pending_attempts = 0, updated_at = now()
         WHERE user_id = ?`
      )
      .run(req.user.id);
    await audit(req.user.id, 'alerts.phone_removed', 'user', req.user.id, {}, req.ip);
    res.json({ settings: await settingsFor(req.user.id) });
  })
);

/** A test text to the confirmed number. */
attendanceRouter.post(
  '/settings/test',
  rateLimit({ windowMs: 10 * 60000, max: 3, key: (req) => `sms-test:${req.user.id}` }),
  wrap(async (req, res) => {
    const row = await db.prepare(`SELECT sms_phone, sms_verified_at FROM alert_subscriptions WHERE user_id = ?`).get(req.user.id);
    if (!row?.sms_phone || !row.sms_verified_at) throw new HttpError(409, 'Add and confirm a phone number first.');
    const sent = await sendSms({
      to: row.sms_phone, userId: req.user.id, kind: 'test',
      body: 'USA Security Connect: test alert. Late and no-show texts will reach this phone.',
    });
    res.status(201).json({ sent: sent.ok, reason: sent.ok ? null : sent.reason, error: sent.error || null });
  })
);
