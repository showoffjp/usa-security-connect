/**
 * The self-contained demo: a Vercel deployment with no database configured.
 *
 * Each server instance gets its own throwaway database in /tmp (db.js) and
 * fills it with the demo company the first time it is asked for anything, so
 * the published demo sign-ins (1001 / 2468 and the rest) work. Nothing here
 * can reach a shared database: it only runs when none is configured.
 *
 * Instances do not share data, so a change made on one may not show on the
 * next request. That is the price of needing no database at all; a real
 * deployment sets DATABASE_URL and never comes here.
 */

import { db, migrate, demoInstance } from '../lib/db.js';

let ready = null;

async function fill() {
  await migrate();
  const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
  if (Number(n) > 0) return;
  const started = Date.now();
  const { seedDemo } = await import('../seed-demo.js');
  await seedDemo({ log: () => {} });
  // Nobody is forced to change a published PIN here; see routes/auth.js.
  await db.prepare(`UPDATE users SET must_change_pin = false`).run();
  console.log(`[usc] demo instance filled in ${Date.now() - started} ms`);
}

/** Resolves once this instance's demo company is loaded. A no-op elsewhere. */
export function ensureDemoInstance() {
  if (!demoInstance) return Promise.resolve();
  ready ??= fill().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}
