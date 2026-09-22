import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, rateLimit } from '../lib/http.js';
import { authenticate, hashPin, verifyPin, publicUser, requireAuth, issueToken } from '../lib/auth.js';
import { isWeakPin } from '../shared.js';

export const authRouter = Router();

const loginSchema = z.object({
  employeeCode: z.string().trim().regex(/^[0-9]{4,6}$/, 'Employee code must be 4-6 digits.'),
  pin: z.string().trim().regex(/^[0-9]{4,6}$/, 'PIN must be 4-6 digits.'),
  deviceId: z.string().max(128).optional(),
});

authRouter.post(
  '/login',
  // Per-code limiting as well as per-IP, so one shared office IP cannot be
  // used to lock everyone out, and one code cannot be sprayed from many IPs.
  rateLimit({ windowMs: 5 * 60000, max: 20, key: (req) => `ip:${req.ip}` }),
  rateLimit({ windowMs: 5 * 60000, max: 10, key: (req) => `code:${req.body?.employeeCode || 'none'}` }),
  wrap(async (req, res) => {
    const { employeeCode, pin, deviceId } = parse(loginSchema, req.body);
    const { user, token } = await authenticate({ employeeCode, pin, ip: req.ip });

    if (deviceId) {
      await audit(user.id, 'login.device', 'user', user.id, { deviceId }, req.ip);
    }

    res.json({
      token,
      user: publicUser(user),
      mustChangePin: Boolean(user.must_change_pin),
    });
  })
);

const changePinSchema = z
  .object({
    currentPin: z.string().trim().regex(/^[0-9]{4,6}$/),
    newPin: z.string().trim().regex(/^[0-9]{4,6}$/, 'New PIN must be 4-6 digits.'),
    confirmPin: z.string().trim(),
  })
  .refine((d) => d.newPin === d.confirmPin, {
    message: 'The two PINs do not match.',
    path: ['confirmPin'],
  })
  .refine((d) => d.newPin !== d.currentPin, {
    message: 'Choose a PIN you have not used before.',
    path: ['newPin'],
  });

authRouter.post(
  '/change-pin',
  requireAuth,
  wrap(async (req, res) => {
    const { currentPin, newPin } = parse(changePinSchema, req.body);

    if (!verifyPin(currentPin, req.user.pin_hash, req.user.pin_salt)) {
      throw new HttpError(401, 'Your current PIN is incorrect.');
    }
    if (isWeakPin(newPin)) {
      throw new HttpError(422, 'That PIN is too easy to guess. Avoid repeated digits and simple sequences.', [
        { field: 'newPin', message: 'Pick a less predictable PIN.' },
      ]);
    }

    const { hash, salt } = hashPin(newPin);
    (await db.prepare(
      `UPDATE users
       SET pin_hash = ?, pin_salt = ?, pin_set_at = datetime('now'),
           must_change_pin = 0, updated_at = datetime('now')
       WHERE id = ?`
    ).run(hash, salt, req.user.id));

    await audit(req.user.id, 'pin.changed', 'user', req.user.id, null, req.ip);
    const fresh = (await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id));

    // Hand back a fresh token so the client drops the must-change-pin state.
    res.json({ ok: true, token: issueToken(fresh), user: publicUser(fresh) });
  })
);

authRouter.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const site = req.user.default_site_id
      ? (await db.prepare(`SELECT id, name, address, city, state FROM sites WHERE id = ?`).get(req.user.default_site_id))
      : null;
    res.json({
      user: publicUser(req.user),
      defaultSite: site,
      mustChangePin: Boolean(req.user.must_change_pin),
    });
  })
);

authRouter.post(
  '/logout',
  requireAuth,
  wrap(async (req, res) => {
    // Tokens are stateless; the client discards it. Recorded for the audit trail.
    await audit(req.user.id, 'logout', 'user', req.user.id, null, req.ip);
    res.json({ ok: true });
  })
);
