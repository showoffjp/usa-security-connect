/**
 * Authentication for client contacts.
 *
 * Deliberately a separate identity space from staff. A client is not an
 * employee: they sign in with an email and password rather than an employee
 * code and PIN, they have no role in the staff hierarchy, and their token
 * carries `kind: 'client'` so it can never satisfy a staff route - see the
 * check in requireAuth.
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db, audit, demoInstance } from './db.js';
import { HttpError } from './http.js';
import { RULES } from '../shared.js';

const JWT_SECRET =
  process.env.USC_JWT_SECRET ||
  (demoInstance ? 'usc-demo-instance' : null) ||
  (process.env.NODE_ENV === 'production'
    ? (() => {
        throw new Error('USC_JWT_SECRET must be set in production');
      })()
    : 'dev-only-insecure-secret-change-me');

/** Clients get a shorter session than officers; they are not mid-shift. */
const TOKEN_TTL = process.env.USC_CLIENT_TOKEN_TTL || '8h';

export const CLIENT_TOKEN_KIND = 'client';

/* ------------------------------------------------------------ passwords --- */

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  const stored = Buffer.from(hash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

/** Readable but high-entropy, because an admin reads it down the phone. */
export function generatePassword() {
  const words = [
    'harbor', 'lantern', 'compass', 'granite', 'meridian', 'thicket', 'juniper',
    'cobalt', 'pelican', 'estuary', 'marlin', 'cypress',
  ];
  const pick = () => words[crypto.randomInt(0, words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 9999)}`;
}

export const passwordIsStrongEnough = (password) => String(password || '').length >= 12;

/* -------------------------------------------------- set-password links --- */

/**
 * How long a link lives.
 *
 * An invitation is sent to somebody who may not read email for a few days. A
 * reset is a response to something happening now, so it is deliberately short.
 */
export const TOKEN_HOURS = {
  invite: Number(process.env.USC_INVITE_HOURS) || 168, // seven days
  reset: Number(process.env.USC_RESET_HOURS) || 24,
};

/** Only ever store the hash: a leaked table must not yield working links. */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Mint a link for a contact to choose their own password.
 *
 * Any earlier unused token for that contact is expired first, so the most
 * recent link is the only one that works - otherwise an old invitation
 * forwarded to the wrong person stays live.
 */
export async function createPasswordToken({ clientUserId, purpose = 'invite', createdBy = null }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hours = TOKEN_HOURS[purpose] ?? TOKEN_HOURS.reset;
  const expiresAt = new Date(Date.now() + hours * 3600000);

  await db
    .prepare(
      `UPDATE client_password_tokens SET expires_at = now()
       WHERE client_user_id = ? AND used_at IS NULL AND expires_at > now()`
    )
    .run(clientUserId);

  await db
    .prepare(
      `INSERT INTO client_password_tokens (client_user_id, token_hash, purpose, expires_at, created_by)
       VALUES (?,?,?,?,?)`
    )
    .run(clientUserId, hashToken(token), purpose, expiresAt.toISOString(), createdBy);

  return { token, expiresAt, purpose };
}

/** The contact behind a link, or null when it is unknown, used or expired. */
export async function readPasswordToken(token) {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT t.*, c.email, c.name, c.company, c.status
       FROM client_password_tokens t
       JOIN client_users c ON c.id = t.client_user_id
       WHERE t.token_hash = ?`
    )
    .get(hashToken(token));

  if (!row) return null;
  if (row.used_at) return { ...row, valid: false, reason: 'used' };
  if (new Date(row.expires_at) <= new Date()) return { ...row, valid: false, reason: 'expired' };
  if (row.status !== 'active') return { ...row, valid: false, reason: 'inactive' };
  return { ...row, valid: true };
}

/**
 * Set the password a link was issued for.
 *
 * The token is spent and every existing session for that contact is retired,
 * in one transaction: a half-applied password change is worse than a failed
 * one.
 */
