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

/** Naive in-memory rate limiter - enough for a single-instance deployment. */
export function rateLimit({ windowMs = 60000, max = 30, key = (req) => req.ip } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const entry = hits.get(k);
    if (!entry || now > entry.resetAt) {
      hits.set(k, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return next(new HttpError(429, 'Too many requests. Please slow down.'));
    }
    next();
  };
}
