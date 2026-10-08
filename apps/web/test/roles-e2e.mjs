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
      return await chromium.launch({
        ...o,
        args: ['--no-sandbox'],
        // To run against a deployed site from behind a proxy.
        ...(process.env.USC_BROWSER_PROXY ? { proxy: { server: process.env.USC_BROWSER_PROXY } } : {}),
      });
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
  // USC_BROWSER_TZ runs every screen in another time zone (the live demo is in New York).
  const context = await browser.newContext({
    viewport,
    ignoreHTTPSErrors: Boolean(process.env.USC_BROWSER_PROXY),
    ...(process.env.USC_BROWSER_TZ ? { timezoneId: process.env.USC_BROWSER_TZ } : {}),
  });
  const page = await context.newPage();
  // A flaky network (a proxy, a phone tether) drops the odd page load; retry
  // those rather than report the site broken. A real error still fails.
  const goto = page.goto.bind(page);
  page.goto = async (url, options) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await goto(url, { timeout: 60000, ...options });
      } catch (err) {
        if (attempt >= 4 || !/net::ERR_(TOO_MANY_RETRIES|CONNECTION|TIMED_OUT|NETWORK)/.test(err.message)) throw err;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  };
  const problems = [];
  page.on('pageerror', (e) => problems.push(`script error: ${e.message.split('\n')[0]}`));
  page.on('requestfailed', (r) => {
    // Only the app's own API: a dropped map tile is not the site's fault.
    if (r.url().includes('/api/') && !/ERR_ABORTED/.test(r.failure()?.errorText || '')) {
      problems.push(`request failed: ${r.url().replace(/^.*\/api/, '/api')} ${r.failure()?.errorText}`);
    }
  });
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
  // The demo site clears the flag - its published PINs never change - so
  // there 1007 goes straight in like everyone else.
  const demo = await page.request.get(WEB + '/api/health').then((r) => r.json()).then((d) => Boolean(d.demo), () => false);
  await staffSignIn(page, '1007', '8140');
  await settle(page);
  const forced = /change-pin/.test(page.url()) || /Choose your PIN/i.test(await page.textContent('body'));
  if (demo) log(!forced, 'on the demo site the new hire signs straight in', new URL(page.url()).pathname);
  else log(forced, 'a must-change-PIN officer is sent to choose a PIN first', new URL(page.url()).pathname);
  problems.splice(0);
  await context.close();
}

/* ----------------------- an officer signing in on a tab left at /admin --- */

{
  console.log('\n--- Officer signs in on a tab left at an admin address ---');
  const { context, page, problems } = await watchedPage({ width: 1366, height: 900 });
  // A supervisor's tab, signed out, still at /admin/live - then 1003 signs in.
  await page.goto(WEB + '/admin/live', { waitUntil: 'networkidle' });
  await page.fill('#employeeCode', '1003');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.keypad', { timeout: 10000 });
  for (const digit of '4812') await page.click(`.keypad button:text-is("${digit}")`);
  await page.click('button:text-is("Sign in")');
  await page.waitForTimeout(2500);
  const body = await page.textContent('body');
  log(new URL(page.url()).pathname === '/' && !/Admin access only/.test(body), 'the officer lands on their own home, not an admin dead end',
    new URL(page.url()).pathname);
  await page.goto(WEB + '/admin/payroll');
  await settle(page);
  log(new URL(page.url()).pathname === '/', 'and an admin link sends them home too', new URL(page.url()).pathname);
  await checkScreen('officer: home after an admin address', page, problems);
  await context.close();
}

/* ---------------------------------------------------------- phone width --- */

