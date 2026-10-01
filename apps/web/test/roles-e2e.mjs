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
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: Boolean(process.env.USC_BROWSER_PROXY) });
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
  log(staff.page.url() !== before && /\/admin\//.test(staff.page.url()), 'opening an alert goes to where it is dealt with', new URL(staff.page.url()).pathname);
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
  await client.page.locator('button:has-text("Read")').first().click();
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

await browser.close();
console.log(`\n${failures === 0 ? `Every role: all ${checks} checks passed.` : `Every role: ${failures} of ${checks} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
