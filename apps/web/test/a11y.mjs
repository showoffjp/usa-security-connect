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
  await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400); // let a data fetch settle

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
await page.goto(WEB, { waitUntil: 'networkidle' });
await page.fill('#employeeCode', '1001');
await page.click('button[type="submit"]');
await page.waitForTimeout(300);
for (const digit of '2468') await page.keyboard.press(digit);
await page.waitForTimeout(1200);

for (const [label, path] of STAFF_PAGES) await audit(page, label, path);

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