{
  console.log('\n--- Officer on a phone (1003) ---');
  const { context, page, problems } = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(page, '1003', '4812');
  for (const href of ['/', '/schedule', '/tours', '/incidents', '/messages', '/profile', '/post-log']) {
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

/* ------------------------ an officer logs a visitor; everyone sees it --- */

{
  console.log('\n--- An officer on post signs a visitor in; supervisor and client see it ---');
  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1003', '4812');
  await settle(officer.page);
  log(await officer.page.locator('a[href="/post-log"]').count() > 0, 'the officer home links to the post log');
  await officer.page.goto(WEB + '/post-log');
  await checkScreen('officer: post log', officer.page, officer.problems);
  const gotIt = officer.page.locator('button:has-text("Got it")');
  const unread = await gotIt.count();
  if (unread > 0) {
    await gotIt.first().click();
    await officer.page.waitForTimeout(1200);
    log(await gotIt.count() === unread - 1, 'acknowledging a pass-down note clears it', `${unread} -> ${await gotIt.count()}`);
  } else {
    log(true, 'no pass-down notes waiting (already read)');
  }

  await officer.page.goto(WEB + '/post-log?tab=visitors');
  await settle(officer.page);
  const visitor = `E2E Visitor ${Date.now() % 100000}`;
  await officer.page.click('button:has-text("Sign someone in")');
  await officer.page.waitForSelector('[role="dialog"]');
  await officer.page.fill('[role="dialog"] input >> nth=0', visitor);
  await officer.page.getByLabel('Here for').fill('Elevator inspection');
  await officer.page.getByLabel('Plate').fill('e2e 123');
  await officer.page.click('[role="dialog"] button:has-text("Sign in")');
  await officer.page.waitForTimeout(1500);
  log(await officer.page.locator('li.list-item', { hasText: visitor }).count() === 1, 'the visitor shows as on site');
  await checkScreen('officer: visitor log', officer.page, officer.problems);

  const staff = await watchedPage({ width: 1366, height: 900 });
  await staffSignIn(staff.page, '1002', '3571');
  await staff.page.goto(WEB + '/admin/post-logs');
  await settle(staff.page);
  log(await staff.page.locator('tr', { hasText: visitor }).count() === 1, 'the supervisor sees them inside, under Post logs');

  // Quick search: Ctrl+K, a surname, Enter.
  await staff.page.keyboard.press('Control+k');
  await staff.page.fill('[role="combobox"]', 'bell');
  await staff.page.waitForSelector('[role="option"]:has-text("Marcus Bell")');
  await staff.page.keyboard.press('Enter');
  await settle(staff.page);
  log(/\/admin\/employees\/\d+/.test(staff.page.url()) && (await staff.page.locator('h1').textContent()).includes('Marcus'),
    'quick search finds an officer and opens their record', new URL(staff.page.url()).pathname);

  const client = await watchedPage({ width: 1366, height: 900 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
  await client.page.fill('input[type="password"]', 'riverfront-portal-01');
  await client.page.click('button[type="submit"]');
  await client.page.waitForTimeout(2000);
  await client.page.goto(WEB + '/portal/report');
  await settle(client.page);
  log(await client.page.locator('li.list-item', { hasText: visitor }).count() === 1, "the client sees the visitor in today's daily report");

  // The watchlist: a listed name is stopped at the desk.
  await officer.page.click('button:has-text("Sign someone in")');
  await officer.page.waitForSelector('[role="dialog"]');
  await officer.page.getByLabel('Full name').fill('Kyle Banner');
  await officer.page.getByLabel('Here for').fill('Says he has a meeting');
  await officer.page.click('[role="dialog"] button:has-text("Sign in")');
  await officer.page.waitForTimeout(1200);
  log(await officer.page.locator('[role="dialog"]:has-text("matches the watchlist")').count() === 1,
    'a watchlisted name is stopped with the instruction to follow');
  log(await officer.page.locator('[role="dialog"] button:has-text("Sign in anyway")').isDisabled(),
    'and cannot be waved through without a reason');
  await officer.page.click('[role="dialog"] button:has-text("Do not sign in")');
  officer.problems.splice(0); // the 409 above is the refusal being tested, not a fault

  // A vehicle violation, then the plate's history.
  await officer.page.goto(WEB + '/post-log?tab=vehicles');
  await settle(officer.page);
  const plate = `E2E${Date.now() % 10000}`;
  await officer.page.click('button:has-text("Log violation")');
  await officer.page.waitForSelector('[role="dialog"]');
  await officer.page.locator('[role="dialog"]').getByLabel('Plate').fill(plate);
  await officer.page.getByLabel('Where').fill('Fire lane, east door');
  await officer.page.click('[role="dialog"] button:has-text("Log violation")');
  await officer.page.waitForTimeout(1500);
  log(await officer.page.locator('li.list-item', { hasText: plate }).count() === 1, 'a vehicle violation is logged');
  await checkScreen('officer: vehicles', officer.page, officer.problems);
  await officer.page.fill('#plate-lookup', 'GHT 4410');
  await officer.page.click('button:has-text("Check")');
  await officer.page.waitForTimeout(1200);
  log(await officer.page.locator('text=Repeat offender').count() > 0, 'looking up a plate with a history flags a repeat offender');
  await officer.page.goto(WEB + '/post-log?tab=visitors');
  await settle(officer.page);

  // The activity log, a building issue and a found item.
  const entry = `E2E rounds complete ${Date.now() % 100000}`;
  await officer.page.goto(WEB + '/post-log?tab=activity');
  await settle(officer.page);
  await officer.page.click('button[aria-pressed]:has-text("Patrol")');
  await officer.page.fill('#activity-body', entry);
  await officer.page.click('button:has-text("Log it")');
  await officer.page.waitForTimeout(1200);
  log(await officer.page.locator('li.list-item', { hasText: entry }).count() === 1, 'an activity entry is logged');
  await checkScreen('officer: activity log', officer.page, officer.problems);

  const issueText = `E2E light out in stairwell ${Date.now() % 100000}`;
  await officer.page.goto(WEB + '/post-log?tab=issues');
  await settle(officer.page);
  await officer.page.click('button:has-text("Report issue")');
  await officer.page.waitForSelector('[role="dialog"]');
  await officer.page.getByLabel('What is wrong').fill(issueText);
  await officer.page.click('[role="dialog"] button:has-text("Report it")');
  await officer.page.waitForTimeout(1200);
  log(await officer.page.locator('li.list-item', { hasText: issueText }).count() === 1, 'a building issue is reported');

  const itemText = `E2E black umbrella ${Date.now() % 100000}`;
  await officer.page.goto(WEB + '/post-log?tab=found');
  await settle(officer.page);
  await officer.page.click('button:has-text("Log item")');
  await officer.page.waitForSelector('[role="dialog"]');
  await officer.page.getByRole('textbox', { name: 'Item' }).fill(itemText);
  await officer.page.getByLabel('Kept where').fill('Security desk');
  await officer.page.click('[role="dialog"] button:has-text("Log item")');
  await officer.page.waitForTimeout(1200);
  const itemRow = officer.page.locator('li.list-item', { hasText: itemText });
  await itemRow.locator('button:has-text("Hand back")').click();
  await officer.page.waitForSelector('[role="dialog"]');
  await officer.page.getByLabel('Collected by').fill('Pat Owner');
  await officer.page.getByLabel('Phone or ID checked').fill('(904) 555-0101');
  await officer.page.click('[role="dialog"] button:has-text("Returned")');
  await officer.page.waitForTimeout(1200);
  log(await itemRow.locator('text=Returned').count() === 1, 'a found item is logged and handed back');

  // The client sees the entry in the report and closes the issue from the overview.
  await client.page.goto(WEB + '/portal/report');
  await settle(client.page);
  log(await client.page.locator('li.list-item', { hasText: entry }).count() === 1, "the client sees the officer's entry in the daily report");
  await client.page.goto(WEB + '/portal');
  await settle(client.page);
  const issueRow = client.page.locator('li.list-item', { hasText: issueText });
  log(await issueRow.count() === 1, 'the client sees the building issue on their overview');
  await issueRow.locator('button:has-text("Update")').click();
  await issueRow.locator('input').fill('Maintenance replaced the bulb.');
  await issueRow.locator('button:has-text("It is fixed")').click();
  await client.page.waitForTimeout(1200);
  log(await client.page.locator('li.list-item', { hasText: issueText }).count() === 0, 'and marks it fixed');
  await officer.page.goto(WEB + '/post-log?tab=issues');
  await settle(officer.page);
  log(await officer.page.locator('li.list-item', { hasText: issueText }).locator('text=replaced the bulb').count() === 1,
    "the officer on post sees the client's reply");
  // The client rates the month; a supervisor sees it with the comment.
  const praise = `E2E great month ${Date.now() % 100000}`;
  await client.page.goto(WEB + '/portal');
  await settle(client.page);
  await client.page.click('[role="radio"][aria-label="4 stars"]');
  await client.page.fill('#feedback-comment', praise);
  await client.page.click('button:has-text("rating")');
  await client.page.waitForTimeout(1500);
  log(await client.page.locator('text=account manager sees this').count() === 1, 'the client rates the month from the portal');
  await staff.page.goto(WEB + '/admin/feedback');
  await settle(staff.page);
  log(await staff.page.locator(`text=${praise}`).count() === 1, 'and a supervisor sees the rating and comment');
  await checkScreen('supervisor: client feedback', staff.page, staff.problems);

  // Site contacts, one tap from the officer's home screen.
  await officer.page.goto(WEB + '/');
  await settle(officer.page);
  log(await officer.page.locator('a[href^="tel:"]').count() >= 2, 'the officer home has the site contacts, tap to call');

  // Post orders: the officer reads the changed orders; a supervisor issues
  // another version and the officer is asked to read that one too.
  const ordersCard = officer.page.locator('#orders-title');
  if (await ordersCard.count()) {
    await officer.page.click('button:has-text("I have read these orders")');
    await officer.page.waitForTimeout(1200);
    log(await ordersCard.count() === 0, 'the officer acknowledges their changed post orders');
  } else {
    log(true, 'post orders already acknowledged (rerun)');
  }
  await staff.page.goto(WEB + '/admin/post-logs?tab=orders');
  await settle(staff.page);
  const lobbyRow = staff.page.locator('li.list-item', { hasText: 'RF-01' });
  log(await lobbyRow.count() === 1, 'a supervisor sees the post orders for every post');
  await checkScreen('supervisor: post orders', staff.page, staff.problems);
  const change = `E2E change ${Date.now() % 100000}`;
  await lobbyRow.locator('button:text-is("New version")').click();
  await staff.page.waitForSelector('[role="dialog"] textarea');
  const current = await staff.page.locator('[role="dialog"] textarea').inputValue();
  await staff.page.locator('[role="dialog"] textarea').fill(`${current}\n${change}: radio check on the hour.`);
  await staff.page.getByLabel('What changed').fill(change);
  await staff.page.click('[role="dialog"] button:has-text("Issue version")');
  await staff.page.waitForTimeout(1500);
  log(await staff.page.locator('li.list-item', { hasText: 'RF-01' }).locator('text=Marcus Bell has not read it').count() === 1,
    'issues a new version, and sees who has not read it');
  await officer.page.goto(WEB + '/');
  await settle(officer.page);
  log(await officer.page.locator('text=Your post orders have changed').count() === 1 && await officer.page.locator(`text=${change}`).count() > 0,
    'the officer is told their orders changed, and what changed');
  await officer.page.click('button:has-text("I have read these orders")');
  await officer.page.waitForTimeout(1200);
  log(await ordersCard.count() === 0, 'and acknowledges the new version');

  // The alerts inbox: a bell with the unread count; an alert opens its screen.
  const bell = staff.page.locator('.bell-btn');
  log(/unread/.test((await bell.getAttribute('aria-label')) || ''), 'the supervisor has unread alerts on the bell');
  await bell.click();
  await staff.page.waitForSelector('.alerts-list');
  const before = staff.page.url();
  await staff.page.locator('.alerts-list button').first().click();
  await staff.page.waitForTimeout(1200);
  log(staff.page.url() !== before && /\/admin(\/|#)/.test(staff.page.url()), 'opening an alert goes to where it is dealt with', new URL(staff.page.url()).pathname);
  await checkScreen('supervisor: screen opened from an alert', staff.page, staff.problems);

  // Printable QR tags for a tour's checkpoints.
  await staff.page.goto(WEB + '/admin/tours?tab=templates');
  await settle(staff.page);
  await staff.page.locator('a:has-text("QR tags")').first().click();
  await staff.page.waitForSelector('.qr-img svg', { timeout: 10000 });
  const tags = await staff.page.locator('.qr-tag').count();
  log(tags > 0 && (await staff.page.locator('.qr-img svg').count()) === tags, 'a supervisor prints a QR tag for every checkpoint', `${tags} tags`);
  await checkScreen('supervisor: checkpoint QR tags', staff.page, staff.problems);

  // A client asks for a change to a post's orders; a supervisor declines it
  // with a reason, which the client reads in the portal.
  const ask = `E2E ask ${Date.now() % 100000}: walk the roof deck hourly.`;
  await client.page.goto(WEB + '/portal/orders');
  await settle(client.page);
  await checkScreen('client: post orders', client.page, client.problems);
  const clientPost = client.page.locator('li.list-item', { hasText: 'RF-02' });
  await clientPost.locator('button:has-text("Ask for a change")').click();
  await clientPost.locator('textarea').fill(ask);
  await clientPost.locator('button:has-text("Send request")').click();
  await client.page.waitForTimeout(1200);
  log(await clientPost.locator(`text=${ask}`).count() === 1, 'a client asks for a change to the post orders');
  await staff.page.goto(WEB + '/admin/post-logs?tab=orders');
  await settle(staff.page);
  const staffRequest = staff.page.locator('.order-request', { hasText: ask });
  log(await staffRequest.count() === 1, 'the supervisor sees the request under Post orders');
  await staffRequest.locator('button:has-text("Decline")').click();
  await staff.page.locator('[role="dialog"] textarea').fill('The roof deck is outside the contracted area; we will send a quote.');
  await staff.page.click('[role="dialog"] button:has-text("Decline and reply")');
  await staff.page.waitForTimeout(1200);
  await client.page.reload();
  await settle(client.page);
  log(await client.page.locator('li', { hasText: ask }).locator('text=Not changed').count() >= 1, 'and the client reads the answer');

  // The month on a page, from the daily report.
  await client.page.goto(WEB + '/portal/report');
  await settle(client.page);
  await client.page.click('a:has-text("Monthly report")');
  await client.page.waitForSelector('text=Coverage by post', { timeout: 10000 });
  log(/\d/.test(await client.page.locator('.stat').first().innerText()), 'the client opens the monthly service report');
  await checkScreen('client: monthly report', client.page, client.problems);

  // Clocking out opens "Before you go": the shift so far and a nudge to
  // leave a pass-down note. Staying on post closes it without clocking out.
  await officer.page.goto(WEB + '/');
  await settle(officer.page);
  await officer.page.locator('[role="button"][aria-label="Slide to clock out"]').press('Enter');
  await officer.page.waitForSelector('[role="dialog"]:has-text("Before you go")', { timeout: 10000 });
  await officer.page.waitForSelector('[role="dialog"] dl.kv', { timeout: 10000 });
  log(await officer.page.locator('[role="dialog"] dt:has-text("Visitors")').count() === 1, 'clocking out shows the officer what their shift did');
  log(await officer.page.locator('[role="dialog"] textarea').count() === 1, 'and suggests a pass-down note for the next shift');
  await checkScreen('officer: before you go', officer.page, officer.problems);
  await officer.page.click('[role="dialog"] button:has-text("Stay on post")');
  await officer.page.waitForTimeout(500);
  log(await officer.page.locator('[aria-label="Slide to clock out"]').count() === 1, 'staying on post leaves them clocked in');

  // Site health: every property's month, worst first.
  await staff.page.goto(WEB + '/admin/site-health');
  await settle(staff.page);
  log(await staff.page.locator('table.data tbody tr').count() >= 5, 'a supervisor sees every site on the health board');
  await checkScreen('supervisor: site health', staff.page, staff.problems);
  await staff.page.locator('table.data tbody tr a').first().click();
  await staff.page.waitForSelector('text=Coverage by post', { timeout: 10000 });
  await checkScreen("supervisor: a site's month", staff.page, staff.problems);

  // Night mode: chosen in the account menu, remembered on the device.
  await staff.page.click('button[aria-label="Account menu"]');
  await staff.page.click('[role="radio"]:has-text("Night")');
  log(await staff.page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'a supervisor switches to night mode');
  await staff.page.keyboard.press('Escape');
  await staff.page.reload();
  await settle(staff.page);
  log(await staff.page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'and it stays on after a reload');
  await checkScreen('supervisor: dashboard at night', staff.page, staff.problems);
  await staff.page.click('button[aria-label="Account menu"]');
  await staff.page.click('[role="radio"]:has-text("Light")');
  log(await staff.page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'and back to light');
  await staff.page.keyboard.press('Escape');

  await officer.page.goto(WEB + '/post-log?tab=visitors');
  await settle(officer.page);

  // Sign them back out so a rerun starts clean.
  await officer.page.locator('li.list-item', { hasText: visitor }).locator('button:has-text("Sign out")').click();
  await officer.page.waitForTimeout(1200);
  log(await officer.page.locator('li.list-item', { hasText: visitor }).locator('button:has-text("Sign out")').count() === 0,
    'and the officer signs them out');
  officer.problems.splice(0);
  await officer.context.close();
  await staff.context.close();
  await client.context.close();
}

/* ------------------------------------------------ round 9: small things --- */
{
  console.log('\n--- Shortcuts, licence reminders and client email settings ---');
  const staff = await watchedPage({ width: 1366, height: 900 });
  await staffSignIn(staff.page, '1002', '3571');
  await settle(staff.page);
  await staff.page.keyboard.press('?');
  log(await staff.page.locator('[role="dialog"]:has-text("Keyboard shortcuts")').count() === 1, '? shows the keyboard shortcuts');
  await staff.page.keyboard.press('Escape');
  await staff.page.waitForTimeout(200);
  await staff.page.keyboard.press('g');
  await staff.page.keyboard.press('h');
  await staff.page.waitForTimeout(800);
  log(new URL(staff.page.url()).pathname === '/admin/site-health', 'g then h goes to site health');
  await checkScreen('supervisor: reached by shortcut', staff.page, staff.problems);

  const armed = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(armed.page, '1005', '6174');
  await settle(armed.page);
  log(await armed.page.locator('.expiry-list li').count() >= 1, "an officer's home warns of a licence or certificate about to lapse");
  await checkScreen('officer: licence reminder', armed.page, armed.problems);

  const client = await watchedPage({ width: 1280, height: 900 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'carla.mendez@harborviewhealth.org');
  await client.page.fill('input[type="password"]', 'harborview-portal-04');
  await client.page.click('button[type="submit"]');
  await settle(client.page);
  await client.page.click('button[aria-label="Account menu"]');
  await client.page.waitForSelector('text=Email me');
  const daily = client.page.locator('label:has-text("The daily report") input');
  await daily.check();
  await client.page.waitForTimeout(800);
  await client.page.keyboard.press('Escape');
  await client.page.reload();
  await settle(client.page);
  await client.page.click('button[aria-label="Account menu"]');
  await client.page.waitForSelector('text=Email me');
  log(await client.page.locator('label:has-text("The daily report") input').isChecked(), 'a client turns on the daily report email, and it stays on');
  await client.page.locator('label:has-text("The daily report") input').uncheck();
  await client.page.waitForTimeout(600);
  await staff.context.close();
  await armed.context.close();
  await client.context.close();
}

/* ------------------------------------------ round 10: incident follow-ups --- */
{
  console.log('\n--- Incident follow-ups and incident reports ---');
  const client = await watchedPage({ width: 1280, height: 900 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'rpike@emeraldcoastlogistics.com');
  await client.page.fill('input[type="password"]', 'pensacola-portal-05');
  await client.page.click('button[type="submit"]');
  await settle(client.page);
  await client.page.goto(WEB + '/portal/incidents');
  await settle(client.page);
  const ref = (await client.page.locator('table.data tbody tr td.mono, .list .mono').first().innerText()).trim();
  log(/^USC-/.test(ref), "the client's incident list has a report to follow up", ref);

  const staff = await watchedPage({ width: 1366, height: 900 });
  await staffSignIn(staff.page, '1002', '3571');
  await staff.page.goto(WEB + '/admin/incidents?tab=follow-ups');
  await settle(staff.page);
  log(await staff.page.locator('.follow-ups li.list-item').count() >= 1, 'a supervisor sees the open follow-ups across incidents');
  await checkScreen('supervisor: follow-ups', staff.page, staff.problems);

  const task = `E2E follow-up ${Date.now() % 100000}: meet the property manager`;
  await staff.page.goto(WEB + '/admin/incidents');
  await settle(staff.page);
  await staff.page.fill('input[aria-label="Search incidents"]', ref);
  await staff.page.waitForTimeout(1000);
  await staff.page.locator('tr.clickable', { hasText: ref }).first().click();
  await staff.page.waitForSelector('#followups-title', { timeout: 10000 });
  await staff.page.getByLabel('What needs doing').fill(task);
  await staff.page.click('button:has-text("Add follow-up")');
  const item = staff.page.locator('.follow-ups li.list-item', { hasText: task });
  await item.waitFor({ timeout: 10000 });
  log(await item.count() === 1, 'a supervisor adds a follow-up to the incident');
  await checkScreen('supervisor: incident with follow-ups', staff.page, staff.problems);
  await item.locator('button:has-text("Mark done")').click();
  await staff.page.getByLabel('What was done').fill('Met on site; fence panel ordered.');
  await staff.page.click('.modal-foot button:text-is("Mark done")');
  await staff.page.waitForTimeout(1200);
  log(await staff.page.locator('.follow-ups li.list-item', { hasText: task }).locator('text=Done').count() >= 1, 'and marks it done with what was done');

  await client.page.reload();
  await settle(client.page);
  const row = client.page.locator('tr, li.list-item', { hasText: ref }).first();
  await row.locator('button:has-text("Read")').click();
  await client.page.waitForSelector('.client-actions', { timeout: 10000 });
  log(await client.page.locator('.client-actions li', { hasText: task }).count() === 1, 'the client reads what was done about their incident');
  log(await client.page.locator('[role="dialog"]').getByText('Met on site; fence panel ordered.').count() === 0, 'but not the internal note');
  await checkScreen('client: incident follow-ups', client.page, client.problems);

  await staff.page.goto(WEB + '/admin/reports?report=incidents-by-site');
  await settle(staff.page);
  await staff.page.waitForSelector('table.data tbody tr', { timeout: 10000 });
  log(await staff.page.locator('table.data tbody tr').count() >= 1, 'a manager runs the incidents by site report');
  await checkScreen('supervisor: incidents by site', staff.page, staff.problems);
  await staff.context.close();
  await client.context.close();
}

/* --------------------------------------------- round 11: field visits --- */
{
  console.log('\n--- Supervisor field visits ---');
  const staff = await watchedPage({ width: 1366, height: 900 });
  await staffSignIn(staff.page, '1002', '3571');
  await staff.page.goto(WEB + '/admin/visits');
  await settle(staff.page);
  const dueRows = staff.page.locator('table.data tbody tr', { hasText: 'Due' });
  const dueBefore = await dueRows.count();
  log(dueBefore >= 1, 'a supervisor sees the sites due a visit', `${dueBefore}`);
  await checkScreen('supervisor: field visits', staff.page, staff.problems);
  const dueSite = (await dueRows.first().locator('td .strong').innerText()).trim();
  await dueRows.first().locator('button:has-text("Log a visit")').click();
  await staff.page.waitForSelector('[role="dialog"]:has-text("Log a visit")');
  const postSelect = staff.page.locator('[role="dialog"] select').nth(1);
  const firstPost = await postSelect.locator('option').nth(1).getAttribute('value');
  await postSelect.selectOption(firstPost);
  await staff.page.getByLabel('Equipment present and working').uncheck();
  await staff.page.getByLabel('Notes (internal)').fill('E2E: radio battery flat, replaced from the spare.');
  await staff.page.getByLabel('Note for the client').fill('E2E: supervisor visit, post in order.');
  await checkScreen('supervisor: log a visit', staff.page, staff.problems);
  await staff.page.click('[role="dialog"] .modal-foot button:has-text("Log visit")');
  await staff.page.waitForTimeout(1500);
  log(await dueRows.count() === dueBefore - 1, `the visit takes ${dueSite} off the due list`);
  const logged = staff.page.locator('.visit-list li', { hasText: 'E2E: radio battery flat' });
  log(await logged.count() === 1 && (await logged.locator('text=Equipment present and working').count()) === 1,
    'and the visit is listed with the failed check');
  await staff.page.click('[role="radio"]:has-text("Found a problem")');
  await staff.page.waitForTimeout(800);
  log(await staff.page.locator('.visit-list li', { hasText: 'E2E: radio battery flat' }).count() === 1, 'including under visits that found a problem');

  await staff.page.goto(WEB + '/admin/reports?report=visits-by-site');
  await settle(staff.page);
  await staff.page.waitForSelector('table.data tbody tr', { timeout: 10000 });
  log(await staff.page.locator('table.data tbody tr').count() >= 10, 'a manager runs the supervisor visits report');
  await checkScreen('supervisor: visits report', staff.page, staff.problems);

  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1003', '4812');
  await settle(officer.page);
  await officer.page.waitForSelector('#last-visit-title', { timeout: 10000 });
  log(await officer.page.locator('#last-visit-title').count() === 1, "an officer's home shows their last supervisor visit");
  await checkScreen('officer: last supervisor visit', officer.page, officer.problems);
  await staff.context.close();
  await officer.context.close();
}

/* ----------------------------- round 12: invoice questions, incident print --- */
{
  console.log('\n--- Invoice questions and printable incident reports ---');
  const client = await watchedPage({ width: 1280, height: 900 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'carla.mendez@harborviewhealth.org');
  await client.page.fill('input[type="password"]', 'harborview-portal-04');
  await client.page.click('button[type="submit"]');
  await settle(client.page);
  await client.page.goto(WEB + '/portal/invoices');
  await settle(client.page);
  await client.page.locator('li.list-item button:has-text("View")').first().click();
  await client.page.waitForSelector('#invoice-questions-title', { timeout: 10000 });
  const q = `E2E ${Date.now() % 100000}: were the overnight hours billed at the night rate?`;
  await client.page.getByLabel('Your question').fill(q);
  await client.page.click('button:has-text("Ask about this invoice")');
  await client.page.waitForTimeout(1200);
  log(await client.page.locator('[role="dialog"] li', { hasText: q }).locator('text=Waiting for our answer').count() === 1,
    'a client asks a question about an invoice');
  await checkScreen('client: invoice question', client.page, client.problems);
  await client.page.keyboard.press('Escape');

  const staff = await watchedPage({ width: 1366, height: 900 });
  await staffSignIn(staff.page, '1002', '3571');
  await staff.page.goto(WEB + '/admin/invoices?tab=questions');
  await settle(staff.page);
  const row = staff.page.locator('li.list-item', { hasText: q });
  log(await row.count() === 1, 'the office sees it under Client questions');
  await checkScreen('supervisor: client questions', staff.page, staff.problems);
  await row.locator('button:has-text("Answer")').click();
  await staff.page.getByLabel('Your answer').fill('Yes - overnight hours carry the agreed night rate from 22:00.');
  await staff.page.click('[role="dialog"] button:has-text("Send answer")');
  await staff.page.waitForTimeout(1200);
  log(await staff.page.locator('li.list-item', { hasText: q }).count() === 0, 'and answers it');

  await client.page.reload();
  await settle(client.page);
  await client.page.locator('li.list-item button:has-text("View")').first().click();
  await client.page.waitForSelector('#invoice-questions-title', { timeout: 10000 });
  log(await client.page.locator('.invoice-answer', { hasText: 'agreed night rate' }).count() === 1, 'the client reads the answer');

  await client.page.keyboard.press('Escape');
  await client.page.goto(WEB + '/portal/incidents');
  await settle(client.page);
  await client.page.locator('button:not(.notice-more):has-text("Read")').first().click();
  await client.page.waitForSelector('[role="dialog"] .incident-sheet', { state: 'attached', timeout: 10000 });
  log(await client.page.locator('[role="dialog"] button:has-text("Print / save PDF")').count() === 1
    && await client.page.locator('.incident-sheet').isHidden(), 'an incident report is ready to print, kept off the screen');
  await staff.context.close();
  await client.context.close();
}

/* --------------------------------- round 13: client notices, schedule ahead --- */
{
  console.log('\n--- Client notices and the schedule ahead ---');
  const staff = await watchedPage({ width: 1366, height: 900 });
  await staffSignIn(staff.page, '1002', '3571');
  await staff.page.goto(WEB + '/admin/clients?tab=notices');
  await settle(staff.page);
  await checkScreen('supervisor: client notices', staff.page, staff.problems);
  const title = `E2E notice ${Date.now() % 100000}`;
  await staff.page.click('button:has-text("New notice")');
  await staff.page.getByLabel('Title').fill(title);
  await staff.page.getByLabel('Message').fill('The visitor car park is closed for resurfacing on Saturday; visitors use level 2.');
  await staff.page.getByLabel('Every property').uncheck();
  await staff.page.getByLabel('Harborview Medical Center').check();
  await checkScreen('supervisor: new notice', staff.page, staff.problems);
  await staff.page.click('[role="dialog"] button:has-text("Post notice")');
  await staff.page.waitForTimeout(1200);
  log(await staff.page.locator('li.list-item', { hasText: title }).locator('text=Live').count() === 1, 'a supervisor posts a notice to one property');

  const client = await watchedPage({ width: 1280, height: 900 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'carla.mendez@harborviewhealth.org');
  await client.page.fill('input[type="password"]', 'harborview-portal-04');
  await client.page.click('button[type="submit"]');
  await settle(client.page);
  const banner = client.page.locator('.notices-bar .banner', { hasText: title });
  await banner.waitFor({ timeout: 10000 });
  log(await banner.count() === 1, "the property's contact sees it at the top of the portal");
  await checkScreen('client: notice banner', client.page, client.problems);
  await banner.locator('button:has-text("Got it")').click();
  await client.page.waitForTimeout(800);
  await client.page.reload();
  await settle(client.page);
  log(await client.page.locator('.notices-bar .banner', { hasText: title }).count() === 0, 'and once read it stays out of the way');

  await client.page.goto(WEB + '/portal/coverage');
  await settle(client.page);
  await client.page.click('[role="radio"]:has-text("Coming up")');
  await client.page.waitForTimeout(1200);
  log(await client.page.locator('h1:has-text("Coming up")').count() === 1 && await client.page.locator('section.card li.list-item').count() > 0,
    'a client sees who is booked on their posts in the days ahead');
  await checkScreen('client: coverage coming up', client.page, client.problems);

  await staff.page.reload();
  await settle(staff.page);
  const row = staff.page.locator('li.list-item', { hasText: title });
  log(await row.locator('text=read by 1 of').count() === 1, 'the office sees it has been read');
  staff.page.once('dialog', (d) => d.accept());
  await row.locator('button:has-text("Withdraw")').click();
  await staff.page.waitForTimeout(1000);
  log(await staff.page.locator('li.list-item', { hasText: title }).locator('text=Withdrawn').count() === 1, 'and withdraws it');
  await staff.context.close();
  await client.context.close();
}

/* ----------------------------------------------------- round 14: hiring --- */
{
  console.log('\n--- Hiring: from the public form to a login ---');
  const visitor = await watchedPage({ width: 1280, height: 1000 });
  const email = `e2e.apply.${Date.now() % 100000}@example.org`;
  await visitor.page.goto(WEB + '/apply', { waitUntil: 'networkidle' });
  await checkScreen('public: job application', visitor.page, visitor.problems);
  await visitor.page.getByLabel('First name').fill('Quinn');
  await visitor.page.getByLabel('Last name').fill('Avery');
  await visitor.page.getByLabel('Email').fill(email);
  await visitor.page.getByLabel('Phone').fill('(904) 555-0123');
  await visitor.page.getByLabel('Licence number').fill('D3500123');
  await visitor.page.click('button:has-text("Send my application")');
  await visitor.page.waitForSelector('text=we have your application', { timeout: 10000 });
  log(true, 'anyone can apply from the public page');

  const staff = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(staff.page, '1001', '2468');
  await staff.page.goto(WEB + '/admin/hiring');
  await settle(staff.page);
  const card = staff.page.locator('.hiring-card', { hasText: 'Quinn Avery' });
  log(await card.count() === 1, 'the application is on the hiring board under Applied');
  await checkScreen('admin: hiring board', staff.page, staff.problems);
  await card.click();
  await staff.page.waitForSelector('[role="dialog"]:has-text("Before they can start")');
  for (const stage of ['screening', 'interview', 'offer']) {
    await staff.page.click(`[role="dialog"] button:has-text("Move to ${stage}")`);
    await staff.page.waitForTimeout(700);
  }
  for (const label of ['Security licence verified with FDACS', 'Background check clear', 'I-9 right to work on file']) {
    await staff.page.locator('[role="dialog"] label.check', { hasText: label }).locator('input').check();
    await staff.page.waitForTimeout(500);
  }
  await checkScreen('admin: applicant ready to hire', staff.page, staff.problems);
  await staff.page.click('[role="dialog"] .modal-foot button:text-is("Hire")');
  await staff.page.getByLabel('Rate per hour ($)').fill('18.75');
  await staff.page.click('button:has-text("Hire and create login")');
  await staff.page.waitForSelector('text=Starting PIN', { timeout: 10000 });
  const pin = (await staff.page.locator('dt:has-text("Starting PIN") + dd').innerText()).trim();
  const code = (await staff.page.locator('dt:has-text("Employee code") + dd').innerText()).trim();
  log(/^\d{4}$/.test(code) && /^\d{4}$/.test(pin), 'an administrator takes them through the checks and hires them', code);

  const newcomer = await watchedPage({ width: 390, height: 844 });
  await newcomer.page.goto(WEB, { waitUntil: 'networkidle' });
  await newcomer.page.fill('#employeeCode', code);
  await newcomer.page.click('button[type="submit"]');
  await newcomer.page.waitForSelector('.keypad');
  for (const d of pin) await newcomer.page.click(`.keypad button:text-is("${d}")`);
  await newcomer.page.click('button:text-is("Sign in")');
  await newcomer.page.waitForTimeout(1500);
  log(await newcomer.page.locator('text=/choose|new PIN/i').count() > 0, 'and the new officer signs in and is asked for their own PIN');
  await visitor.context.close();
  await staff.context.close();
  await newcomer.context.close();
}

/* ---------------------------------------------- round 15: dispatch --- */
{
  console.log('\n--- Dispatch: a client calls, an officer goes ---');
  const stamp = Date.now() % 100000;
  const what = `E2E ${stamp}: a man is trying the doors of the bike store.`;
  const client = await watchedPage({ width: 390, height: 844 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
  await client.page.fill('input[type="password"]', 'riverfront-portal-01');
  await client.page.click('button[type="submit"]');
  await client.page.waitForTimeout(2000);
  await client.page.goto(WEB + '/portal/calls', { waitUntil: 'networkidle' });
  await checkScreen('client: calls', client.page, client.problems);
  await client.page.getByLabel('Where on the property').fill('Bike store, level P1');
  await client.page.getByLabel('What is happening?').fill(what);
  await client.page.click('button:has-text("Send an officer")');
  await client.page.locator('li.list-item', { hasText: what }).waitFor({ timeout: 10000 });
  log(await client.page.locator('li.list-item', { hasText: what }).locator('text=Finding an officer').count() === 1, 'a client asks for an officer from the portal');

  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/dispatch');
  await settle(sup.page);
  const row = sup.page.locator('.call-list .list-item', { hasText: what });
  log(await row.count() === 1, 'the call is on the dispatch board, waiting');
  await row.locator('button:has-text("Open")').click();
  await sup.page.waitForSelector('[role="dialog"] .call-log');
  await checkScreen('admin: a call', sup.page, sup.problems);
  await sup.page.click('[role="dialog"] button[aria-label="Send call to Marcus Bell"]');
  await sup.page.waitForSelector('[role="dialog"] >> text=Has it', { timeout: 10000 });
  log(true, 'a supervisor sends it to Marcus, at the property');

  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1003', '4812');
  const card = officer.page.locator('.call-card', { hasText: what });
  await card.waitFor({ timeout: 10000 });
  await checkScreen('officer: a call sent to them', officer.page, officer.problems);
  await card.locator('button:has-text("On my way")').click();
  await officer.page.waitForTimeout(800);
  await card.locator('button:has-text("I\'m on scene")').click();
  await officer.page.waitForTimeout(800);
  await card.locator('button:has-text("Clear call")').click();
  await officer.page.getByLabel('What you found and what you did').fill('Cyclist locked out of his own bike store; checked his ID and let him in.');
  await officer.page.click('[role="dialog"] button:has-text("Clear call")');
  await officer.page.waitForTimeout(1200);
  log(await officer.page.locator('.call-card', { hasText: what }).count() === 0, 'Marcus acknowledges, arrives and clears it from his phone');

  await client.page.reload({ waitUntil: 'networkidle' });
  const done = client.page.locator('li', { hasText: what });
  log(await done.locator('text=Cleared').count() > 0 && await done.locator('text=/On scene in \\d+ min/').count() === 1,
    'and the client sees it cleared, with how long it took');
  await client.context.close();
  await sup.context.close();
  await officer.context.close();
}

/* --------------------------------------- round 16: time corrections --- */
{
  console.log('\n--- Time corrections: an officer asks, an administrator approves ---');
  const why = `E2E ${Date.now() % 100000}: relief was late, I stayed at the desk until they arrived.`;
  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1003', '4812');
  await officer.page.goto(WEB + '/schedule');
  await settle(officer.page);
  await officer.page.click('button:has-text("Worked")');
  await officer.page.waitForSelector('#punches-title');
  await checkScreen('officer: punches', officer.page, officer.problems);
  const row = officer.page.locator('.punch-row:not(:has-text("now")):has(button:has-text("Fix a time"))').first();
  await row.locator('button:has-text("Fix a time")').click();
  const out = officer.page.getByLabel('Clock-out should be');
  const was = await out.inputValue();
  const later = new Date(new Date(was).getTime() + 15 * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  await out.fill(`${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`);
  await officer.page.getByLabel('What happened?').fill(why);
  await officer.page.click('button:has-text("Send to the office")');
  await officer.page.waitForSelector('.punch-row >> text=Correction waiting', { timeout: 10000 });
  log(await officer.page.locator('.punch-row', { hasText: 'Correction waiting' }).count() >= 1, 'an officer asks for a clock-out 15 minutes later');

  const admin = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(admin.page, '1001', '2468');
  await admin.page.goto(WEB + '/admin/timesheets?view=corrections');
  await settle(admin.page);
  const req = admin.page.locator('tr', { hasText: why });
  log(await req.count() === 1, 'the request waits under Timesheets → Corrections');
  await checkScreen('admin: time corrections', admin.page, admin.problems);
  await req.locator('button:has-text("Approve")').click();
  await admin.page.click('button:has-text("Approve and correct the shift")');
  await admin.page.waitForTimeout(1200);
  log(await admin.page.locator('tr', { hasText: why }).count() === 0, 'an administrator approves it and it leaves the queue');

  await officer.page.reload();
  await settle(officer.page);
  await officer.page.click('button:has-text("Worked")');
  await officer.page.waitForSelector('#punches-title');
  log(await officer.page.locator('.punch-row', { hasText: 'Correction approved' }).count() >= 1, 'and the officer sees it approved');
  await officer.context.close();
  await admin.context.close();
}

/* ------------------------------------- round 17: service agreements --- */
{
  console.log('\n--- Service agreements: what each site pays for ---');
  const admin = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(admin.page, '1001', '2468');
  await admin.page.goto(WEB + '/admin/agreements');
  await settle(admin.page);
  await checkScreen('admin: service agreements', admin.page, admin.problems);
  const gulfport = admin.page.locator('tr', { hasText: 'Gulfport Logistics Yard' });
  log(await gulfport.locator('text=/\\d+ h short/').count() === 1, 'a site rostered below its agreement is marked short');
  await admin.page.click('button[aria-label="Set the agreement for Coral Bay Retail Plaza"]');
  await admin.page.getByLabel('Hours a week the client pays for').fill('24');
  await admin.page.click('button:has-text("Save agreement")');
  await admin.page.waitForTimeout(1200);
  const coral = admin.page.locator('tr', { hasText: 'Coral Bay Retail Plaza' });
  log((await coral.innerText()).includes('24 h') && await coral.locator('button:has-text("Edit")').count() === 1,
    'an administrator sets an agreement for a month-to-month site');
  await admin.context.close();
}

/* ------------------------------------ round 18: shift confirmations --- */
{
  console.log('\n--- Shift confirmations: an officer confirms, a supervisor chases the rest ---');
  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1003', '4812');
  await settle(officer.page);
  const confirmBtn = officer.page.locator('button:has-text("Confirm I\'ll be there")').first();
  if (await confirmBtn.count()) {
    await confirmBtn.click();
    await officer.page.waitForSelector('text=Your supervisor knows you will be there.', { timeout: 10000 });
    log(true, 'an officer confirms their next shift from the home screen');
  } else {
    log(await officer.page.locator('text=Your supervisor knows you will be there.').count() === 1, 'the officer\'s next shift is already confirmed (rerun)');
  }
  await officer.page.goto(WEB + '/schedule');
  await settle(officer.page);
  log(await officer.page.locator('.chip', { hasText: 'Confirmed' }).count() >= 1, 'and the schedule shows it confirmed');
  await checkScreen('officer: schedule with confirmations', officer.page, officer.problems);

  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin#unconfirmed');
  await settle(sup.page);
  const card = sup.page.locator('#unconfirmed');
  if (await card.count()) {
    const rows = card.locator('.list-item');
    const before = await rows.count();
    log(before >= 1 && await card.locator('a[href^="tel:"]').count() >= 1, 'the dashboard lists who has not confirmed, with a number to call', `${before}`);
    await checkScreen('supervisor: unconfirmed shifts', sup.page, sup.problems);
    await rows.first().locator('button:has-text("Confirmed by phone")').click();
    await sup.page.getByLabel('Note').fill('E2E: spoke to them, on the way.');
    await sup.page.click('button:has-text("Mark confirmed")');
    await sup.page.waitForTimeout(1500);
    log((await card.count()) === 0 || (await rows.count()) === before - 1, 'a supervisor records a confirmation taken by phone');
  } else {
    log(true, 'nobody unconfirmed inside 12 hours right now');
  }
  log(await sup.page.locator('th', { hasText: 'Confirmed' }).count() === 1, 'the next-12-hours table shows who has confirmed');

  const client = await watchedPage({ width: 390, height: 844 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
  await client.page.fill('input[type="password"]', 'riverfront-portal-01');
  await client.page.click('button[type="submit"]');
  await client.page.waitForTimeout(2000);
  await client.page.goto(WEB + '/portal/coverage', { waitUntil: 'networkidle' });
  await client.page.click('button:has-text("Coming up")');
  await settle(client.page);
  log(await client.page.locator('.chip', { hasText: 'Confirmed' }).count() >= 1, 'the client sees which upcoming shifts the officer has confirmed');
  await checkScreen('client: coming up with confirmations', client.page, client.problems);
  await client.context.close();
  await sup.context.close();
  await officer.context.close();
}

/* ---------------------------------------- round 19: patrol vehicles --- */
{
  console.log('\n--- Patrol vehicles: an officer checks the truck, a supervisor signs a repair off ---');
  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1003', '4812');
  await settle(officer.page);
  const card = officer.page.locator('#held-equipment');
  log(await card.locator('text=Garage patrol truck').count() === 1, 'the officer home shows the patrol truck signed out to them');
  async function fillCheck(extra) {
    const dlg = officer.page.locator('[role="dialog"]');
    const last = Number(((await dlg.locator('text=/Last reading/').innerText()).match(/([\d,]+) mi/) || [])[1]?.replace(/,/g, ''));
    await officer.page.getByLabel('Odometer (miles)').fill(String(last + extra));
    await dlg.locator('label.chip-toggle', { hasText: '3/4' }).click();
    const rows = dlg.locator('.check-row:not(.plain)');
    for (let i = 0; i < await rows.count(); i++) await rows.nth(i).locator('label', { hasText: 'OK' }).click();
    return last;
  }
  if (await card.locator('button:has-text("Check before driving")').count()) {
    await card.locator('button:has-text("Check before driving")').click();
    await fillCheck(3);
    await checkScreen('officer: vehicle check', officer.page, officer.problems);
    await officer.page.click('[role="dialog"] button:has-text("Save the check")');
    await card.locator('text=/Checked/').waitFor({ timeout: 10000 });
    log(true, 'the officer checks the truck before driving');
    await card.locator('button:has-text("End check and hand back")').click();
    await fillCheck(27);
    await officer.page.click('[role="dialog"] button:has-text("Save and hand back")');
    await officer.page.waitForTimeout(1500);
    log(await officer.page.locator('#held-equipment').count() === 0, 'and hands it back with the end check');
  } else {
    log(true, 'the truck was already checked (rerun)');
  }

  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/fleet');
  await settle(sup.page);
  await checkScreen('supervisor: fleet', sup.page, sup.problems);
  const truckRow = sup.page.locator('tr', { hasText: 'Garage patrol truck' });
  log(await truckRow.locator('text=In the yard').count() === 1, 'the fleet shows the truck back in the yard');
  const offRoad = sup.page.locator('tr', { has: sup.page.locator('text=Off the road') }).first();
  if (await offRoad.count()) {
    await offRoad.locator('button:has-text("Open")').click();
    await sup.page.waitForSelector('[role="dialog"] #log-h');
    await checkScreen('supervisor: a vehicle', sup.page, sup.problems);
    await sup.page.locator('[role="dialog"] button:has-text("Sign off the repair")').first().click();
    await sup.page.getByLabel('What was repaired').fill('E2E: brake fluid leak repaired, road-tested.');
    await sup.page.click('[role="dialog"] button:text-is("Sign off")');
    await sup.page.waitForTimeout(1500);
    log(await sup.page.locator('[role="dialog"]').getByText('Nothing outstanding.').count() === 1, 'a supervisor signs the brake repair off and the vehicle is back on the road');
    await sup.page.keyboard.press('Escape');
  } else {
    log(true, 'no vehicle off the road (rerun)');
  }
  await officer.context.close();
  await sup.context.close();
}

/* ------------------------------------------ round 20: expense claims --- */
{
  console.log('\n--- Expenses: an officer claims, an administrator decides, payroll pays ---');
  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1042', '8598');
  await officer.page.goto(WEB + '/profile');
  await settle(officer.page);
  const mine = officer.page.locator('#expenses');
  log(await mine.locator('text=Toll road to the Pensacola site').count() === 1, 'the officer sees their approved toll claim on their profile');
  await mine.locator('button:has-text("Claim an expense")').click();
  const dlg = officer.page.locator('[role="dialog"]');
  await officer.page.getByLabel('Amount ($)').fill('40');
  log(await dlg.locator('text=/needs a photo of the receipt/').count() === 1, 'a claim over $25 asks for the receipt');
  await officer.page.getByLabel('What for').selectOption('mileage');
  await officer.page.getByLabel('Miles driven').fill('12');
  log(await dlg.locator('text=/\\$8\\.40/').count() >= 1, 'mileage is priced as it is typed: 12 miles is $8.40');
  await officer.page.getByLabel('What it was for').fill('E2E: Riverfront to the Harborview relief and back.');
  await checkScreen('officer: claim an expense', officer.page, officer.problems);
  await dlg.locator('button:has-text("Claim $8.40")').click();
  await mine.locator('text=E2E: Riverfront to the Harborview relief').first().waitFor({ timeout: 10000 });
  log(true, 'the officer claims 12 miles from their phone');
  await checkScreen('officer: my expenses', officer.page, officer.problems);

  const admin = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(admin.page, '1001', '2468');
  await admin.page.goto(WEB + '/admin/expenses');
  await settle(admin.page);
  await checkScreen('admin: expenses', admin.page, admin.problems);
  const row = admin.page.locator('li.expense-row', { hasText: 'E2E: Riverfront to the Harborview relief' }).first();
  log(await row.count() === 1, 'the claim is waiting in the administrator\'s queue');
  const dwayne = admin.page.locator('li.expense-row', { hasText: 'Dwayne Foster' }).first();
  await dwayne.locator('button:has-text("View receipt")').click();
  await admin.page.waitForSelector('[role="dialog"] img', { timeout: 10000 });
  log(true, 'the administrator opens the receipt photo');
  await checkScreen('admin: a receipt', admin.page, admin.problems);
  await admin.page.click('[role="dialog"] button:has-text("Done")');
  await row.locator('button:has-text("Approve")').click();
  await admin.page.click('[role="dialog"] button:has-text("Approve $8.40")');
  await admin.page.waitForTimeout(1500);
  log(await admin.page.locator('li.expense-row', { hasText: 'E2E: Riverfront to the Harborview relief' }).count() === 0, 'approved, it leaves the waiting list');
  await admin.page.goto(WEB + '/admin/payroll');
  await settle(admin.page);
  const period = await firstLink(admin.page, '^/admin/payroll/\\d+$');
  await admin.page.goto(WEB + period);
  await settle(admin.page);
  log(await admin.page.locator('#reimbursements', { hasText: 'Marcus Bell' }).count() === 1, 'the pay period lists the expenses it pays, apart from gross pay');
  await checkScreen('admin: pay period with expenses', admin.page, admin.problems);
  await officer.page.reload();
  await settle(officer.page);
  log(await officer.page.locator('#expenses .chip', { hasText: 'Approved' }).count() >= 2, 'and the officer sees it approved');
  await officer.context.close();
  await admin.context.close();
}

/* ------------------------------------------- round 21: paid time off --- */
{
  console.log('\n--- Paid time off: an officer asks for hours from their balance, a supervisor approves ---');
  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1003', '4812');
  await officer.page.goto(WEB + '/profile');
  await settle(officer.page);
  const card = officer.page.locator('#time-off');
  log(await card.locator('text=Paid time off').count() >= 1 && await card.locator('text=Free to use').count() === 1, 'the officer sees their paid time off balance');
  await card.locator('button:has-text("See the statement")').click();
  log(await card.locator('td', { hasText: 'Earned' }).count() >= 1, 'and the statement of what they earned and used');
  await card.locator('button:has-text("Request time off")').click();
  const dlg = officer.page.locator('[role="dialog"]');
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = ymd(new Date(Date.now() + 45 * 86400000));
  await officer.page.getByLabel('First day off').fill(day);
  await officer.page.getByLabel('Last day off').fill(day);
  log(await dlg.locator('input[type="checkbox"]').isChecked(), 'paying it from the balance is the default when there is some');
  await officer.page.getByLabel('Hours from my balance').fill('4');
  await officer.page.getByLabel('Reason').fill('E2E: dentist in the morning.');
  await checkScreen('officer: request time off', officer.page, officer.problems);
  await dlg.locator('button:has-text("Send request")').click();
  await card.locator('text=4 h from your balance').first().waitFor({ timeout: 10000 });
  log(true, 'the officer asks for four hours of paid time off');
  await checkScreen('officer: time off', officer.page, officer.problems);

  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/time-off');
  await settle(sup.page);
  const row = sup.page.locator('.list-item', { hasText: 'E2E: dentist in the morning.' }).first();
  log(await row.locator('.chip', { hasText: '4 h paid' }).count() === 1, 'the supervisor sees the hours asked for, with the balance');
  const marcusHref = await row.locator('a[href^="/admin/employees/"]').getAttribute('href');
  await row.locator('button:has-text("Approve")').click();
  log(await sup.page.locator('[role="dialog"]', { hasText: 'from a balance of' }).count() === 1, 'the decision shows the balance it comes from');
  await checkScreen('supervisor: approve paid time off', sup.page, sup.problems);
  await sup.page.click('[role="dialog"] button:text-is("Approve")');
  await sup.page.waitForTimeout(1500);
  await sup.page.goto(WEB + marcusHref);
  await settle(sup.page);
  log(await sup.page.locator('#pto td', { hasText: 'Used' }).count() >= 1, 'approved, it is spent on the officer\'s statement');
  await checkScreen('supervisor: employee paid time off', sup.page, sup.problems);
  await sup.page.goto(WEB + '/admin/payroll');
  await settle(sup.page);
  await sup.page.goto(WEB + (await firstLink(sup.page, '^/admin/payroll/\\d+$')));
  await settle(sup.page);
  log(await sup.page.locator('#paid-time-off', { hasText: 'Tanisha Greene' }).count() === 1, 'the pay period lists the paid time off its close pays');
  await checkScreen('supervisor: pay period with paid time off', sup.page, sup.problems);
  await officer.context.close();
  await sup.context.close();
}

/* ------------------------------------------- round 22: commendations --- */
{
  console.log('\n--- Commendations: a client thanks an officer, the officer reads it, a supervisor adds one ---');
  const client = await watchedPage({ width: 390, height: 844 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
  await client.page.fill('input[type="password"]', 'riverfront-portal-01');
  await client.page.click('button[type="submit"]');
  await client.page.waitForTimeout(2000);
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  const card = client.page.locator('#commend');
  await card.waitFor({ timeout: 10000 });
  const option = await card.locator('select').first().locator('option', { hasText: 'Marcus Bell' }).first().getAttribute('value');
  await card.locator('select').first().selectOption(option);
  await card.getByLabel('For').selectOption('customer_service');
  await card.getByLabel('What they did').fill('E2E: walked a lost delivery driver round to the right dock in the rain.');
  await checkScreen('client: commend an officer', client.page, client.problems);
  await card.locator('button:has-text("Send the commendation")').click();
  await card.locator('text=/will see it/').waitFor({ timeout: 10000 });
  log(true, 'a client commends Marcus from the portal');

  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1003', '4812');
  await settle(officer.page);
  const home = officer.page.locator('#commended');
  log(await home.locator('text=E2E: walked a lost delivery driver').count() === 1, 'the officer sees it on their home screen');
  await checkScreen('officer: commended', officer.page, officer.problems);
  await home.locator('button:has-text("Thanks, got it")').click();
  await officer.page.waitForTimeout(1200);
  log(await officer.page.locator('#commended').count() === 0, 'read, it leaves the home screen');
  await officer.page.goto(WEB + '/profile');
  await settle(officer.page);
  log(await officer.page.locator('#commendations', { hasText: 'E2E: walked a lost delivery driver' }).count() === 1, 'and stays on their profile');

  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/scorecards');
  await settle(sup.page);
  log(await sup.page.locator('th', { hasText: 'Commended' }).count() === 1, 'the scorecards count commendations');
  await sup.page.goto(WEB + '/admin/employees');
  await settle(sup.page);
  await sup.page.locator('a[href^="/admin/employees/"]', { hasText: 'Marcus Bell' }).first().click();
  await sup.page.waitForSelector('#commendations');
  const rec = sup.page.locator('#commendations');
  log(await rec.locator('text=E2E: walked a lost delivery driver').count() === 1, 'the supervisor sees it on the officer\'s record');
  await rec.locator('button:has-text("Commend")').click();
  await sup.page.getByLabel('What they did').fill('E2E: perfect handover to nights, log complete and post orders read.');
  await checkScreen('supervisor: commend an officer', sup.page, sup.problems);
  await sup.page.click('[role="dialog"] button:text-is("Commend")');
  await rec.locator('text=E2E: perfect handover to nights').waitFor({ timeout: 10000 });
  log(true, 'a supervisor commends the officer too');
  await checkScreen('supervisor: officer commendations', sup.page, sup.problems);
  await client.context.close();
  await officer.context.close();
  await sup.context.close();
}

/* ------------------------------------------- round 23: overtime watch --- */
{
  console.log('\n--- Overtime watch: who is heading past 40 hours, and the shift that tips them over ---');
  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/overtime');
  await settle(sup.page);
  await checkScreen('supervisor: overtime watch', sup.page, sup.problems);
  await sup.page.click('button[role="radio"]:has-text("Next week")');
  await sup.page.waitForSelector('table.data tbody tr', { timeout: 10000 });
  const rows = sup.page.locator('table.data tbody tr');
  log(await rows.count() >= 1, 'next week lists officers heading into overtime', `${await rows.count()}`);
  await checkScreen('supervisor: overtime next week', sup.page, sup.problems);
  const cover = sup.page.locator('a:has-text("Find cover")').first();
  log(await cover.count() === 1, 'with the shift that tips them over, and a way to cover it');
  await cover.click();
  await sup.page.waitForSelector('[role="dialog"]', { timeout: 10000 });
  await sup.page.locator('[role="dialog"] >> text=Suggested officers').waitFor({ timeout: 15000 });
  log(await sup.page.locator('[role="dialog"]', { hasText: 'This puts them into overtime' }).count() === 1,
    'the schedule opens that shift, warns it is overtime, and suggests officers who could take it');
  await checkScreen('supervisor: shift from the overtime watch', sup.page, sup.problems);
  await sup.context.close();

  // West of Greenwich a picked date must stay the date picked, and the last
  // day of a range must count. Both slipped a day when read as midnight UTC.
  const ny = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/New_York' });
  const nyPage = await ny.newPage();
  await staffSignIn(nyPage, '1002', '3571');
  await nyPage.goto(WEB + '/admin/timesheets');
  await settle(nyPage);
  const today = await nyPage.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await nyPage.getByLabel('From date').fill(today);
  await nyPage.getByLabel('To date').fill(today);
  await nyPage.waitForTimeout(1200);
  log(await nyPage.getByLabel('From date').inputValue() === today && await nyPage.getByLabel('To date').inputValue() === today,
    'in New York, a date picked on Timesheets stays the date picked', today);
  const shown = await nyPage.locator('table.data tbody tr').count();
  log(shown > 0, 'and a range of just today still includes today', `${shown} rows`);
  const nyWeek = await nyPage.evaluate(async () => {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return next;
  });
  await nyPage.goto(WEB + '/admin/overtime');
  await settle(nyPage);
  await nyPage.click('button[role="radio"]:has-text("Next week")');
  await nyPage.waitForTimeout(1500);
  const [y, m, d] = nyWeek.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  log(await nyPage.locator('.stat', { hasText: label }).count() === 1, 'and the overtime watch\'s next week starts on next Monday there too', label);
  await ny.close();
}

/* --------------------------------------------- round 25: holiday pay --- */
{
  console.log('\n--- Holidays: the calendar that pays a premium and bills the holiday rate ---');
  const adm = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(adm.page, '1001', '2468');
  await adm.page.goto(WEB + '/admin/holidays');
  await settle(adm.page);
  log(await adm.page.locator('.list-item', { hasText: 'Thanksgiving Day' }).count() >= 1, 'the calendar has the usual holidays on it');
  await checkScreen('admin: holidays', adm.page, adm.problems);

  // A holiday eight days out (nine if that is one already), added through the dialog.
  const target = await adm.page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 8);
    const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const monday = new Date(d);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return { day: ymd(d), monday: ymd(monday) };
  });
  await adm.page.click('button:has-text("Add a holiday")');
  await adm.page.getByLabel('Date').fill(target.day);
  await adm.page.getByLabel('Name').fill('E2E Holiday');
  await adm.page.getByLabel('Bills').fill('2');
  await checkScreen('admin: add a holiday', adm.page, adm.problems);
  await adm.page.click('[role="dialog"] button:has-text("Add holiday")');
  await adm.page.waitForTimeout(1500);
  // The year's list, not the "Coming up" card above it.
  const yearList = (page) => page.locator('.card', { has: page.locator('h3', { hasText: /^\d{4}$/ }) });
  const added = yearList(adm.page).locator('.list-item', { hasText: 'E2E Holiday' });
  log(await added.count() === 1 && await added.locator('text=Bills 2x').count() === 1, 'an administrator adds a holiday that bills double');

  await adm.page.goto(WEB + `/admin/schedule?week=${target.monday}`);
  await settle(adm.page);
  log(await adm.page.locator('thead >> text=E2E Holiday').count() === 1, 'the schedule marks the day');
  await checkScreen('admin: schedule with a holiday', adm.page, adm.problems);

  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/holidays');
  await settle(sup.page);
  log(await yearList(sup.page).locator('.list-item', { hasText: 'E2E Holiday' }).count() === 1 && await sup.page.locator('button:has-text("Add a holiday")').count() === 0,
    'a supervisor reads the calendar but cannot change it');
  const coming = sup.page.locator('.card', { hasText: 'Coming up' });
  log(await coming.locator('.list-item', { hasText: 'E2E Holiday' }).count() === 1 && await coming.locator('text=/booked|Nothing rostered yet/').count() >= 1,
    'and sees how the coming holidays are staffed');
  await checkScreen('supervisor: holidays coming up', sup.page, sup.problems);
  await sup.context.close();

  const client = await watchedPage({ width: 390, height: 844 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
  await client.page.fill('input[type="password"]', 'riverfront-portal-01');
  await client.page.click('button[type="submit"]');
  await client.page.waitForTimeout(2000);
  await client.page.goto(WEB + '/portal/invoices', { waitUntil: 'networkidle' });
  await settle(client.page);
  const rates = client.page.locator('.card', { hasText: 'Holiday rates' });
  log(await rates.locator('.list-item', { hasText: 'E2E Holiday' }).count() === 1 && await rates.locator('text=2x').count() >= 1,
    'the client sees the holiday and its rate before it is on an invoice');
  await checkScreen('client: holiday rates', client.page, client.problems);
  await client.context.close();

  adm.page.on('dialog', (d) => d.accept());
  await adm.page.goto(WEB + '/admin/holidays');
  await settle(adm.page);
  await adm.page.click('button[aria-label="Remove E2E Holiday"]');
  await adm.page.waitForTimeout(1500);
  log(await adm.page.locator('.list-item', { hasText: 'E2E Holiday' }).count() === 0, 'and removes it again, from the calendar and from what is coming up');
  await adm.context.close();
}

/* ------------------------------------- round 27: client sign-off of hours --- */
{
  console.log('\n--- Sign-off: the client checks a week of hours, queries it, hears back and signs it off ---');
  const client = await watchedPage({ width: 1440, height: 900 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
  await client.page.fill('input[type="password"]', 'riverfront-portal-01');
  await client.page.click('button[type="submit"]');
  await client.page.waitForTimeout(2000);
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await settle(client.page);
  const nudge = client.page.locator('a:has-text("Sign off the hours")');
  log(await nudge.count() === 1, 'the overview says a week of hours is waiting for the client');
  await nudge.click();
  await client.page.waitForSelector('h1:has-text("Sign off the hours")', { timeout: 10000 });
  await settle(client.page);
  const week = client.page.locator('article.signoff-week', { hasText: 'Waiting for you' }).first();
  log(await week.count() === 1 && await week.locator('table.data tbody tr').count() >= 1, 'last week is there, post by post');
  await checkScreen('client: sign off the hours', client.page, client.problems);
  const title = (await week.locator('h3').innerText()).trim();
  await week.locator('button:has-text("Something looks wrong")').click();
  await client.page.waitForSelector('[role="dialog"]');
  await client.page.getByLabel('What looks wrong?').fill('E2E: the Saturday shift on the lobby console looks two hours too long.');
  await checkScreen('client: query a week', client.page, client.problems);
  await client.page.click('[role="dialog"] button:has-text("Send to our office")');
  await client.page.waitForTimeout(1500);
  const queried = client.page.locator('article.signoff-week', { hasText: title });
  log(await queried.locator('text=Disputed').count() === 1 && await queried.locator('text=E2E: the Saturday shift').count() === 1,
    'the client queries it, and the week reads as disputed');

  const adm = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(adm.page, '1001', '2468');
  await adm.page.goto(WEB + '/admin/invoices?tab=signoff');
  await settle(adm.page);
  const dispute = adm.page.locator('.list-item', { hasText: 'E2E: the Saturday shift' });
  log(await dispute.count() === 1, 'the office sees the dispute on the sign-off board');
  await checkScreen('admin: client sign-off', adm.page, adm.problems);
  await dispute.locator('button:has-text("Reply")').click();
  await adm.page.waitForSelector('[role="dialog"]');
  await adm.page.getByLabel('Your reply').fill('E2E: the officer stayed two hours past the end of the shift at your request - the gate was not locked until 8 PM.');
  await checkScreen('admin: reply to a dispute', adm.page, adm.problems);
  await adm.page.click('[role="dialog"] button:has-text("Send reply")');
  await adm.page.waitForTimeout(1500);
  log(await adm.page.locator('.list-item', { hasText: 'E2E: the Saturday shift' }).locator('text=Replied').count() === 1, 'an administrator replies');
  await adm.context.close();

  await client.page.reload({ waitUntil: 'networkidle' });
  await settle(client.page);
  const answered = client.page.locator('article.signoff-week', { hasText: title });
  log(await answered.locator('text=E2E: the officer stayed').count() === 1, 'the client reads the reply');
  await answered.locator('button:has-text("Sign off these hours")').click();
  await client.page.waitForTimeout(1500);
  log(await client.page.locator('article.signoff-week', { hasText: title }).locator('text=Signed off').count() >= 1, 'and signs the week off');
  await checkScreen('client: week signed off', client.page, client.problems);
  await client.context.close();
}

/* ---------------------------------------------- round 28: site training --- */
{
  console.log('\n--- Site training: a supervisor signs an officer off at a post, withdraws one and signs it back ---');
  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/site-training');
  await sup.page.waitForSelector('h1:has-text("Site training")', { timeout: 10000 });
  await settle(sup.page);
  const garage = sup.page.locator('section.card', { hasText: 'Garage & Loading Dock - Armed' });
  const waiting = garage.locator('button[aria-label^="Sign off "]');
  log(await waiting.count() === 1, 'the garage shows an officer who has worked it and is waiting to be signed off');
  log(await garage.locator('text=On the roster here without training').count() === 1, 'with their shifts there flagged meanwhile');
  await checkScreen('supervisor: site training', sup.page, sup.problems);
  const who = ((await waiting.getAttribute('aria-label')) || '').replace(/^Sign off (.*) at .*$/, '$1');
  await waiting.click();
  await sup.page.waitForSelector('[role="dialog"]');
  await sup.page.getByLabel('Who they shadowed, and when').fill('E2E: four nights at the garage with Raymond Hayes.');
  await checkScreen('supervisor: sign an officer off', sup.page, sup.problems);
  await sup.page.click('[role="dialog"] button:has-text("Sign off")');
  await sup.page.waitForTimeout(1500);
  log(await garage.locator('button[aria-label^="Sign off "]').count() === 0 && await garage.locator('text=On the roster here without training').count() === 0,
    `${who} is signed off, and the garage's roster flags clear`);
  log(await garage.locator(`button[aria-label="Withdraw ${who}'s training at Garage & Loading Dock - Armed"]`).count() === 1, 'and is listed as trained');

  const lab = sup.page.locator('section.card', { hasText: 'Lab Building Access Control' });
  const withdraw = lab.locator('button[aria-label^="Withdraw "]').first();
  const officer = ((await withdraw.getAttribute('aria-label')) || '').replace(/^Withdraw (.*)'s training.*$/, '$1');
  await withdraw.click();
  await sup.page.waitForSelector('[role="dialog"]');
  await sup.page.getByLabel('Why').fill('E2E: let a contractor into the lab without a badge check.');
  await checkScreen('supervisor: withdraw training', sup.page, sup.problems);
  await sup.page.click('[role="dialog"] button:has-text("Withdraw")');
  await sup.page.waitForTimeout(1500);
  const again = lab.locator(`button[aria-label="Sign ${officer} off again at Lab Building Access Control"]`);
  log(await again.count() === 1 && await lab.locator('text=E2E: let a contractor').count() === 1, `${officer}'s training is withdrawn, with the reason`);
  await again.click();
  await sup.page.waitForSelector('[role="dialog"]');
  await sup.page.click('[role="dialog"] button:has-text("Sign off")');
  await sup.page.waitForTimeout(1500);
  log(await lab.locator(`button[aria-label="Withdraw ${officer}'s training at Lab Building Access Control"]`).count() === 1, 'and signed back on after a walkthrough');

  await sup.page.goto(WEB + '/admin/sites');
  await settle(sup.page);
  log(await sup.page.locator('.chip:has-text("Site training")').count() >= 5, 'Sites & posts marks the posts that need it');
  await sup.context.close();

  const client = await watchedPage({ width: 1440, height: 900 });
  await client.page.goto(WEB + '/portal', { waitUntil: 'networkidle' });
  await client.page.fill('input[type="email"]', 'carla.mendez@harborviewhealth.org');
  await client.page.fill('input[type="password"]', 'harborview-portal-04');
  await client.page.click('button[type="submit"]');
  await client.page.waitForTimeout(2000);
  await client.page.goto(WEB + '/portal/orders', { waitUntil: 'networkidle' });
  await settle(client.page);
  log(await client.page.locator('li', { hasText: 'Emergency Department Entrance' }).locator('text=are trained now').count() === 1,
    'the client sees the ED needs site training, and how many officers have it');
  await checkScreen('client: post orders with site training', client.page, client.problems);
  await client.context.close();
}

/* --------------------------------------- round 29: coaching and discipline --- */
{
  console.log('\n--- Coaching & discipline: the officer signs a coaching; a supervisor records a warning, and a refusal to sign ---');
  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1003', '4812');
  await officer.page.goto(WEB + '/', { waitUntil: 'networkidle' });
  await settle(officer.page);
  const card = officer.page.locator('#to-sign');
  log(await card.count() === 1, 'Marcus has a coaching to read and sign on his home screen');
  await card.locator('button:has-text("Read and sign")').first().click();
  await officer.page.waitForSelector('[role="dialog"]');
  await officer.page.getByLabel('Your side of it').fill('E2E: the bridge was closed on the way in. I will leave earlier.');
  await officer.page.getByLabel('Type your full name to sign').fill('Marcus Bell');
  await checkScreen('officer: read and sign a coaching', officer.page, officer.problems);
  await officer.page.click('[role="dialog"] button:text-is("Sign")');
  await officer.page.waitForTimeout(1500);
  log(await officer.page.locator('#to-sign').count() === 0, 'he signs it, and the card goes');
  await officer.page.goto(WEB + '/profile', { waitUntil: 'networkidle' });
  await settle(officer.page);
  const record = officer.page.locator('#my-record');
  log(await record.locator('text=You signed it').count() >= 1 && await record.locator('text=E2E: the bridge was closed').count() === 1,
    'his profile keeps it, signed, with his side of it');
  await checkScreen('officer: coaching and warnings', officer.page, officer.problems);
  await officer.context.close();

  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/conduct');
  await sup.page.waitForSelector('h1:has-text("Coaching & discipline")', { timeout: 10000 });
  await settle(sup.page);
  log(await sup.page.locator('section', { hasText: 'Where officers stand' }).locator('.chip:has-text("Written warning")').count() >= 1,
    'the board shows who stands where, up to a written warning');
  await checkScreen('supervisor: coaching and discipline', sup.page, sup.problems);
  await sup.page.click('button:has-text("Record a step")');
  await sup.page.waitForSelector('[role="dialog"]');
  const dlg = sup.page.locator('[role="dialog"]');
  const pick = dlg.getByLabel('Officer');
  await pick.selectOption(await pick.locator('option', { hasText: 'Andre Mitchell' }).getAttribute('value'));
  await sup.page.waitForTimeout(900);
  log((await dlg.getByLabel('Step').inputValue()) === 'written_warning' && await dlg.locator("text=which is an administrator's decision").count() === 1,
    'for an officer whose record points to a final warning, a supervisor is offered a written warning and told the rest is an administrator\'s');
  const value = await pick.locator('option', { hasText: 'Janelle Carter' }).getAttribute('value');
  await pick.selectOption(value);
  await sup.page.locator('[role="dialog"]').getByLabel('What it is about').selectOption('uniform');
  await sup.page.waitForTimeout(800);
  log((await sup.page.locator('[role="dialog"]').getByLabel('Step').inputValue()) === 'coaching', 'a first uniform problem is suggested as coaching');
  log(await sup.page.locator('[role="dialog"]').getByLabel('Step').locator('option[value="final_warning"]').count() === 0, 'and a supervisor cannot choose a final warning');
  await sup.page.locator('[role="dialog"]').getByLabel('What happened').fill('E2E: arrived at the gatehouse without the company jacket or a visible badge.');
  await sup.page.locator('[role="dialog"]').getByLabel('What is expected from now on').fill('Full uniform on every shift, badge visible.');
  await checkScreen('supervisor: record a step', sup.page, sup.problems);
  await sup.page.click('[role="dialog"] button:has-text("Record coaching")');
  await sup.page.waitForTimeout(1500);
  const waiting = sup.page.locator('section', { hasText: "Waiting for the officer's signature" });
  log(await waiting.locator('.list-item', { hasText: 'Janelle Carter' }).count() === 1, 'the coaching waits for Janelle to sign');
  await waiting.locator('button[aria-label="Record that Janelle Carter refused to sign"]').click();
  await sup.page.waitForSelector('[role="dialog"]');
  await sup.page.locator('[role="dialog"]').getByLabel('Witness').fill('E2E: the site manager');
  await sup.page.click('[role="dialog"] button:has-text("Record refusal")');
  await sup.page.waitForTimeout(1500);
  log(await waiting.locator('.list-item', { hasText: 'Janelle Carter' }).count() === 0
    && await sup.page.locator('details.conduct-record', { hasText: 'Janelle Carter' }).locator('text=Refused to sign').count() >= 1,
    'she will not sign; the supervisor records it, with the witness');
  await sup.context.close();
}

/* ---------------------------------------------------- round 30: handovers --- */
{
  console.log('\n--- Handovers: a supervisor chases a late relief; the held-over officer sees why they are still on ---');
  // The board, read through the API first: the demo's holdovers are set up
  // from whoever is on duty when it was seeded.
  const api = async (path, token, init = {}) =>
    (await fetch(`${WEB}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })).json();
  const supToken = (await api('/auth/login', null, { method: 'POST', body: JSON.stringify({ employeeCode: '1002', pin: '3571' }) })).token;
  const board = await api('/handovers', supToken);
  const late = board.handovers?.find((h) => h.state === 'late' && !h.relief.chased_at);

  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/handovers');
  await sup.page.waitForSelector('h1:has-text("Handovers")', { timeout: 10000 });
  await settle(sup.page);
  log(await sup.page.locator('li.handover').count() === board.handovers.length, 'the board lists every handover in the next two hours', `${board.handovers.length}`);
  await checkScreen('supervisor: handovers', sup.page, sup.problems);
  if (!late) {
    console.log('SKIP  no late relief in the demo at this hour');
  } else {
    const row = sup.page.locator(`#handover-${late.shift_id}`);
    log(await row.locator('text=Relief late').count() === 1 && await row.locator(`text=${late.relief.officer}`).count() >= 1,
      `${late.officer} is held over at ${late.post_name}, waiting for ${late.relief.officer}`);
    await row.locator(`button[aria-label="Chase ${late.relief.officer}"]`).click();
    await sup.page.waitForSelector('[role="dialog"]');
    await checkScreen('supervisor: chase a late relief', sup.page, sup.problems);
    await sup.page.click('[role="dialog"] button:has-text("Send")');
    await sup.page.waitForTimeout(1500);
    log(await row.locator('text=chased').count() === 1, 'the relief is chased, and the board says when');
    await sup.page.goto(WEB + `/admin/handovers?shift=${late.shift_id}`);
    await settle(sup.page);
    log(await sup.page.locator(`#handover-${late.shift_id}.is-focused`).count() === 1, 'an alert opens the board at that handover');

    const pin = String(((Number(late.employee_code) * 7919) % 9000) + 1000);
    const officer = await watchedPage({ width: 390, height: 844 });
    await staffSignIn(officer.page, late.employee_code, pin);
    await settle(officer.page);
    const card = officer.page.locator('#handover');
    log(await card.locator('text=Your relief is late').count() === 1 && await card.locator(`text=${late.relief.officer}`).count() === 1,
      'the held-over officer is told their relief is late, and to stay on post');
    await checkScreen('officer: held over', officer.page, officer.problems);
    await officer.context.close();
  }
  await sup.context.close();
}

/* -------------------------------------------- round 31: rest and fatigue --- */
{
  console.log('\n--- Rest & fatigue: a supervisor sees who is short of rest; the officer sees it on their schedule ---');
  const api = async (path, token, init = {}) =>
    (await fetch(`${WEB}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })).json();
  const supToken = (await api('/auth/login', null, { method: 'POST', body: JSON.stringify({ employeeCode: '1002', pin: '3571' }) })).token;
  const board = await api('/admin/fatigue', supToken);
  const rest = board.shifts.find((f) => f.issues.some((i) => i.code === 'short_rest') && f.employee_code !== '1003');

  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/fatigue');
  await sup.page.waitForSelector('h1:has-text("Rest & fatigue")', { timeout: 10000 });
  await settle(sup.page);
  log(await sup.page.locator('ul.list > li').count() === board.shifts.length, 'the board lists every shift that breaks a rule this week', `${board.shifts.length}`);
  log(await sup.page.locator('.chip:has-text("Too many days in a row")').count() >= 1, 'including a seventh day in a row');
  await checkScreen('supervisor: rest and fatigue', sup.page, sup.problems);
  if (rest) {
    const row = sup.page.locator(`#fatigue-${rest.shift_id}`);
    log(await row.locator('.chip:has-text("Short rest")').count() === 1 && await row.locator(`text=${rest.officer}`).count() >= 1,
      `${rest.officer} is short of rest before ${rest.post_name}`);
    await row.locator('a:has-text("Open on the schedule")').click();
    await sup.page.waitForURL(/\/admin\/schedule\?week=.*&shift=/, { timeout: 10000 });
    log(true, 'and the shift opens on the schedule, to reassign or move');
  }
  await sup.context.close();

  if (rest) {
    const pin = String(((Number(rest.employee_code) * 7919) % 9000) + 1000);
    const officer = await watchedPage({ width: 390, height: 844 });
    await staffSignIn(officer.page, rest.employee_code, pin);
    await officer.page.goto(WEB + '/schedule');
    await settle(officer.page);
    log(await officer.page.locator('text=Only 6 h off before this shift').count() >= 1, 'the officer sees the short rest on their schedule');
    await checkScreen('officer: short rest on the schedule', officer.page, officer.problems);
    await officer.context.close();
  }
}

/* ------------------------------------------- round 32: late and no-shows --- */
{
  console.log('\n--- Late & no-shows: a supervisor confirms a phone for texts, and the board updates itself ---');
  const api = async (path, token, init = {}) =>
    (await fetch(`${WEB}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })).json();
  const login = async (code, pin) => (await api('/auth/login', null, { method: 'POST', body: JSON.stringify({ employeeCode: code, pin }) })).token;
  const adminToken = await login('1001', '2468');
  const board = await api('/attendance', adminToken);

  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  await sup.page.goto(WEB + '/admin/attendance');
  await sup.page.waitForSelector('h1:has-text("Late & no-shows")', { timeout: 10000 });
  await settle(sup.page);
  const rows = await sup.page.locator('#attendance-now ~ * li.handover, section[aria-labelledby="attendance-now"] li.handover').count();
  log(rows === board.open.length, 'the board lists every shift started without its officer', `${rows}`);
  const noShow = board.open.find((o) => o.state === 'no_show');
  if (noShow) {
    const row = sup.page.locator(`#attendance-${noShow.shift_id}`);
    log(await row.locator('.chip:has-text("No-show")').count() === 1 && await row.locator('a:has-text("Find cover")').count() === 1,
      `${noShow.officer} is a no-show, with a button to find cover`);
  }
  await checkScreen('supervisor: late and no-shows', sup.page, sup.problems);

  // A number, a code back, and texts are on.
  await sup.page.click('button:has-text("Text alerts")');
  await sup.page.fill('input[type="tel"]', '904 555 0177');
  await sup.page.click('button:has-text("Text me a code")');
  const banner = sup.page.locator('[role="dialog"]').getByText(/Your code is \d{6}/);
  await banner.waitFor({ timeout: 10000 });
  const code = (await banner.textContent()).match(/\d{6}/)[0];
  log(Boolean(code), 'with no text provider, the code is shown on screen');
  await sup.page.fill('input[autocomplete="one-time-code"]', code);
  await sup.page.click('button:has-text("Confirm number")');
  await sup.page.waitForSelector('[role="dialog"] :text("Confirmed")', { timeout: 10000 });
  log(await sup.page.locator('[role="dialog"] input[type="checkbox"]').first().isChecked(), 'the number is confirmed, and texts turn on');
  await checkScreen('supervisor: text alert settings', sup.page, sup.problems);
  await sup.page.locator('[role="dialog"] label:has-text("Officers running late") input').check();
  await sup.page.click('[role="dialog"] button:text-is("Save")');
  await sup.page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10000 });
  log(await sup.page.locator('section[aria-labelledby="alerts-me"]:has-text("Texts to (904) 555-0177")').count() === 1, 'and the page says where the texts go');

  // Somebody due ten minutes ago, not clocked in: the open board picks it up
  // on its own, and both texts are in the outbox.
  const start = new Date(Math.floor((Date.now() - 10 * 60000) / 60000) * 60000);
  const end = new Date(start.getTime() + 4 * 3600000);
  const posts = (await api('/reference', adminToken)).posts;
  let made = null;
  for (const p of posts.slice(0, 40)) {
    const c = await api(`/admin/shifts/candidates?postId=${p.id}&startsAt=${encodeURIComponent(start.toISOString())}&endsAt=${encodeURIComponent(end.toISOString())}`, adminToken);
    const who = (c.candidates || []).find((x) => x.eligible && !x.reasons.length && x.role === 'officer' && !/^100[1-8]$/.test(x.employee_code));
    if (!who) continue;
    const r = await api('/admin/shifts', adminToken, { method: 'POST', body: JSON.stringify({ postId: p.id, userId: who.user_id, startsAt: start.toISOString(), endsAt: end.toISOString(), notes: 'Browser suite: late start.' }) });
    if (r.shift) { made = { id: r.shift.id, name: who.name }; break; }
  }
  log(Boolean(made), 'an officer is put on a shift that started ten minutes ago', made?.name);
  if (made) {
    const row = sup.page.locator(`#attendance-${made.id}`);
    await row.waitFor({ timeout: 30000 });
    log(await row.locator('.chip:has-text("Late")').count() === 1, `${made.name} appears as late without reloading the page`);
    log(await sup.page.locator(`.toast:has-text("${made.name}")`).count() >= 1, 'with a pop-up saying so');
    const texts = sup.page.locator('section[aria-labelledby="attendance-texts"] li', { hasText: `USC late: ${made.name}` });
    log(await texts.count() === 2, 'and a text each to Vince and the supervisor', `${await texts.count()}`);
    await api(`/admin/shifts/${made.id}`, adminToken, { method: 'DELETE' });
  }
  await sup.context.close();
}

/* ------------------------------------ round 33: running late, and calling off --- */
{
  console.log('\n--- Heads-up: an officer says they are running late, then calls off; supervisors see both ---');
  const api = async (path, token, init = {}) =>
    (await fetch(`${WEB}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })).json();
  const login = async (code, pin) => (await api('/auth/login', null, { method: 'POST', body: JSON.stringify({ employeeCode: code, pin }) })).token;
  const pinFor = (code) => String(((Number(code) * 7919) % 9000) + 1000);
  const adminToken = await login('1001', '2468');

  // An officer free for a shift starting in forty minutes, put on one.
  const start = new Date(Math.ceil((Date.now() + 40 * 60000) / 60000) * 60000);
  const end = new Date(start.getTime() + 6 * 3600000);
  const posts = (await api('/reference', adminToken)).posts;
  let made = null;
  for (const p of posts.slice(0, 40)) {
    const c = await api(`/admin/shifts/candidates?postId=${p.id}&startsAt=${encodeURIComponent(start.toISOString())}&endsAt=${encodeURIComponent(end.toISOString())}`, adminToken);
    const who = (c.candidates || []).find((x) => x.eligible && !x.reasons.length && x.role === 'officer' && !/^100[1-8]$/.test(x.employee_code));
    if (!who || !(await login(who.employee_code, pinFor(who.employee_code)))) continue;
    const r = await api('/admin/shifts', adminToken, { method: 'POST', body: JSON.stringify({ postId: p.id, userId: who.user_id, startsAt: start.toISOString(), endsAt: end.toISOString(), notes: 'Browser suite: heads-up.' }) });
    if (r.shift) { made = { id: r.shift.id, ...who }; break; }
  }
  log(Boolean(made), 'an officer is put on a shift starting in forty minutes', made?.name);
  if (made) {
    const officer = await watchedPage({ width: 390, height: 844 });
    await staffSignIn(officer.page, made.employee_code, pinFor(made.employee_code));
    await officer.page.waitForSelector('#heads-up', { timeout: 10000 });
    log(await officer.page.locator('#heads-up button:has-text("Running late")').count() === 1, 'their home screen offers to say they are running late');
    await checkScreen('officer: next shift, with heads-up', officer.page, officer.problems);

    await officer.page.click('#heads-up button:has-text("Running late")');
    await officer.page.locator('[role="dialog"] [role="radio"]:has-text("20")').click();
    await officer.page.locator('[role="dialog"] input').fill('Train delayed');
    await checkScreen('officer: running late dialog', officer.page, officer.problems);
    await officer.page.click('[role="dialog"] button:has-text("Tell my supervisors")');
    await officer.page.waitForSelector('#heads-up :text("Your supervisors know you are running late")', { timeout: 10000 });
    log(await officer.page.locator('#heads-up :text("Train delayed")').count() === 1, 'and then sees that their supervisors know, with what they said');
    const board = await api('/attendance', adminToken);
    const row = board.open.find((o) => o.shift_id === made.id);
    log(row?.state === 'running_late' && row.notice?.note === 'Train delayed', 'the board shows them running late');
    log(board.texts.some((t) => t.body.startsWith(`USC heads-up: ${made.name}`)), 'and Vince has the text');

    await officer.page.click("#heads-up button:has-text(\"Can't make it\")");
    await officer.page.click('[role="dialog"] label:has-text("Car or transport trouble")');
    await checkScreen("officer: can't make it dialog", officer.page, officer.problems);
    await officer.page.click('[role="dialog"] button:has-text("Call off this shift")');
    await officer.page.waitForSelector('.toast:has-text("Called off")', { timeout: 10000 });
    // The card goes, or moves on to their next shift if they have one today.
    const mine = await api('/heads-up', await login(made.employee_code, pinFor(made.employee_code)));
    log(mine.shift?.id !== made.id, 'calling off takes the shift off their home screen');
    const after = await api('/attendance', adminToken);
    log(after.open.find((o) => o.shift_id === made.id)?.state === 'called_off', 'the board has it as called off');
    log(after.texts.some((t) => t.body.startsWith(`USC CALL-OFF: ${made.name}`)), 'and Vince is texted to find cover');
    await officer.context.close();

    const sup = await watchedPage({ width: 1440, height: 900 });
    await staffSignIn(sup.page, '1002', '3571');
    await sup.page.goto(WEB + `/admin/attendance?shift=${made.id}`);
    await sup.page.waitForSelector(`#attendance-${made.id}`, { timeout: 10000 });
    const r = sup.page.locator(`#attendance-${made.id}`);
    log(await r.locator('.chip:has-text("Called off")').count() === 1 && await r.locator('text=car or transport trouble').count() === 1,
      'a supervisor sees the call-off and why');
    log(await r.locator('a:has-text("Find cover")').count() === 1 && await r.locator('a:has-text("Call")').count() === 0, 'with Find cover, and no number to call');
    await checkScreen('supervisor: a call-off on the board', sup.page, sup.problems);
    await sup.context.close();
    await api(`/admin/shifts/${made.id}`, adminToken, { method: 'DELETE' });
  }
}

/* --------------------------------------------- round 34: the attendance record --- */
{
  console.log('\n--- Attendance record: call-offs on the employee record, the scorecards and the officer\'s own profile ---');
  const api = async (path, token) =>
    (await fetch(`${WEB}/api${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
  const adminToken = (await (await fetch(`${WEB}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employeeCode: '1001', pin: '2468' }),
  })).json()).token;
  const seeded = (await api('/attendance', adminToken)).open.find((o) => o.state === 'called_off' && o.call_off);
  const sup = await watchedPage({ width: 1440, height: 900 });
  await staffSignIn(sup.page, '1002', '3571');
  if (seeded) {
    const rec = await api(`/attendance/record/${seeded.call_off.user_id}`, adminToken);
    await sup.page.goto(WEB + `/admin/employees/${seeded.call_off.user_id}`);
    await sup.page.waitForSelector('#attendance-record', { timeout: 10000 });
    const card = sup.page.locator('#attendance-record');
    log(await card.locator('.tally .bad', { hasText: 'Called off' }).locator('.n').innerText() === String(rec.summary.calledOff),
      `${seeded.officer}'s record counts their call-offs`, `${rec.summary.calledOff}`);
    log(await card.locator('.list-item', { hasText: 'Called off: Sick' }).count() >= 1 && await card.locator('.chip:has-text("Short notice")').count() >= 1,
      'and lists each, with the reason and any short notice');
    log(await card.locator('.list-item', { hasText: 'Covered by' }).count() >= 1, 'and who covered');
    await checkScreen('supervisor: an employee\'s attendance record', sup.page, sup.problems);
    await card.locator('[role="radio"]:has-text("30 days")').click();
    await sup.page.waitForTimeout(400);
    log(await card.locator('.tally').count() === 1, 'the period can be changed');
    await sup.page.goto(WEB + '/admin/scorecards');
    await sup.page.waitForSelector('table.data');
    const row = sup.page.locator('tr', { has: sup.page.locator(`a[href="/admin/employees/${seeded.call_off.user_id}"]`) });
    log(await row.locator('.chip:has-text("called off")').count() === 1, 'the scorecards show the call-offs beside the shifts');
    log(await sup.page.locator('text=a call-off counts as half a missed shift').count() === 1, 'and say how they are scored');
  } else {
    log(true, 'no call-off seeded at this hour');
  }
  await sup.context.close();

  const officer = await watchedPage({ width: 390, height: 844 });
  await staffSignIn(officer.page, '1003', '4812');
  await officer.page.goto(WEB + '/profile');
  await officer.page.waitForSelector('#my-attendance', { timeout: 10000 });
  log(await officer.page.locator('#my-attendance h3:has-text("My attendance")').count() === 1 &&
    await officer.page.locator('#my-attendance .tally > div').count() === 4, 'an officer sees their own attendance on their profile');
  await checkScreen('officer: my attendance', officer.page, officer.problems);
  await officer.context.close();
}

await browser.close();
console.log(`\n${failures === 0 ? `Every role: all ${checks} checks passed.` : `Every role: ${failures} of ${checks} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
