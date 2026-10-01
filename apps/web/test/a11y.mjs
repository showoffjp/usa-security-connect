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
  ['Site health', '/admin/site-health'],
  ['Site health: one site', '/admin/site-health/1'],
  // The seed opens two weekly periods: 1 is closed, 2 has ended and is half approved.
  ['Pay period, closed', '/admin/payroll/1'],
  ['Pay period, to approve', '/admin/payroll/2'],
  ['Reports', '/admin/reports'],
  ['Report: payroll register', '/admin/reports?report=payroll'],
  ['Report: daily hours', '/admin/reports?report=daily'],
  ['Incident follow-ups', '/admin/incidents?tab=follow-ups'],
  ['Report: incidents by site', '/admin/reports?report=incidents-by-site'],
  ['Report: incidents by day', '/admin/reports?report=incidents-daily'],
  ['Field visits', '/admin/visits'],
  ['Field visits: problems', '/admin/visits?issues=1'],
  ['Report: supervisor visits', '/admin/reports?report=visits-by-site'],
  ['Invoices: client questions', '/admin/invoices?tab=questions'],
  ['Client portal: notices', '/admin/clients?tab=notices'],
  ['Hiring', '/admin/hiring'],
  ['Dispatch', '/admin/dispatch'],
  ['Dispatch: closed calls', '/admin/dispatch?view=closed'],
  ['Report: call response times', '/admin/reports?report=calls-by-site'],
  ['Timesheets: corrections', '/admin/timesheets?view=corrections'],
  ['Service agreements', '/admin/agreements'],
  ['Report: hours against agreements', '/admin/reports?report=agreement-hours'],
];

