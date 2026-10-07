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
  // The portal suites sign the same contacts in from this one address too, and
  // exhausting that allowance made a second run fail on the limiter instead of
  // on anything real. The per-email limit is left alone, because that is the
  // one the security suite is actually measuring.
  USC_CLIENT_LOGIN_LIMIT_PER_IP: '400',
  // The hiring suite and the sweep both post to the public application form.
  USC_APPLY_LIMIT_PER_IP: '400',
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
console.log('1/42  SQL dialect translation\n');
const dialect = await run('test/dialect.mjs');
if (dialect !== 0) {
  console.error('\nThe SQL translation is wrong; everything downstream would be noise.');
  process.exit(1);
}

// Also runs before anything starts: it opens a throwaway database of its own,
// and covers the one case no HTTP suite can reach because no route passes it.
console.log('\n2/42  Flag detail encoding\n');
const flags = await run('test/flags.mjs');

// Also before anything starts, on a throwaway database: the compliance sweep's
// handling of an officer held over for a late relief.
console.log('\n3/42  Holdovers: an officer waiting for a late relief stays on the clock\n');
const holdover = await run('test/holdover.mjs');

// Also on a throwaway database, at a moment it picks: who relieves whom.
console.log('\n4/42  Handover board: where each relief stands\n');
const handoverBoard = await run('test/handover-board.mjs');

// The rest and fatigue rule, and shifts as worked, on a throwaway database.
console.log('\n5/42  Rest and fatigue rules\n');
const fatigueRules = await run('test/fatigue-rules.mjs');

console.log('\n6/42  Seeding\n');
if ((await run('src/seed.js', ['--reset'])) !== 0) {
  console.error('\nSeeding failed.');
  process.exit(1);
}

console.log('\n7/42  Starting the API');
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

console.log('8/42  Core suite\n');
const core = await run('test/smoke.mjs');

console.log('\n9/42  Feature suite\n');
const features = await run('test/features.mjs');

console.log('\n10/42  Shift request suite\n');
const shifts = await run('test/shifts.mjs');

console.log('\n11/42  Client portal suite\n');
const portal = await run('test/portal.mjs');

console.log('\n12/42  Invoicing suite\n');
const invoices = await run('test/invoices.mjs');

console.log('\n13/42  Email suite\n');
const email = await run('test/email.mjs');

console.log('\n14/42  Security suite\n');
const security = await run('test/security.mjs');

console.log('\n15/42  Role permission suite\n');
const roles = await run('test/roles.mjs');

console.log('\n16/42  Tracking, pay rates and reports suite\n');
const tracking = await run('test/tracking.mjs');

console.log('\n17/42  Keys and equipment suite\n');
const equipment = await run('test/equipment.mjs');

console.log('\n18/42  Payroll close suite\n');
const payroll = await run('test/payroll.mjs');

console.log('\n19/42  Client coverage requests and officer pay suite\n');
const requests = await run('test/requests.mjs');

console.log('\n20/42  Visitor log, pass-down notes and quick search suite\n');
const postlog = await run('test/postlog.mjs');

console.log('\n21/42  Watchlist, vehicle violations and scorecards suite\n');
const watch = await run('test/watch.mjs');

console.log('\n22/42  Activity log, building issues and lost and found suite\n');
const sitelog = await run('test/sitelog.mjs');

console.log('\n23/42  Site contacts, client feedback and CSV exports suite\n');
const contactsSuite = await run('test/contacts.mjs');

console.log('\n24/42  Post orders, alerts inbox, QR tags and incident follow-ups suite\n');
const ordersSuite = await run('test/orders.mjs');

console.log('\n25/42  Supervisor field visits suite\n');
const visitsSuite = await run('test/visits.mjs');

console.log('\n26/42  Hiring pipeline suite\n');
const hiringSuite = await run('test/hiring.mjs');

console.log('\n27/42  Dispatch: calls for service suite\n');
const dispatchSuite = await run('test/dispatch.mjs');

console.log('\n28/42  Time corrections suite\n');
const correctionsSuite = await run('test/corrections.mjs');

console.log('\n29/42  Service agreements suite\n');
const agreementsSuite = await run('test/agreements.mjs');

console.log('\n30/42  Shift confirmations suite\n');
const confirmationsSuite = await run('test/confirmations.mjs');

console.log('\n31/42  Patrol vehicles suite\n');
const vehiclesSuite = await run('test/vehicles.mjs');

console.log('\n32/42  Expense claims suite\n');
const expensesSuite = await run('test/expenses.mjs');

console.log('\n33/42  Paid time off suite\n');
const ptoSuite = await run('test/pto.mjs');

console.log('\n34/42  Commendations suite\n');
const commendationsSuite = await run('test/commendations.mjs');

console.log('\n35/42  Overtime watch suite\n');
const overtimeSuite = await run('test/overtime.mjs');

console.log('\n36/42  Holiday pay and billing suite\n');
const holidaysSuite = await run('test/holidays.mjs');

console.log('\n37/42  Client sign-off of hours suite\n');
const signoffsSuite = await run('test/signoffs.mjs');

console.log('\n38/42  Site training suite\n');
const trainingSuite = await run('test/site-training.mjs');

console.log('\n39/42  Coaching and discipline suite\n');
const conductSuite = await run('test/conduct.mjs');

console.log('\n40/42  Shift handovers suite\n');
const handoversSuite = await run('test/handovers.mjs');

console.log('\n41/42  Rest and fatigue suite\n');
const fatigueSuite = await run('test/fatigue.mjs');

// Last on purpose: it sends malformed writes to every endpoint, some of which
// change things, and it signs its own sessions out at the end.
console.log('\n42/42  Endpoint sweep: every route, every caller, good and bad input\n');
const sweepSuite = await run('test/sweep.mjs');

stop();

const failed = dialect !== 0 || holdover !== 0 || fatigueRules !== 0 || fatigueSuite !== 0 || handoverBoard !== 0 || handoversSuite !== 0 || equipment !== 0 || flags !== 0 || core !== 0 || features !== 0 || shifts !== 0 || portal !== 0 || invoices !== 0 || email !== 0 || security !== 0 || roles !== 0 || tracking !== 0 || payroll !== 0 || requests !== 0 || postlog !== 0 || watch !== 0 || sitelog !== 0 || sweepSuite !== 0 || contactsSuite !== 0 || ordersSuite !== 0 || visitsSuite !== 0 || hiringSuite !== 0 || dispatchSuite !== 0 || correctionsSuite !== 0 || agreementsSuite !== 0 || confirmationsSuite !== 0 || vehiclesSuite !== 0 || expensesSuite !== 0 || ptoSuite !== 0 || commendationsSuite !== 0 || overtimeSuite !== 0 || holidaysSuite !== 0 || signoffsSuite !== 0 || trainingSuite !== 0 || conductSuite !== 0;
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
