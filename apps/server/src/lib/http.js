/** Small helpers shared by every route module. */

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wrap an async handler so rejected promises reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Validate a body against a zod schema, turning failures into a 422. */
export function parse(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    throw new HttpError(422, 'Please correct the highlighted fields.', details);
  }
  return result.data;
}

/** SQLite stores naive UTC strings; normalise everything through here. */
export const nowIso = () => new Date().toISOString();

/**
 * A ?date=YYYY-MM-DD parameter, read as a calendar day in the server's
 * timezone. `new Date('2026-09-22')` is UTC midnight, which is the previous
 * day's evening in Florida - so a report asked for by date would silently
 * cover the wrong 24 hours.
 *
 * Returns local midnight, or null when the value cannot be read.
 */
export function parseDay(value) {
  const day = value ? String(value).trim() : '';
  if (!day) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  }
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (parts) return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 0, 0, 0, 0);

  const parsed = new Date(day);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

/** A local calendar date as YYYY-MM-DD; toISOString would shift the day. */
export const toDateString = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Convert a SQLite "YYYY-MM-DD HH:MM:SS" (UTC) value into a real ISO string. */
export function sqlToIso(value) {
  if (!value) return null;
  // Postgres hands back timestamptz as a Date; dates as 'YYYY-MM-DD' strings.
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') return value;
  if (value.includes('T')) return value;
  if (!value.includes(':')) return value; // a plain calendar date
  return value.replace(' ', 'T') + 'Z';
}

/** Rows come back with naive timestamps; widen the listed columns to ISO. */
export function isoFields(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) if (f in out) out[f] = sqlToIso(out[f]);
  return out;
}

export const errorHandler = (err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[usc]', err);
  res.status(status).json({
    error: err.message || 'Something went wrong.',
    details: err.details,
  });
};

/**
 * Rate limiting, counted in the database.
 *
 * An in-process counter is per-instance, and a serverless deployment runs as
 * many instances as it feels like - so an attacker spreading attempts across
 * them sees no limit at all. One row per key, updated atomically, gives one
 * shared count however many instances are running.
 *
 * The update is a single statement on purpose: read-then-write would let two
 * concurrent requests both read the same count and both be allowed.
 *
 * If the database itself is unreachable the request is allowed through. That
 * is not a hole worth worrying about - the thing being protected is a login,
 * which cannot succeed without the database either.
 */
export function rateLimit({ windowMs = 60000, max = 30, key = (req) => req.ip } = {}) {
  return (req, res, next) => {
    (async () => {
      const { db } = await import('./db.js');
      const resetAt = new Date(Date.now() + windowMs).toISOString();

      const row = await db
        .prepare(
          `INSERT INTO rate_limits (key, count, reset_at)
           VALUES (?, 1, ?)
           ON CONFLICT (key) DO UPDATE SET
             count = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
             reset_at = CASE WHEN rate_limits.reset_at <= now() THEN ? ELSE rate_limits.reset_at END
           RETURNING count, reset_at`
        )
        .get(key(req), resetAt, resetAt);

      if (row && row.count > max) {
        const seconds = Math.max(1, Math.ceil((new Date(row.reset_at) - Date.now()) / 1000));
        res.setHeader('Retry-After', seconds);
        throw new HttpError(429, 'Too many requests. Please slow down.');
      }
    })().then(
      () => next(),
      (err) => {
        if (err instanceof HttpError) return next(err);
        console.error('[usc] rate limit check failed, allowing request:', err.message);
        next();
      }
    );
  };
}

/** Drop spent counters. Called by the compliance sweep. */
export async function pruneRateLimits() {
  const { db } = await import('./db.js');
  const res = await db.prepare(`DELETE FROM rate_limits WHERE reset_at <= now()`).run();
  return res?.changes ?? 0;
}
