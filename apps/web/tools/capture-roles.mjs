/**
 * Screenshot each kind of account, side by side.
 *
 *   node tools/capture-roles.mjs [outputDir]
 *
 * Signs in as an officer, a supervisor, an administrator and a client contact
 * in turn, and captures what each one actually gets. Useful for a walkthrough,
 * and a quick way to see at a glance whether a change has leaked a control
 * into a tier that should not have it.
 *
 * Needs the API on :4000 and the web app on :5173.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const WEB = process.env.USC_WEB_URL || 'http://localhost:5173';
const OUT = path.resolve(process.argv[2] || 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

async function launch() {
  for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      return await chromium.launch({ ...options, args: ['--no-sandbox'] });
    } catch {
      /* try the next one */
    }
  }
  console.error('No Chromium-based browser available. Install Chrome or Edge.');
  process.exit(1);
}

const browser = await launch();

/** A fresh context each time, so no session bleeds into the next. */
async function session() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  return { context, page: await context.newPage() };
}

async function shot(page, name, note) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  ${name}.png  ${note}`);
}

/** Sign in with an employee code and PIN, through the real keypad. */
async function staffSignIn(page, code, pin) {
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.fill('#employeeCode', code);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.keypad', { timeout: 5000 });
  for (const digit of pin) await page.click(`.keypad button:text-is("${digit}")`);
  // PINs shorter than six digits are sent with the Sign in button.
  if (pin.length < 6) await page.click('button:text-is("Sign in")');
  await page.waitForTimeout(1800);
}

/** What the navigation offers, which is the clearest summary of a tier. */
async function navigation(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.tabbar a, .sidebar a')]
      .map((a) => a.textContent.replace(/\d+\s*(needing attention|outstanding).*/, '').trim())
      .filter(Boolean)
  );
}

const summary = [];

/* ------------------------------------------------------------- officer --- */

{
  const { context, page } = await session();
  console.log('\nOFFICER - Marcus Bell, code 1003');
  await staffSignIn(page, '1003', '4812');
  await shot(page, '1-officer-home', 'their own shift: clock in/out, check-ins, tours');
  summary.push(['Officer (1003)', await navigation(page)]);

  await page.goto(`${WEB}/schedule`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await shot(page, '2-officer-schedule', 'their own roster and hours, nobody else’s');

  // The console simply is not theirs.
  await page.goto(`${WEB}/admin`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await shot(page, '3-officer-blocked-from-admin', 'the admin console refuses them by name');
  await context.close();
}

/* ---------------------------------------------------------- supervisor --- */

{
  const { context, page } = await session();
  console.log('\nSUPERVISOR - Renata Diaz, code 1002');
  await staffSignIn(page, '1002', '3571');
  await page.goto(`${WEB}/admin`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot(page, '4-supervisor-dashboard', 'the whole operation: who is on post, flags, alerts');
  summary.push(['Supervisor (1002)', await navigation(page)]);

  await page.goto(`${WEB}/admin/employees`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(page, '5-supervisor-employees', 'reads the roster - but no New employee button');

  await page.goto(`${WEB}/admin/invoices`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(page, '6-supervisor-invoices', 'sees the money, cannot raise or issue any of it');
  await context.close();
}

/* --------------------------------------------------------------- admin --- */

{
  const { context, page } = await session();
  console.log('\nADMINISTRATOR - Vince Ortega, code 1001');
  await staffSignIn(page, '1001', '2468');
  await page.goto(`${WEB}/admin/employees`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(page, '7-admin-employees', 'the same screen, now with New employee and PIN reset');
  summary.push(['Administrator (1001)', await navigation(page)]);

  await page.goto(`${WEB}/admin/invoices`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(page, '8-admin-invoices', 'Raise invoice, margin, receivables');

  await page.goto(`${WEB}/admin/clients`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(page, '9-admin-client-logins', 'creating portal logins and reset links');

  await page.goto(`${WEB}/admin/audit`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(page, '10-admin-audit', 'the audit log, which a supervisor cannot open at all');
  await context.close();
}

/* -------------------------------------------------------------- client --- */

{
  const { context, page } = await session();
  console.log('\nCLIENT CONTACT - Dana Whitfield, Riverfront Holdings');
  await page.goto(`${WEB}/portal`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
  await page.fill('input[type="password"]', 'riverfront-portal-01');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1800);
  await shot(page, '11-client-overview', 'is my property covered - and nothing about pay');
  summary.push(['Client contact', await navigation(page)]);

  await page.goto(`${WEB}/portal/coverage`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(page, '12-client-coverage', 'every shift, who stood it, when they clocked in');

  await page.goto(`${WEB}/portal/invoices`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(page, '13-client-invoices', 'their own invoices, as a printable document');
  await context.close();
}

await browser.close();

/* ------------------------------------------------------------- summary --- */

console.log('\n--- what each account is offered ---\n');
for (const [who, items] of summary) {
  console.log(`${who}: ${items.length} destinations`);
  console.log(`  ${items.join(' · ')}\n`);
}
console.log(`Screenshots in ${OUT}`);
