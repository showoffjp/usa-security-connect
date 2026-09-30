/**
 * Accessibility audit.
 *
 * Drives a real browser through every screen and runs axe-core against each
 * one. A real browser matters: the rules that catch colour contrast and
 * "is this actually visible" need layout, which a DOM-only harness cannot give.
 *
 *   npm run test:a11y --workspace @usc/web
 *
 * It expects the API on :4000 and the web app on :5173, which is what
 * `npm run dev` gives you. `tools/a11y.mjs` starts both for a one-command run.
 *
 * Playwright's own Chromium is a large download and this project does not
 * commit to it: the audit uses whichever Chromium-based browser is already on
 * the machine, and says clearly when it cannot find one.
 */

import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const WEB = process.env.USC_WEB_URL || 'http://localhost:5173';

/** Screens worth auditing, and how to reach each one. */
const STAFF_PAGES = [
  ['Officer home', '/'],
  ['Officer schedule', '/schedule'],
  ['Officer incidents', '/incidents'],
  ['New incident', '/incidents/new'],
  ['Officer tours', '/tours'],
  ['Officer updates', '/messages'],
  ['Officer profile', '/profile'],
  ['Admin dashboard', '/admin'],
  ['Employees', '/admin/employees'],
  ['Schedule', '/admin/schedule'],
  ['Shift requests', '/admin/shift-requests'],
  ['Timesheets', '/admin/timesheets'],
  ['Time off', '/admin/time-off'],
  ['Licensing', '/admin/compliance'],
  ['Invoices', '/admin/invoices'],
  ['Client portal admin', '/admin/clients'],
  ['Outbox', '/admin/emails'],
  ['Daily report', '/admin/dar'],
  ['Flags', '/admin/flags'],
  ['Incidents', '/admin/incidents'],
  ['Sites & posts', '/admin/sites'],
  ['Tours', '/admin/tours'],
  ['Broadcasts', '/admin/broadcasts'],
  ['Training', '/admin/training'],
  ['Audit log', '/admin/audit'],
  ['Safety & map', '/admin/safety'],
  ['Live tracking', '/admin/live'],
  ['Punch log', '/admin/punches'],
  ['Pay rates', '/admin/pay-rates'],
  ['Payroll', '/admin/payroll'],
  ['Client requests', '/admin/coverage-requests'],
  ['Post logs: visitors', '/admin/post-logs'],
  ['Post logs: pass-down', '/admin/post-logs?tab=passdown'],
  ['Post logs: watchlist', '/admin/post-logs?tab=watchlist'],
  ['Post logs: vehicles', '/admin/post-logs?tab=vehicles'],
  ['Post logs: activity', '/admin/post-logs?tab=activity'],
  ['Post logs: building issues', '/admin/post-logs?tab=issues'],
  ['Post logs: lost and found', '/admin/post-logs?tab=found'],
  ['Post logs: site contacts', '/admin/post-logs?tab=contacts'],
  ['Post logs: post orders', '/admin/post-logs?tab=orders'],
  ['Checkpoint QR tags', '/admin/tours/1/tags'],
  ['Client feedback', '/admin/feedback'],
  ['Officer scorecards', '/admin/scorecards'],
  // The seed opens two weekly periods: 1 is closed, 2 has ended and is half approved.
  ['Pay period, closed', '/admin/payroll/1'],
  ['Pay period, to approve', '/admin/payroll/2'],
  ['Reports', '/admin/reports'],
  ['Report: payroll register', '/admin/reports?report=payroll'],
  ['Report: daily hours', '/admin/reports?report=daily'],
];

const PORTAL_PAGES = [
  ['Portal overview', '/portal'],
  ['Portal coverage', '/portal/coverage'],
  ['Portal patrols', '/portal/patrols'],
  ['Portal incidents', '/portal/incidents'],
  ['Portal daily report', '/portal/report'],
  ['Portal invoices', '/portal/invoices'],
  ['Portal coverage requests', '/portal/requests'],
  ['Portal post orders', '/portal/orders'],
];

let failures = 0;
let audited = 0;
const log = (ok, label, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

/** Whichever Chromium-based browser this machine already has. */
async function launch() {
  const attempts = [
    // An explicit browser, for a machine whose Chromium is not where
    // Playwright expects its own (a CI image, a pinned container).
    ...(process.env.USC_CHROMIUM_PATH ? [{ executablePath: process.env.USC_CHROMIUM_PATH }] : []),
    { channel: 'chrome' },
    { channel: 'msedge' },
    {}, // Playwright's own download, if someone has run `playwright install`
  ];
  const problems = [];
  for (const options of attempts) {
    try {
      return await chromium.launch({ ...options, args: ['--no-sandbox'] });
    } catch (err) {
      problems.push(`${options.channel || 'bundled'}: ${err.message.split('\n')[0]}`);
    }
  }
  console.error(
    'No Chromium-based browser could be launched. Install Chrome or Edge, or run\n' +
      '`npx playwright install chromium`.\n\n' +
      problems.map((p) => `  - ${p}`).join('\n')
  );
  process.exit(1);
}

/**
 * Audit one page.
 *
 * Colour contrast is reported but not failed on: the brand palette is the
 * client's and is not ours to change on a test's say-so. Everything else -
 * a missing label, an unnamed control, a bad role - is a defect.
 */
async function audit(page, label, path) {
  if (path !== null) {
    await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400); // let a data fetch settle
  }

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  audited += 1;
  const serious = results.violations.filter((v) => v.id !== 'color-contrast');
  const contrast = results.violations.filter((v) => v.id === 'color-contrast');

  log(
    serious.length === 0,
    label,
    serious.length === 0
      ? contrast.length > 0
        ? `(${contrast.length} contrast note${contrast.length === 1 ? '' : 's'})`
        : ''
      : serious.map((v) => `${v.id} x${v.nodes.length}`).join(', ')
  );

  for (const v of serious) {
    console.log(`        ${v.id}: ${v.help}`);
    for (const node of v.nodes.slice(0, 3)) {
      console.log(`          ${node.html.slice(0, 110)}`);
    }
  }
}

