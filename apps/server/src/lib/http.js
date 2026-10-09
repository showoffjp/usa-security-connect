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

/* ------------------------------------------------ query parameters --- */

// Anything in a query string is whatever the address bar held: a bookmark
// from last year, a hand-edited link, a probe. These read the common kinds
// and refuse nonsense with a 422 rather than letting it reach the database.

/** An id, or null when absent. Anything but a positive whole number is refused. */
export function idParam(value, what = 'id') {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(422, `That ${what} is not valid.`);
  return n;
}

/** A page size: the default when absent or silly, never more than the cap. */
export function limitParam(value, fallback, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** A date or date-time, or the fallback when absent. An unreadable one is refused. */
export function dateParam(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  // A bare calendar date is that local day, as everywhere else: new Date()
  // would read it as UTC midnight, the evening before west of UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return parseDay(String(value));
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new HttpError(422, 'That date is not valid.');
  return d;
}

/* --------------------------------------------------------------- CSV --- */

/** One CSV cell. A leading = + - @ is neutralised so a spreadsheet does not run it. */
export const csvCell = (v) => {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * Send rows as a CSV download. Columns are [header, key or row => value].
 * The byte-order mark makes Excel read the file as UTF-8.
 */
export function sendCsv(res, filename, columns, rows) {
  const lines = [columns.map(([label]) => csvCell(label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(([, get]) => csvCell(typeof get === 'function' ? get(row) : row[get])).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '-')}.csv"`);
  res.send(`\uFEFF${lines.join('\r\n')}`);
}

/* ------------------------------------------------------------ errors --- */

// Postgres codes that mean "a value in the request was the wrong shape" -
// a word where a number goes, a date that is not one, a negative LIMIT.
// The request was at fault, not the server, and the caller should hear so.
const BAD_INPUT_CODES = new Set(['22P02', '22007', '22008', '22003', '2201W', '2201X', '22023']);

export const errorHandler = (err, req, res, _next) => {
  let status = err.status || 500;
  let message = err.message || 'Something went wrong.';
  if (!err.status && (BAD_INPUT_CODES.has(err.code) || (err instanceof RangeError && /time value/i.test(err.message)))) {
    status = 422;
    message = 'One of the values in that request is not valid.';
  }
  if (status >= 500) {
    console.error('[usc]', err);
    // An unexpected failure's message can carry the SQL statement and its
    // parameters. That belongs in the server log, not in the response to
    // whoever triggered it. A deliberate HttpError keeps its wording.
    if (!(err instanceof HttpError) && process.env.NODE_ENV === 'production') {
      message = 'Something went wrong on our side. It has been logged; please try again.';
    }
  }
  res.status(status).json({ error: message, details: err.details });
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
