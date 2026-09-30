/**
 * Data layer.
 *
 * One SQL dialect - Postgres - with two drivers behind it:
 *
 *   * **Neon** in production. Serverless, so it works inside a Vercel function
 *     where a normal connection pool would not survive between invocations.
 *   * **PGlite** locally, in tests and in CI. Postgres compiled to WebAssembly,
 *     so `npm test` needs no database server and no Docker, while still running
 *     the same SQL that production will run.
 *
 * Queries are written with `?` placeholders and converted to `$1, $2, ...`
 * here, which keeps the call sites readable and makes the driver swap invisible
 * to the rest of the codebase.
 */

import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_SQL } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
export const usingNeon = Boolean(DATABASE_URL);

/**
 * A Vercel deployment with no database configured runs as a self-contained
 * demo: each server instance keeps its own throwaway database in /tmp and
 * fills it with the demo company (see services/demoInstance.js). It never
 * connects to any shared database, and nothing in it outlives the instance.
 */
export const demoInstance = !usingNeon && Boolean(process.env.VERCEL);

/**
 * Local uploads directory. Only used when blob storage is not configured;
 * see services/storage.js.
 */
const DATA_DIR =
  process.env.USC_DATA_DIR || (demoInstance ? '/tmp/usc-demo' : path.resolve(__dirname, '../../data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

/* --------------------------------------------------------------- driver -- */

let driver = null;

async function connect() {
  if (driver) return driver;

  if (usingNeon) {
    const { Pool, types } = await import('@neondatabase/serverless');
    // COUNT() and SUM() come back as int8, which the driver hands over as a
    // string to protect precision. Our counts are shifts and minutes, nowhere
    // near 2^53, and every call site expects a number.
    types.setTypeParser(INT8_OID, (v) => (v === null ? null : Number(v)));
    types.setTypeParser(NUMERIC_OID, (v) => (v === null ? null : Number(v)));
    types.setTypeParser(DATE_OID, keepDateAsText);

    const pool = new Pool({ connectionString: DATABASE_URL });
    driver = {
      kind: 'neon',
      query: (text, params) => pool.query(text, params),
      // With no parameters, node-postgres uses the simple query protocol,
      // which accepts a multi-statement script.
      script: (text) => pool.query(text),
      close: () => pool.end(),
      // A transaction has to stay on one connection; a pool hands each query
      // to whichever connection is free.
      acquire: async () => {
        const client = await pool.connect();
        return {
          query: (text, params) => client.query(text, params),
          script: (text) => client.query(text),
          release: (err) => client.release(err),
        };
      },
    };
    return driver;
  }

  // PGlite keeps its database on disk, and a serverless bundle is read-only,
  // so falling back to it there fails deep inside mkdir with an EROFS trace
  // that says nothing about the actual mistake. Say the actual mistake.
  if (process.env.VERCEL && !demoInstance) {
    throw new Error(
      'DATABASE_URL is not set. A serverless deployment needs a hosted Postgres ' +
        '(Neon, using its pooled connection string); the local PGlite database ' +
        'cannot run on a read-only filesystem.'
    );
  }

  const { PGlite } = await import('@electric-sql/pglite');
  // A path keeps the database between runs, like the old SQLite file did.
  // `USC_PGLITE_MEMORY=1` gives each test run a clean throwaway database.
  const dir = process.env.USC_PGLITE_MEMORY === '1' ? undefined : path.join(DATA_DIR, 'pgdata');
  if (dir) fs.mkdirSync(DATA_DIR, { recursive: true });

  const pg = new PGlite(dir, {
    parsers: {
      [INT8_OID]: (v) => (v === null ? null : Number(v)),
      [NUMERIC_OID]: (v) => (v === null ? null : Number(v)),
      [DATE_OID]: keepDateAsText,
    },
  });
  await pg.waitReady;
  driver = {
    kind: 'pglite',
    query: (text, params) => pg.query(text, params),
    script: (text) => pg.exec(text),
    close: () => pg.close(),
  };
  return driver;
}

const INT8_OID = 20;
const NUMERIC_OID = 1700;
const DATE_OID = 1082;

/**
 * A `date` column is a calendar day, not an instant, but both drivers hand it
 * over as a Date object pinned to midnight in some timezone - which then
 * JSON-serialises to a full timestamp and renders as the day before for
 * anyone west of it. Licence expiry, time off, invoice periods and the daily
 * report all ride on those columns, so they are kept as 'YYYY-MM-DD' text
 * the whole way through.
 */
const keepDateAsText = (v) => {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};

/* ------------------------------------------------------------ rewriting -- */

/**
 * Convert `?` placeholders to Postgres `$n`, leaving any `?` inside a string
 * literal alone.
 */
export function toPositional(sql) {
  let out = '';
  let index = 0;
  let quote = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (quote) {
      out += ch;
      if (ch === quote) {
        // A doubled quote is an escape, not the end of the literal.
        if (sql[i + 1] === quote) {
          out += sql[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }

    out += ch === '?' ? `$${++index}` : ch;
  }
  return out;
}

/**
 * Translate the handful of SQLite-isms the queries were first written against.
 *
 * Doing it here rather than editing ~40 call sites means there is no chance of
 * missing one, and the route code stays readable either way.
 */
export function toPostgres(sql) {
  return (
    sql
      // datetime('now') -> now()
      .replace(/datetime\(\s*'now'\s*\)/gi, 'now()')
      // datetime('now', '+30 minutes') -> (now() + interval '30 minutes')
      .replace(
        /datetime\(\s*'now'\s*,\s*'([+-])\s*(\d+)\s+(\w+)'\s*\)/gi,
        (_m, sign, n, unit) => `(now() ${sign} interval '${n} ${unit}')`
      )
      // date('now') -> current_date
      .replace(/date\(\s*'now'\s*\)/gi, 'current_date')
      // date('now', '+60 days') -> (current_date + interval '60 days')
      .replace(
        /date\(\s*'now'\s*,\s*'([+-])\s*(\d+)\s+(\w+)'\s*\)/gi,
        (_m, sign, n, unit) => `(current_date ${sign} interval '${n} ${unit}')`
      )
      // date('now', '+' || ? || ' days') -> (current_date + (? || ' days')::interval)
      .replace(
        /date\(\s*'now'\s*,\s*'([+-])'\s*\|\|\s*\?\s*\|\|\s*'\s+(\w+)'\s*\)/gi,
        (_m, sign, unit) => `(current_date ${sign} (? || ' ${unit}')::interval)`
      )
      // datetime(col, '+' || other || ' minutes') -> col + (other || ' minutes')::interval
      .replace(
        /datetime\(\s*([\w.]+)\s*,\s*'\+'\s*\|\|\s*([\w.]+)\s*\|\|\s*'\s+(\w+)'\s*\)/gi,
        (_m, col, amount, unit) => `(${col} + (${amount} || ' ${unit}')::interval)`
      )
      // date(col) -> col::date
      .replace(/\bdate\(\s*([\w.]+)\s*\)/gi, '$1::date')
      // strftime('%s', x) -> EXTRACT(EPOCH FROM x). A bare placeholder has no
      // type for Postgres to infer, so it is cast explicitly.
      .replace(/strftime\(\s*'%s'\s*,\s*([^)]+)\)/gi, (_m, arg) =>
        arg.trim() === '?'
          ? 'EXTRACT(EPOCH FROM ?::timestamptz)'
          : `EXTRACT(EPOCH FROM ${arg})`
      )
      // SQLite had no boolean type, so flags were compared to 0/1. Postgres
      // has real booleans and rejects the integer comparison.
      .replace(
        new RegExp(`\\b((?:\\w+\\.)?(?:${BOOLEAN_COLUMNS.join('|')}))\\s*=\\s*([01])\\b`, 'gi'),
        (_m, col, value) => `${col} = ${value === '1' ? 'true' : 'false'}`
      )
  );
}

/**
 * Columns that are boolean in the Postgres schema. Used to rewrite the `= 1`
 * comparisons the queries were originally written with.
 */
const BOOLEAN_COLUMNS = [
  'active',
  'notify_serious_incidents',
  'notify_daily_report',
  'required',
  'requires_gps',
  'armed',
  'must_change_pin',
  'police_notified',
  'auto_closed',
  'paid',
  'exempt',
  'w9_on_file',
  'contractor_agreement_on_file',
  'requires_ack',
  'is_open',
  'available',
  'uniform_ok',
  'post_orders_reviewed',
  'equipment_ok',
  'site_secure',
  'client_visible',
  'after_hours',
];

const isInsert = (sql) => /^\s*insert\s+into/i.test(sql);
const hasReturning = (sql) => /\breturning\b/i.test(sql);

/** Join tables keyed by a composite primary key, so there is no `id` to return. */
const TABLES_WITHOUT_ID = new Set(['thread_participants', 'client_sites', 'passdown_acks', 'post_order_acks', 'alert_reads', 'client_digests']);

/** SQLite gave us `lastInsertRowid` for free; Postgres needs RETURNING. */
function withReturning(sql) {
  if (!isInsert(sql) || hasReturning(sql)) return sql;
  const table = sql.match(/insert\s+into\s+"?(\w+)"?/i)?.[1]?.toLowerCase();
  if (table && TABLES_WITHOUT_ID.has(table)) return sql;
  return `${sql.trimEnd().replace(/;\s*$/, '')} RETURNING id`;
}

/**
 * Driver errors arrive with the whole WebAssembly bundle attached, which
 * buries the useful part. Re-throw a clean error that names the problem, the
 * Postgres code and the statement.
 */
function queryError(err, sql, params) {
  const clean = new Error(
    `${err.message}
  code: ${err.code || 'n/a'}
  SQL: ${sql.replace(/\s+/g, ' ').slice(0, 300)}` +
      `
  params: ${JSON.stringify(params)?.slice(0, 200)}`
  );
  clean.code = err.code;
  clean.cause = undefined;
  return clean;
}

function bindable(params) {
  return params.map((p) => (p === undefined ? null : p));
}

/* ----------------------------------------------------------------- API --- */

/** The connection a transaction in progress is pinned to, if any. */
const pinned = new AsyncLocalStorage();
const connFor = async () => pinned.getStore() || connect();

async function run(sql, params) {
  const conn = await connFor();
  const text = toPositional(withReturning(toPostgres(sql)));
  try {
    const res = await conn.query(text, bindable(params));
    return {
      changes: res.affectedRows ?? res.rowCount ?? 0,
      // An INSERT ... ON CONFLICT DO NOTHING returns no row, which is not an error.
      lastInsertRowid: res.rows?.[0]?.id ?? null,
      rows: res.rows ?? [],
    };
  } catch (err) {
    err.message = `${err.message}\n  SQL: ${text.slice(0, 400)}`;
    throw err;
  }
}

async function all(sql, params) {
  const conn = await connFor();
  const text = toPositional(toPostgres(sql));
  try {
    const res = await conn.query(text, bindable(params));
    return res.rows ?? [];
  } catch (err) {
    err.message = `${err.message}\n  SQL: ${text.slice(0, 400)}`;
    throw err;
  }
}

const get = async (sql, params) => (await all(sql, params))[0] ?? undefined;

export const db = {
  /** Mirrors the old prepared-statement shape, but every call is awaited. */
  prepare(sql) {
    return {
      run: (...params) => run(sql, params),
      get: (...params) => get(sql, params),
      all: (...params) => all(sql, params),
    };
  },

  query: (sql, params = []) => all(sql, params),

  /** Run a multi-statement script, such as the schema file. */
  async exec(sql) {
    const conn = await connFor();
    return conn.script(toPostgres(sql));
  },

  /**
   * Run `fn` inside a transaction, rolling back if it throws.
   *
   * Returns a callable so existing `db.transaction(fn)()` call sites keep
   * working; the returned function is async.
   */
  transaction(fn) {
    return async (...args) => {
      // Inside a transaction already: join it.
      if (pinned.getStore()) return fn(...args);
      const base = await connect();
      const conn = base.acquire ? await base.acquire() : base;
      let failed = null;
      try {
        await conn.query('BEGIN');
        try {
          const result = await pinned.run(conn, () => fn(...args));
          await conn.query('COMMIT');
          return result;
        } catch (err) {
          failed = err;
          try {
            await conn.query('ROLLBACK');
          } catch {
            /* already rolled back by the server */
          }
          throw err;
        }
      } finally {
        conn.release?.(failed && /connection|terminat/i.test(String(failed.message)) ? failed : undefined);
      }
    };
  },

  async close() {
    if (!driver) return;
    await driver.close();
    driver = null;
  },
};

/* ------------------------------------------------------------ migration -- */

let migrated = null;

/** Apply the schema. Safe to call repeatedly; every statement is IF NOT EXISTS. */
export function migrate() {
  if (migrated) return migrated;
  migrated = (async () => {
    await db.exec(SCHEMA_SQL);
  })();
  return migrated;
}

/* ---------------------------------------------------------------- audit -- */

export async function audit(actorId, action, entity, entityId, detail, ip) {
  await db
    .prepare(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, ip)
       VALUES (?,?,?,?,?,?)`
    )
    .run(
      actorId ?? null,
      action,
      entity ?? null,
      entityId ?? null,
      detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
      ip ?? null
    );
}