export async function consumePasswordToken({ token, password }) {
  const record = await readPasswordToken(token);
  if (!record) throw new HttpError(404, 'That link is not valid. Ask your account manager for a new one.');
  if (!record.valid) {
    const message = {
      used: 'That link has already been used. Ask your account manager for a new one.',
      expired: 'That link has expired. Ask your account manager for a new one.',
      inactive: 'This account is not active. Contact your account manager.',
    }[record.reason];
    throw new HttpError(410, message);
  }
  if (!passwordIsStrongEnough(password)) {
    throw new HttpError(422, 'Please correct the highlighted fields.', [
      { field: 'password', message: 'Use at least 12 characters.' },
    ]);
  }

  const { hash, salt } = hashPassword(password);

  await db.transaction(async () => {
    await db
      .prepare(`UPDATE client_password_tokens SET used_at = now() WHERE id = ?`)
      .run(record.id);
    await db
      .prepare(
        `UPDATE client_users
         SET password_hash = ?, password_salt = ?, token_version = token_version + 1,
             failed_attempts = 0, locked_until = NULL
         WHERE id = ?`
      )
      .run(hash, salt, record.client_user_id);
  })();

  return db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(record.client_user_id);
}

/* ---------------------------------------------------------------- token --- */

export const issueClientToken = (client) =>
  jwt.sign(
    { sub: client.id, kind: CLIENT_TOKEN_KIND, email: client.email, v: client.token_version ?? 0 },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );

export function readClientToken(token) {
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    return claims?.kind === CLIENT_TOKEN_KIND ? claims : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- login --- */

export async function authenticateClient({ email, password, ip }) {
  const client = await db
    .prepare(`SELECT * FROM client_users WHERE lower(email) = lower(?)`)
    .get(String(email).trim());

  // Same work and the same message whether or not the account exists.
  if (!client) {
    crypto.scryptSync(String(password), 'decoy-salt', 64, { N: 16384, r: 8, p: 1 });
    throw new HttpError(401, 'Email or password is incorrect.');
  }

  if (client.locked_until && new Date(client.locked_until) > new Date()) {
    const minutes = Math.ceil((new Date(client.locked_until) - new Date()) / 60000);
    throw new HttpError(423, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }

  if (client.status !== 'active') {
    throw new HttpError(403, 'This account is not active. Contact your account manager.');
  }

  if (!verifyPassword(password, client.password_hash, client.password_salt)) {
    const attempts = client.failed_attempts + 1;
    const lock = attempts >= RULES.maxPinAttempts;
    await db
      .prepare(`UPDATE client_users SET failed_attempts = ?, locked_until = ? WHERE id = ?`)
      .run(
        lock ? 0 : attempts,
        lock ? new Date(Date.now() + RULES.lockoutMinutes * 60000).toISOString() : null,
        client.id
      );
    await audit(null, lock ? 'client.login_locked' : 'client.login_failed', 'client_user', client.id, null, ip);
    throw new HttpError(401, 'Email or password is incorrect.');
  }

  await db
    .prepare(`UPDATE client_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = ?`)
    .run(client.id);
  await audit(null, 'client.login', 'client_user', client.id, null, ip);

  return { client, token: issueClientToken(client) };
}

/* ----------------------------------------------------------- middleware --- */

/** Attaches req.client and the site ids they are allowed to see. */
export function requireClient(req, _res, next) {
  (async () => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const claims = token && readClientToken(token);
    if (!claims) throw new HttpError(401, 'Sign in to continue.');

    const client = await db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(claims.sub);
    if (!client || client.status !== 'active') throw new HttpError(401, 'Session is no longer valid.');

    // A JWT cannot be withdrawn, so the row carries a version that the password
    // bumps and the token records. Anything issued against an older version is
    // refused, which is what makes a reset end a session already open elsewhere.
    if ((claims.v ?? 0) !== client.token_version) {
      throw new HttpError(401, 'Your password was changed. Please sign in again.');
    }

    const sites = await db
      .prepare(`SELECT site_id FROM client_sites WHERE client_user_id = ?`)
      .all(client.id);

    req.client = client;
    req.clientSiteIds = sites.map((s) => s.site_id);

    // A contact with no sites assigned would otherwise see an empty portal
    // with no explanation of why.
    if (req.clientSiteIds.length === 0) {
      throw new HttpError(403, 'No sites have been linked to your account yet. Contact your account manager.');
    }
  })().then(() => next(), next);
}

/** Strip the password material before a client record is returned. */
export function publicClient(client) {
  if (!client) return null;
  const {
    password_hash, password_salt, failed_attempts, locked_until, token_version, ...safe
  } = client;
  return { ...safe, locked: Boolean(locked_until && new Date(locked_until) > new Date()) };
}