/* ------------------------------------------------------------------ run --- */

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

console.log(`Auditing ${WEB}\n`);

// --- unauthenticated screens ---------------------------------------------
console.log('--- sign-in screens ---');
await audit(page, 'Staff sign-in', '/');
await audit(page, 'Portal sign-in', '/portal');
await audit(page, 'Set password (bad link)', '/portal/set-password?token=nope');

// --- staff ----------------------------------------------------------------
console.log('\n--- officer and admin ---');
/**
 * Sign in through the real screen. A four-digit PIN needs the Sign in press
 * (PINs may be up to six), and the audit refuses to go on if it is still
 * looking at the sign-in screen - otherwise every "staff" page below would
 * quietly be the sign-in page again, audited forty times over.
 */
async function staffSignIn(code, pin) {
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.fill('#employeeCode', code);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.keypad', { timeout: 10000 });
  for (const digit of pin) await page.keyboard.press(digit);
  if (pin.length < 6) await page.click('button:text-is("Sign in")');
  await page.waitForTimeout(1500);
  if (await page.locator('#employeeCode, .keypad').count()) {
    console.error(`Could not sign in as ${code}; stopping rather than auditing the sign-in screen.`);
    process.exit(1);
  }
}

await staffSignIn('1001', '2468');

for (const [label, path] of STAFF_PAGES) await audit(page, label, path);

// The quick search is a dialog over whatever screen is open; audit it as it
// stands with results showing. A null path audits the page as it is.
await page.goto(`${WEB}/admin`, { waitUntil: 'networkidle' });
await page.waitForSelector('.sidebar');
await page.keyboard.press('Control+k');
await page.fill('[role="combobox"]', 'bell');
await page.waitForTimeout(800);
await audit(page, 'Quick search, with results', null);
await page.keyboard.press('Escape');

// The alerts inbox is another dialog from the top bar.
await page.click('.bell-btn');
await page.waitForSelector('.alerts-list');
await audit(page, 'Alerts inbox', null);
await page.keyboard.press('Escape');

// An officer on post, for the post log with visitors and notes in it.
await page.evaluate(() => localStorage.removeItem('usc.token'));
await staffSignIn('1003', '4812');
// Marcus's post orders changed two days ago and he has not read them yet.
await page.waitForSelector('#orders-title');
await audit(page, 'Officer home, with new post orders', null);
await audit(page, 'Post log: pass-down', '/post-log');
await audit(page, 'Post log: visitors', '/post-log?tab=visitors');
await page.click('text=Sign someone in');
await page.waitForTimeout(300);
await audit(page, 'Post log: sign-in dialog', null);
await page.getByLabel('Full name').fill('Kyle Banner');
await page.getByLabel('Here for').fill('Meeting');
await page.click('[role="dialog"] button:has-text("Sign in")');
await page.waitForSelector('text=matches the watchlist');
await audit(page, 'Post log: watchlist match', null);
await audit(page, 'Post log: vehicles', '/post-log?tab=vehicles');
await audit(page, 'Post log: watchlist', '/post-log?tab=watchlist');
await audit(page, 'Post log: activity', '/post-log?tab=activity');
await audit(page, 'Post log: lost and found', '/post-log?tab=found');
await audit(page, 'Post log: building issues', '/post-log?tab=issues');
await page.click('button:has-text("Report issue")');
await page.waitForSelector('[role="dialog"]');
await audit(page, 'Post log: report an issue', null);

// --- client portal --------------------------------------------------------
console.log('\n--- client portal ---');
await context.clearCookies();
await page.goto(`${WEB}/portal`, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.removeItem('usc.token'));
await page.goto(`${WEB}/portal`, { waitUntil: 'networkidle' });
await page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
await page.fill('input[type="password"]', 'riverfront-portal-01');
await page.click('button[type="submit"]');
await page.waitForTimeout(1200);

for (const [label, path] of PORTAL_PAGES) await audit(page, label, path);

await browser.close();

console.log(
  `\n${audited} screens audited. ${
    failures === 0 ? 'No accessibility violations.' : `${failures} SCREEN(S) WITH VIOLATIONS.`
  }`
);
process.exit(failures === 0 ? 0 : 1);
