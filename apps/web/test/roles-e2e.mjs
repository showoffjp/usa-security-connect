/**
 * Every screen, as every kind of user.
 *
 *   node test/roles-e2e.mjs
 *
 * Signs in through the real sign-in screens as an administrator, a
 * supervisor, a W-2 officer, a 1099 contractor, an officer who must change
 * their PIN, and a client contact. For each, it opens every link their own
 * navigation offers - plus the detail pages behind them - and fails on
 * anything a user would see go wrong: a request the server refused or broke
 * on, a script error, an error banner, a blank page, or a screen they should
 * never have been offered.
 *
 * Needs the API on :4000 (freshly seeded) and the web app on :5173.
 */

import { chromium } from 'playwright';

const WEB = process.env.USC_WEB_URL || 'http://localhost:5173';

let failures = 0;
let checks = 0;
const log = (ok, label, extra = '') => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

async function launch() {
  const options = [
    ...(process.env.USC_CHROMIUM_PATH ? [{ executablePath: process.env.USC_CHROMIUM_PATH }] : []),
    { channel: 'chrome' },
    {},
  ];
  for (const o of options) {
    try {
      return await chromium.launch({ ...o, args: ['--no-sandbox'] });
    } catch {
      /* next */
    }
  }
  console.error('No Chromium-based browser available.');
  process.exit(1);
}

const browser = await launch();

/** A page that records everything that goes wrong on it. */
async function watchedPage(viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`script error: ${e.message.split('\n')[0]}`));
  page.on('response', (r) => {
    const url = r.url();
    if (!url.includes('/api/')) return;
    // 401/403 on purpose are covered by the API suites; a user's own screens
    // should never trigger them, so they count here too.
    if (r.status() >= 400) problems.push(`${r.status()} ${r.request().method()} ${url.replace(/^.*\/api/, '/api')}`);
  });
  return { context, page, problems };
}

