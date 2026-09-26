/**
 * First run: a deployment whose database has no accounts at all loads the
 * demo company, so the site can be signed in to straight away with the
 * published demo codes (1001 / 2468 and the rest).
 *
 * It only ever adds to an empty database. It never deletes or overwrites
 * anything: if a single user exists, it does nothing. The whole load runs in
 * one transaction, so a load that fails or is cut off leaves the database
 * exactly as empty as it found it. Set USC_AUTO_DEMO=off to turn it off.
 *
 * A load is claimed in app_meta before it starts, so two serverless
 * instances waking at once do not both load, and a claim left behind by a
 * load that was killed goes stale and can be taken again.
 */

import { db, migrate } from '../lib/db.js';
import { HttpError } from '../lib/http.js';

const KEY = 'demo_bootstrap';
/** Longer than the function's maxDuration, so a live load is never taken over. */
const STALE_SECONDS = 330;
/** A failed load is tried again after this long, e.g. once a fix is deployed. */
const RETRY_FAILED_SECONDS = 120;
/** How long a request waits for a load another instance is running. */
const WAIT_MS = 20000;

let settled = false;
let running = null;

const enabled = () => String(process.env.USC_AUTO_DEMO || '').toLowerCase() !== 'off';

async function state() {
  const users = Number((await db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).n);
  const meta = await db
    .prepare(
      `SELECT value, detail, EXTRACT(EPOCH FROM now() - updated_at) AS age
       FROM app_meta WHERE key = ?`
    )
    .get(KEY);
  return { users, meta };
}

/** Claim the load. Succeeds for one caller at a time. */
async function claim() {
  const row = await db
    .prepare(
      `INSERT INTO app_meta (key, value, detail, updated_at) VALUES (?, 'running', NULL, now())
       ON CONFLICT (key) DO UPDATE SET value = 'running', detail = NULL, updated_at = now()
       WHERE app_meta.value <> 'running' OR app_meta.updated_at < now() - interval '${STALE_SECONDS} seconds'
       RETURNING key`
    )
    .get(KEY);
  return Boolean(row);
}

async function mark(value, detail = null) {
  await db
    .prepare(`UPDATE app_meta SET value = ?, detail = ?, updated_at = now() WHERE key = ?`)
    .run(value, detail, KEY);
}

async function load() {
  const started = Date.now();
  // Imported here so an ordinary cold start never pays for the seed module.
  const { seedDemo } = await import('../seed-demo.js');
  try {
    // No reset: seedDemo refuses, changing nothing, if anyone is already there.
    const loaded = await db.transaction(() => seedDemo({ log: () => {} }))();
    const seconds = Math.round((Date.now() - started) / 1000);
    await mark('done', loaded ? `demo company loaded in ${seconds}s` : 'accounts already existed; nothing loaded');
    console.log(`[usc] first-run demo load finished in ${seconds}s (loaded: ${loaded})`);
  } catch (err) {
    console.error('[usc] first-run demo load failed', err);
    await mark('failed', String(err.message || err).slice(0, 1000)).catch(() => {});
    throw err;
  }
}

/**
 * Make sure the database has accounts in it before a request is served.
 * Cheap after the first call on each instance.
 */
export async function ensureStarted() {
  if (settled || !enabled()) return;
  if (running) {
    await running;
    return;
  }
  await migrate();

  for (const deadline = Date.now() + WAIT_MS; ; ) {
    const { users, meta } = await state();
    if (users > 0 || meta?.value === 'done') {
      settled = true;
      return;
    }
    if (meta?.value === 'failed' && Number(meta.age) < RETRY_FAILED_SECONDS) {
      throw new HttpError(503, `The demo company could not be loaded: ${meta.detail || 'unknown error'}`, {
        code: 'setup_failed',
      });
    }

    if (await claim()) {
      running = load().finally(() => (running = null));
      await running;
      settled = true;
      return;
    }

    // Another instance is loading. Wait a little, then tell the caller.
    if (Date.now() > deadline) {
      throw new HttpError(
        503,
        'Setting up the demo company for the first time. This takes about a minute - please try again shortly.',
        { code: 'setting_up' }
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** What /api/health reports: whether the site has accounts to sign in with. */
export async function setupStatus() {
  try {
    const { users, meta } = await state();
    return {
      accounts: users > 0,
      ...(meta ? { firstRun: meta.value, detail: meta.detail } : {}),
    };
  } catch (err) {
    return { accounts: null, detail: String(err.message || err).slice(0, 200) };
  }
}