const PORTAL_PAGES = [
  ['Portal overview', '/portal'],
  ['Portal coverage', '/portal/coverage'],
  ['Portal patrols', '/portal/patrols'],
  ['Portal incidents', '/portal/incidents'],
  ['Portal coverage: coming up', '/portal/coverage?view=upcoming'],
  ['Portal daily report', '/portal/report'],
  ['Portal invoices', '/portal/invoices'],
  ['Portal coverage requests', '/portal/requests'],
  ['Portal calls', '/portal/calls'],
  ['Portal post orders', '/portal/orders'],
  ['Portal monthly report', '/portal/monthly'],
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
async function audit(page, label, path, { strictContrast = false } = {}) {
  if (path !== null) {
    await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400); // let a data fetch settle
  }

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  audited += 1;
  // Not an axe rule, but a regression it would never catch: a table without
  // one of our table classes renders with the browser's defaults. Several
  // screens shipped that way before this check existed.
  const bare = await page.evaluate(() =>
    [...document.querySelectorAll('table')].filter((t) => !t.className && t.offsetParent !== null).length
  );
  if (bare) {
    results.violations.push({ id: 'unstyled-table', help: 'A table has no class, so it renders unstyled', nodes: [{ html: '<table>' }] });
  }
  const serious = results.violations.filter((v) => strictContrast || v.id !== 'color-contrast');
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
await audit(page, 'Job application', '/apply');

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

// An applicant, with the pre-hire checklist and notes.
await page.goto(`${WEB}/admin/hiring`, { waitUntil: 'networkidle' });
await page.locator('.hiring-card').first().click();
await page.waitForSelector('[role="dialog"]:has-text("Before they can start")');
await audit(page, 'Hiring: an applicant', null);
await page.keyboard.press('Escape');

// A call on the dispatch board, with the officers who could take it and its log.
await page.goto(`${WEB}/admin/dispatch`, { waitUntil: 'networkidle' });
await page.locator('.call-list .list-item button:has-text("Open")').first().click();
await page.waitForSelector('[role="dialog"] .call-log');
await audit(page, 'Dispatch: a call', null);
await page.keyboard.press('Escape');

// Setting a site's service agreement.
await page.goto(`${WEB}/admin/agreements`, { waitUntil: 'networkidle' });
await page.locator('button[aria-label^="Edit the agreement"]').first().click();
await page.waitForSelector('[role="dialog"]');
await audit(page, 'Service agreements: edit', null);
await page.keyboard.press('Escape');

// The alerts inbox is another dialog from the top bar.
await page.click('.bell-btn');
await page.waitForSelector('.alerts-list');
await audit(page, 'Alerts inbox', null);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.keyboard.press('?');
await page.waitForSelector('text=Keyboard shortcuts');
await audit(page, 'Keyboard shortcuts', null);
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
await page.keyboard.press('Escape');

// The officer's own punches, and asking for one to be fixed.
await page.goto(`${WEB}/schedule`, { waitUntil: 'networkidle' });
await page.click('button:has-text("Worked")');
await page.waitForSelector('#punches-title');
await audit(page, 'Schedule: your punches', null);
await page.locator('.punch-row button:has-text("Fix a time")').first().click();
await page.waitForSelector('[role="dialog"]');
await audit(page, 'Schedule: fix a time', null);
await page.keyboard.press('Escape');

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
await page.goto(`${WEB}/portal`, { waitUntil: 'networkidle' });
await page.click('button[aria-label="Account menu"]');
await page.waitForSelector('text=Email me');
await audit(page, 'Portal account menu, with email settings', null);
await page.keyboard.press('Escape');
await page.goto(`${WEB}/portal/invoices`, { waitUntil: 'networkidle' });
await page.locator('li.list-item button:has-text("View")').first().click();
await page.waitForSelector('#invoice-questions-title');
await audit(page, 'Portal invoice, with questions', null);
await page.keyboard.press('Escape');
await page.goto(`${WEB}/portal/incidents`, { waitUntil: 'networkidle' });
await page.locator('button:has-text("Read")').first().click();
await page.waitForSelector('[role="dialog"] .incident-sheet', { state: 'attached' });
await audit(page, 'Portal incident report, with print', null);
await page.keyboard.press('Escape');

// --- night mode ------------------------------------------------------------
// The dark palette is ours, not the client's brand, so here colour contrast
// is held to the same line as everything else: a failure fails the run.
console.log('\n--- night mode (contrast enforced) ---');
const night = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
const nightPage = await night.newPage();
await nightPage.goto(`${WEB}/portal`, { waitUntil: 'networkidle' });
await nightPage.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
await nightPage.fill('input[type="password"]', 'riverfront-portal-01');
await nightPage.click('button[type="submit"]');
await nightPage.waitForTimeout(1200);
const theme = await nightPage.evaluate(() => document.documentElement.dataset.theme);
log(theme === 'dark', 'a device set to dark opens in night mode', theme);
for (const [label, path] of [['Portal overview', '/portal'], ['Portal monthly report', '/portal/monthly'], ['Portal post orders', '/portal/orders']]) {
  await audit(nightPage, `Night: ${label}`, path, { strictContrast: true });
}
await nightPage.evaluate(() => localStorage.clear());
await nightPage.goto(WEB, { waitUntil: 'networkidle' });
await nightPage.fill('#employeeCode', '1002');
await nightPage.click('button[type="submit"]');
await nightPage.waitForSelector('.keypad', { timeout: 10000 });
for (const digit of '3571') await nightPage.keyboard.press(digit);
await nightPage.click('button:text-is("Sign in")');
await nightPage.waitForTimeout(1500);
for (const [label, path] of [
  ['Dashboard', '/admin'], ['Post orders', '/admin/post-logs?tab=orders'], ['Schedule', '/admin/schedule'],
  ['Flags', '/admin/flags'], ['Reports', '/admin/reports'], ['Client feedback', '/admin/feedback'],
  ['Field visits', '/admin/visits'],
]) {
  await audit(nightPage, `Night: ${label}`, path, { strictContrast: true });
}
await nightPage.click('.bell-btn');
await nightPage.waitForSelector('.alerts-list');
await audit(nightPage, 'Night: Alerts inbox', null, { strictContrast: true });
await night.close();

await browser.close();

console.log(
  `\n${audited} screens audited. ${
    failures === 0 ? 'No accessibility violations.' : `${failures} SCREEN(S) WITH VIOLATIONS.`
  }`
);
process.exit(failures === 0 ? 0 : 1);