/** Wait for a screen to settle: no spinner, and the network quiet. */
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.loading, [aria-busy="true"]'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function screenState(page) {
  return page.evaluate(() => ({
    h1: document.querySelector('h1')?.textContent?.trim() || '',
    // A red banner can be content ("2 credentials have expired"); only one that
    // reads as a failure counts.
    errorBanners: [...document.querySelectorAll('.banner-danger')]
      .map((b) => b.textContent.trim())
      .filter((t) => /error|failed|could not|couldn't|went wrong|not found|denied|unable|try again/i.test(t)),
    notFound: /not found|something went wrong/i.test(document.querySelector('main, .page, #root')?.textContent || ''),
    textLength: (document.querySelector('main, .page, #root')?.innerText || '').trim().length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
}

async function checkScreen(label, page, problems, { allowEmptyH1 = false } = {}) {
  await settle(page);
  const s = await screenState(page);
  const issues = [...problems.splice(0)];
  if (s.errorBanners.length) issues.push(`error on screen: ${s.errorBanners[0].slice(0, 120)}`);
  if (!allowEmptyH1 && !s.h1) issues.push('no heading - screen did not render');
  if (s.textLength < 40) issues.push('screen is blank');
  if (s.overflow > 1) issues.push(`scrolls sideways by ${s.overflow}px`);
  log(issues.length === 0, label, issues.length ? issues.join(' | ') : s.h1);
  return s;
}

async function navLinks(page, selector) {
  return page.evaluate((sel) => {
    const seen = new Set();
    return [...document.querySelectorAll(sel)]
      .map((a) => ({ href: a.getAttribute('href'), text: a.textContent.replace(/\s+/g, ' ').trim() }))
      .filter((l) => l.href && l.href.startsWith('/') && !seen.has(l.href) && seen.add(l.href));
  }, selector);
}

async function staffSignIn(page, code, pin) {
  await page.goto(WEB + '/', { waitUntil: 'networkidle' });
  await page.fill('#employeeCode', code);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.keypad', { timeout: 10000 });
  for (const digit of pin) await page.click(`.keypad button:text-is("${digit}")`);
  if (pin.length < 6) await page.click('button:text-is("Sign in")');
  await page.waitForTimeout(2000);
}

/** The first link on the current page that matches, for drilling into a detail screen. */
async function firstLink(page, pattern) {
  return page.evaluate((re) => {
    const rx = new RegExp(re);
    return [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).find((h) => rx.test(h)) || null;
  }, pattern);
}

/* ----------------------------------------------------------- staff tiers --- */

const STAFF = [
  { who: 'Administrator (1001)', code: '1001', pin: '2468', lands: /\/admin$/, admin: true },
  { who: 'Supervisor (1002)', code: '1002', pin: '3571', lands: /\/admin$/, admin: true, supervisor: true },
  { who: 'Officer, W-2, on duty (1003)', code: '1003', pin: '4812', lands: /\/$/ },
  { who: 'Officer, 1099 contractor (1005)', code: '1005', pin: '6174', lands: /\/$/ },
];

for (const u of STAFF) {
  console.log(`\n--- ${u.who} ---`);
  const { context, page, problems } = await watchedPage({ width: 1366, height: 900 });
  await staffSignIn(page, u.code, u.pin);
  log(u.lands.test(new URL(page.url()).pathname + ''), `${u.who} lands on the right home`, new URL(page.url()).pathname);

  if (u.admin) {
    await checkScreen(`${u.who}: dashboard`, page, problems);
    const links = await navLinks(page, '.sidebar a');
    log(links.length > 15, `${u.who} has a full admin menu`, `${links.length} items`);
    const labels = links.map((l) => l.text).join(' | ');
    if (u.supervisor) log(!/Audit log/.test(labels), 'a supervisor is not offered the audit log');
    else log(/Audit log/.test(labels), 'an administrator is offered the audit log');

    for (const l of links) {
      await page.goto(WEB + l.href);
      await checkScreen(`${u.who}: ${l.text.replace(/\s\d+$/, '')}`, page, problems);
    }

    // The detail screens behind the lists.
    for (const [list, pattern, name] of [
      ['/admin/employees', '^/admin/employees/\\d+$', 'employee record'],
      ['/admin/payroll', '^/admin/payroll/\\d+$', 'pay period'],
    ]) {
      await page.goto(WEB + list);
      await settle(page);
      const href = await firstLink(page, pattern);
      log(Boolean(href), `${u.who}: the ${name} list links to a detail page`);
      if (href) {
        await page.goto(WEB + href);
        await checkScreen(`${u.who}: ${name}`, page, problems);
      }
    }

    // Supervisors and admins can also use the officer side for their own shifts.
    await page.goto(WEB + '/');
    await checkScreen(`${u.who}: own officer home`, page, problems);
  } else {
    await checkScreen(`${u.who}: home`, page, problems);
    const links = await navLinks(page, '.tabbar a');
    log(links.length >= 4, `${u.who} has the officer tabs`, links.map((l) => l.text).join(', '));
    log(!links.some((l) => l.href.startsWith('/admin')), `${u.who} is offered nothing from the admin side`);
    for (const l of links) {
      await page.goto(WEB + l.href);
      await checkScreen(`${u.who}: ${l.text.replace(/\d+$/, '').trim()}`, page, problems);
    }
    for (const [href, name] of [['/profile', 'profile & hours'], ['/incidents/new', 'new incident form']]) {
      await page.goto(WEB + href);
      await checkScreen(`${u.who}: ${name}`, page, problems);
    }
    // Trying the admin side directly must not show it.
    await page.goto(WEB + '/admin');
    await settle(page);
    log(!/\/admin/.test(new URL(page.url()).pathname) || !(await page.locator('.sidebar').count()),
      `${u.who} cannot open the admin console by typing its address`, new URL(page.url()).pathname);
    problems.splice(0);
  }
  await context.close();
}

/* --------------------------------------------------- must change the PIN --- */

{
  console.log('\n--- Officer who must change their PIN (1007) ---');
  const { context, page, problems } = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(page, '1007', '8140');
  await settle(page);
  log(/change-pin/.test(page.url()) || /Choose your PIN/i.test(await page.textContent('body')),
    'a must-change-PIN officer is sent to choose a PIN first', new URL(page.url()).pathname);
  problems.splice(0);
  await context.close();
}

/* ---------------------------------------------------------- phone width --- */

{
  console.log('\n--- Officer on a phone (1003) ---');
  const { context, page, problems } = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(page, '1003', '4812');
  for (const href of ['/', '/schedule', '/tours', '/incidents', '/messages', '/profile']) {
    await page.goto(WEB + href);
    await checkScreen(`phone: ${href}`, page, problems);
  }
  await context.close();
}

/* --------------------------------------------------------------- client --- */

{
  console.log('\n--- Client contact (Riverfront) ---');
  const { context, page, problems } = await watchedPage({ width: 1366, height: 900 });
  await page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
  await page.fill('input[type="password"]', 'riverfront-portal-01');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  await checkScreen('client: overview', page, problems);
  const links = await navLinks(page, '.tabbar a');
  log(links.length >= 5, 'client has the portal tabs', links.map((l) => l.text).join(', '));
  for (const l of links) {
    await page.goto(WEB + l.href);
    await checkScreen(`client: ${l.text}`, page, problems);
  }
  // A client must never reach the staff app.
  await page.goto(WEB + '/admin');
  await settle(page);
  log(!(await page.locator('.sidebar').count()), 'a client cannot open the staff admin console');
  problems.splice(0);
  await context.close();
}

/* ------------------------------- a client asks, a supervisor answers --- */

{
  console.log('\n--- A client asks for coverage; a supervisor schedules it ---');
  const client = await watchedPage({ width: 390, height: 844 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
  await client.page.fill('input[type="password"]', 'riverfront-portal-01');
  await client.page.click('button[type="submit"]');
  await client.page.waitForTimeout(2000);
  await client.page.goto(WEB + '/portal/requests');
  await checkScreen('client: extra coverage form', client.page, client.problems);
  const reason = `Lobby cover for a film crew ${Date.now()}`;
  await client.page.fill('textarea', reason);
  await client.page.click('button:has-text("Send request")');
  await client.page.waitForTimeout(2000);
  log(await client.page.locator(`text=${reason}`).count() > 0, 'the request appears in the client\'s list straight away');
  log(await client.page.locator('text=Waiting for a reply').count() > 0, 'marked as waiting for a reply');
  client.problems.splice(0);

  const staff = await watchedPage({ width: 1366, height: 900 });
  await staffSignIn(staff.page, '1002', '3571');
  await staff.page.goto(WEB + '/admin/coverage-requests');
  await settle(staff.page);
  const row = staff.page.locator('li.list-item', { hasText: reason });
  log(await row.count() === 1, 'the supervisor sees it under Client requests');
  await row.locator('button:has-text("Schedule")').click();
  await staff.page.waitForSelector('.modal, [role="dialog"]');
  await staff.page.click('[role="dialog"] button:has-text("open shift")');
  await staff.page.waitForTimeout(2000);
  await checkScreen('supervisor: after scheduling a request', staff.page, staff.problems);
  await staff.page.goto(WEB + '/admin/coverage-requests');
  await settle(staff.page);
  log(!(await staff.page.locator('li.list-item', { hasText: reason }).count()), 'it leaves the waiting list');

  await client.page.reload();
  await settle(client.page);
  const mine = client.page.locator('li.list-item', { hasText: reason });
  log(await mine.locator('text=Scheduled').count() > 0, 'and the client sees it scheduled');
  await staff.context.close();
  await client.context.close();
}

await browser.close();
console.log(`\n${failures === 0 ? `Every role: all ${checks} checks passed.` : `Every role: ${failures} of ${checks} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
