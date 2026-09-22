import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { registerDevice, unregisterDevice, sendPush } from '../services/push.js';
import { ROLES } from '../shared.js';

export const devicesRouter = Router();
devicesRouter.use(requireAuth);

const registerSchema = z.object({
  token: z.string().min(10).max(255),
  platform: z.enum(['ios', 'android', 'web']).optional(),
  deviceId: z.string().max(128).optional(),
});

devicesRouter.post(
  '/register',
  wrap(async (req, res) => {
    const body = parse(registerSchema, req.body);
    const result = await registerDevice({
      userId: req.user.id,
      token: body.token,
      platform: body.platform,
      deviceId: body.deviceId,
    });

    if (!result.ok) throw new HttpError(422, 'That push token is not in a recognised format.');

    await audit(req.user.id, 'device.registered', 'user', req.user.id, { platform: body.platform }, req.ip);
    res.status(201).json({ ok: true });
  })
);

devicesRouter.post(
  '/unregister',
  wrap(async (req, res) => {
    const token = String(req.body?.token || '');
    if (token) await unregisterDevice(token);
    res.json({ ok: true });
  })
);

/** Devices currently registered to the signed-in user. */
devicesRouter.get(
  '/',
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT id, platform, device_id, created_at, last_seen_at
         FROM device_tokens WHERE user_id = ? ORDER BY last_seen_at DESC`
      )
      .all(req.user.id));
    res.json({ devices: rows });
  })
);

/** Lets an admin prove push is working before relying on it. */
devicesRouter.post(
  '/test',
  requireRole(ROLES.ADMIN),
  wrap(async (req, res) => {
    const result = await sendPush([req.user.id], {
      title: 'USA Security Connect',
      body: 'Push notifications are working.',
      data: { type: 'test' },
    });
    res.json(result);
  })
);
