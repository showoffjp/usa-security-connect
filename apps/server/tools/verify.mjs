/**
 * One command to prove the API works: reseed, start, run both suites, stop.
 *
 * The order matters with PGlite, which is a single-writer embedded database -
 * seeding while the server is running corrupts the data directory. Production
 * uses Neon, which has no such constraint, but the local workflow has to
 * respect it.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const PORT = process.env.PORT || 4000;
const BASE = `http://localhost:${PORT}/api`;

// The API under test and the suites must share a cron secret, or the signed
// sweep check cannot run. A throwaway one is fine: this server is local.
const env = {
  ...process.env,
  USC_PUSH_DISABLED: '1',
  USC_EMAIL_DISABLED: '1',
  PORT: String(PORT),
  CRON_SECRET: process.env.CRON_SECRET || 'verify-only-cron-secret',
  // Location reports closer together than this are thinned; two seconds lets
  // the tracking suite prove it without sitting through the real twenty.
  USC_MIN_PING_GAP_SECONDS: '2',
  // Every suite signs the same demo accounts in; together they pass the
  // production login allowance inside its five-minute window.
  USC_LOGIN_LIMIT_PER_IP: '400',
  USC_LOGIN_LIMIT_PER_CODE: '60',
};

function run(script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: serverRoot,
      env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/* ------------------------------------------------------------------------- */

const fresh = process.argv.includes('--fresh');
if (fresh) {
  const dataDir = process.env.USC_DATA_DIR || path.join(serverRoot, 'data');
  fs.rmSync(path.join(dataDir, 'pgdata'), { recursive: true, force: true });
  console.log('Removed the local database.\n');
}

// Pure unit test of the SQL translation layer. It needs no database and no
// server, and if it is wrong then every failure downstream is noise, so it
// runs first and stops the run.
console.log('1/12  SQL dialect translation\n');
const dialect = await run('test/dialect.mjs');
if (dialect !== 0) {
  console.error('\nThe SQL translation is wrong; everything downstream would be noise.');
  process.exit(1);
}

console.log('\n2/12  Seeding\n');
if ((await run('src/seed.js', ['--reset'])) !== 0) {
  console.error('\nSeeding failed.');
  process.exit(1);
}

console.log('\n3/12  Starting the API');
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: serverRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Keep the server's output so a crash is visible, without drowning the report.
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const stop = () => {
  if (!server.killed) server.kill();
};
process.on('exit', stop);
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});

if (!(await waitForHealth())) {
  console.error('\nThe API did not come up. Server output:\n');
  console.error(serverLog.split('\n').filter((l) => !l.startsWith('import{')).slice(-25).join('\n'));
  stop();
  process.exit(1);
}
console.log('     up\n');

console.log('4/12  Core suite\n');
const core = await run('test/smoke.mjs');

console.log('\n5/12  Feature suite\n');
const features = await run('test/features.mjs');

console.log('\n6/12  Shift request suite\n');
const shifts = await run('test/shifts.mjs');

console.log('\n7/12  Client portal suite\n');
const portal = await run('test/portal.mjs');

console.log('\n8/12  Invoicing suite\n');
const invoices = await run('test/invoices.mjs');

console.log('\n9/12  Email suite\n');
const email = await run('test/email.mjs');

console.log('\n10/12  Security suite\n');
const security = await run('test/security.mjs');

console.log('\n11/12  Role permission suite\n');
const roles = await run('test/roles.mjs');

console.log('\n12/12  Tracking, pay rates and reports suite\n');
const tracking = await run('test/tracking.mjs');

stop();

const failed = dialect !== 0 || core !== 0 || features !== 0 || shifts !== 0 || portal !== 0 || invoices !== 0 || email !== 0 || security !== 0 || roles !== 0 || tracking !== 0;
if (failed && serverLog.includes('error')) {
  console.error('\nServer-side errors during the run:\n');
  const lines = serverLog
    .split('\n')
    .filter((l) => /error/i.test(l) && !l.startsWith('import{'))
    .slice(0, 10);
  console.error(lines.join('\n'));
}

console.log(`\n${failed ? 'VERIFY FAILED' : 'Verified: all suites pass.'}`);
process.exit(failed ? 1 : 0);
