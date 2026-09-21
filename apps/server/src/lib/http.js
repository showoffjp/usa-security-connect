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

/** Convert a SQLite "YYYY-MM-DD HH:MM:SS" (UTC) value into a real ISO string. */
export function sqlToIso(value) {
  if (!value) return null;
  if (value.includes('T')) return value;
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
