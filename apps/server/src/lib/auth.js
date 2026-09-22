import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db, audit } from './db.js';
import { RULES, atLeast, isWeakPin } from '../shared.js';
import { HttpError } from './http.js';

const JWT_SECRET =
  process.env.USC_JWT_SECRET ||
  (process.env.NODE_ENV === 'production'
    ? (() => {
        throw new Error('USC_JWT_SECRET must be set in production');
      })()
    : 'dev-only-insecure-secret-change-me');

const TOKEN_TTL = process.env.USC_TOKEN_TTL || '12h';

/* ------------------------------------------------------------------ PIN --- */

/** scrypt with a per-user salt. PINs are short, so the cost factor matters. */
export function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash, salt };
}

export function verifyPin(pin, hash, salt) {
  if (!hash || !salt) return false;
  const candidate = crypto.scryptSync(String(pin), salt, 64, { N: 16384, r: 8, p: 1 });
  const stored = Buffer.from(hash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

/**
 * Admin-generated PIN. Cryptographically random, and never a trivial
 * sequence/repeat - the officer is forced to change it on first sign-in anyway.
 */
export function generatePin(length = 4) {
  for (;;) {
    let pin = '';
    for (let i = 0; i < length; i++) pin += crypto.randomInt(0, 10);
    if (!isWeakPin(pin)) return pin;
  }
}

/** Next free employee code, starting at 1001. */
export async function generateEmployeeCode() {
  const row = (await db
    .prepare(`SELECT MAX(CAST(employee_code AS INTEGER)) AS max_code FROM users WHERE length(employee_code) = 4`)
    .get());
  const next = Math.max(1001, (row?.max_code || 1000) + 1);
  if (next > 9999) throw new HttpError(409, 'No 4-digit employee codes remain; assign one manually.');
  return String(next);
}

/* ---------------------------------------------------------------- Tokens --- */

export function issueToken(user) {
  return jwt.sign(
    { sub: user.id, code: user.employee_code, role: user.role, kind: 'staff' },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

export function readToken(token) {
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    // Client-portal tokens are signed with the same secret and their `sub` is a
    // client_users id, which would otherwise be read as a users id. Anything
    // that is not explicitly staff is refused here.
    return claims?.kind === 'client' ? null : claims;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- Login --- */

export async function authenticate({ employeeCode, pin, ip }) {
  const user = (await db.prepare(`SELECT * FROM users WHERE employee_code = ?`).get(String(employeeCode).trim()));

  // Same message and roughly the same work either way, so an attacker cannot
  // tell a real employee code from a fake one.
  if (!user) {
    crypto.scryptSync(String(pin), 'decoy-salt', 64, { N: 16384, r: 8, p: 1 });
    throw new HttpError(401, 'Employee code or PIN is incorrect.');
  }

  if (user.locked_until && new Date(user.locked_until + 'Z') > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until + 'Z') - new Date()) / 60000);
    throw new HttpError(423, `Account locked. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or ask a supervisor to reset your PIN.`);
  }

  if (user.status !== 'active') {
    await audit(user.id, 'login.blocked', 'user', user.id, { status: user.status }, ip);
    throw new HttpError(403, 'This account is not active. Contact your supervisor.');
  }

  if (!verifyPin(pin, user.pin_hash, user.pin_salt)) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= RULES.maxPinAttempts;
    (await db.prepare(
      `UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?`
    ).run(
      lock ? 0 : attempts,
      lock ? new Date(Date.now() + RULES.lockoutMinutes * 60000).toISOString().replace('T', ' ').slice(0, 19) : null,
      user.id
    ));
    await audit(user.id, lock ? 'login.locked' : 'login.failed', 'user', user.id, { attempts }, ip);
    if (lock) {
      throw new HttpError(423, `Too many incorrect PIN attempts. Account locked for ${RULES.lockoutMinutes} minutes.`);
    }
    const left = RULES.maxPinAttempts - attempts;
    throw new HttpError(401, `Employee code or PIN is incorrect. ${left} attempt${left === 1 ? '' : 's'} remaining.`);
  }

  (await db.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?`
  ).run(user.id));
  await audit(user.id, 'login.success', 'user', user.id, null, ip);

  return { user, token: issueToken(user) };
}

/* ------------------------------------------------------------ Middleware --- */

export function requireAuth(req, _res, next) {
  // Express 4 does not catch a rejected promise from middleware, so the async
  // work is kept inside and every outcome is routed through next().
  (async () => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const claims = token && readToken(token);
    if (!claims) throw new HttpError(401, 'Sign in to continue.');

    const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(claims.sub);
    if (!user || user.status !== 'active') throw new HttpError(401, 'Session is no longer valid.');

    req.user = user;
  })().then(() => next(), next);
}

export function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
    if (!atLeast(req.user.role, role)) {
      return next(new HttpError(403, 'You do not have access to this area.'));
    }
    next();
  };
}

/** Strip secrets before a user object ever leaves the server. */
export function publicUser(u) {
  if (!u) return null;
  const { pin_hash, pin_salt, failed_attempts, locked_until, ...safe } = u;
  return {
    ...safe,
    full_name: `${u.first_name} ${u.last_name}`,
    locked: Boolean(locked_until && new Date(locked_until + 'Z') > new Date()),
  };
}
