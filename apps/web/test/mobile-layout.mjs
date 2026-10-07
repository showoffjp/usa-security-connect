/**
 * Mobile layout audit.
 *
 * Opens every screen at phone width - as an administrator, an officer and a
 * client, in light and night mode - and measures the layout for the faults a
 * phone shows and a desktop hides:
 *
 *   squeezed    text crushed into a column a few characters wide, so it reads
 *               a letter or two per line (a row of buttons taking all the width)
 *   word-break  a word wider than the box it sits in, so it is split mid-word
 *               or runs out of it
 *   offscreen   something past the edge of the screen, outside any scroller
 *   overlap     two buttons, links or fields drawn on top of each other
 *   overflow    the whole page wider than the screen
 *
 *   USC_CHROMIUM_PATH=/opt/pw-browsers/chromium node test/mobile-layout.mjs
 *
 * Expects the API on :4000 and the web app on :5173. USC_SHOT_DIR saves a
 * full-page screenshot of every screen for a person to look over too. To
 * check a deployed site, set USC_WEB_URL and USC_API_URL and USC_READ_ONLY=1,
 * which stops every request but signing in from writing anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const WEB = process.env.USC_WEB_URL || 'http://localhost:5173';
const API = process.env.USC_API_URL || 'http://localhost:4000/api';
const SHOTS = process.env.USC_SHOT_DIR || null;
const WIDTHS = (process.env.USC_WIDTHS || '360,390').split(',').map(Number);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const OFFICER = [
  ['Officer home', '/'],
  ['Officer schedule', '/schedule'],
  ['Officer schedule: worked', '/schedule', async (p) => p.click('button:has-text("Worked")')],
  ['Officer incidents', '/incidents'],
  ['New incident', '/incidents/new'],
  ['Officer tours', '/tours'],
  ['Officer updates', '/messages'],
  ['Officer profile', '/profile'],
  ['Officer: read and sign a coaching', '/', async (p) => p.locator('#to-sign button:has-text("Read and sign")').first().click()],
  ['Post log', '/post-log'],
  ['Post log: visitors', '/post-log?tab=visitors'],
  ['Post log: vehicles', '/post-log?tab=vehicles'],
  ['Post log: watchlist', '/post-log?tab=watchlist'],
  ['Post log: activity', '/post-log?tab=activity'],
  ['Post log: lost and found', '/post-log?tab=found'],
  ['Post log: building issues', '/post-log?tab=issues'],
  ['Officer: vehicle check', '/', async (p) => p.click('button:has-text("Check before driving")')],
  ['Officer: request time off', '/profile', async (p) => p.click('#time-off button:has-text("Request time off")')],
  ['Officer: time off statement', '/profile', async (p) => p.click('#time-off button:has-text("See the statement")')],
  ['Officer: claim an expense', '/profile', async (p) => p.click('#expenses button:has-text("Claim an expense")')],
];

const ADMIN = [
  ['Dashboard', '/admin'],
  ['Live tracking', '/admin/live'],
  ['Safety & map', '/admin/safety'],
  ['Dispatch', '/admin/dispatch'],
  ['Dispatch: a call', '/admin/dispatch', async (p) => p.locator('.call-list .list-item button:has-text("Open")').first().click()],
  ['Flags', '/admin/flags'],
  ['Incidents', '/admin/incidents'],
  ['Incident follow-ups', '/admin/incidents?tab=follow-ups'],
  ['Tours', '/admin/tours'],
  ['Checkpoint QR tags', '/admin/tours/1/tags'],
  ['Field visits', '/admin/visits'],
  ['Keys & equipment', '/admin/equipment'],
  ['Fleet', '/admin/fleet'],
  ['Expenses', '/admin/expenses'],
  ['Overtime watch', '/admin/overtime'],
  ['Overtime watch: next week', '/admin/overtime', async (p) => p.click('button[role="radio"]:has-text("Next week")')],
  ['Holidays', '/admin/holidays'],
  ['Holidays: add one', '/admin/holidays', async (p) => p.click('button:has-text("Add a holiday")')],
  ['Expenses: decline', '/admin/expenses', async (p) => p.locator('li.expense-row button:has-text("Decline")').first().click()],
  ['Fleet: a vehicle', '/admin/fleet', async (p) => p.locator('table.data button[aria-label^="Open "]').first().click()],
  ['Post logs: visitors', '/admin/post-logs'],
  ['Post logs: pass-down', '/admin/post-logs?tab=passdown'],
  ['Post logs: watchlist', '/admin/post-logs?tab=watchlist'],
  ['Post logs: vehicles', '/admin/post-logs?tab=vehicles'],
  ['Post logs: activity', '/admin/post-logs?tab=activity'],
  ['Post logs: building issues', '/admin/post-logs?tab=issues'],
  ['Post logs: lost and found', '/admin/post-logs?tab=found'],
  ['Post logs: site contacts', '/admin/post-logs?tab=contacts'],
  ['Post logs: post orders', '/admin/post-logs?tab=orders'],
  ['Employees', '/admin/employees'],
  ['Employee', '/admin/employees', async (p) => p.locator('a[href^="/admin/employees/"]').first().click()],
  ['Hiring', '/admin/hiring'],
  ['Hiring: an applicant', '/admin/hiring', async (p) => p.locator('.hiring-card').first().click()],
  ['Schedule', '/admin/schedule'],
  ['Schedule: add shift', '/admin/schedule', async (p) => p.click('button:has-text("Add shift")')],
  ['Shift requests', '/admin/shift-requests'],
  ['Client requests', '/admin/coverage-requests'],
  ['Punch log', '/admin/punches'],
  ['Timesheets', '/admin/timesheets'],
  ['Timesheets: corrections', '/admin/timesheets?view=corrections'],
  ['Time off', '/admin/time-off'],
  ['Time off: approve paid time off', '/admin/time-off', async (p) => p.locator('.list-item', { hasText: 'Marcus Bell' }).first().locator('button:has-text("Approve")').click()],
  ['Payroll', '/admin/payroll'],
  ['Pay period, closed', '/admin/payroll/1'],
  ['Pay period, to approve', '/admin/payroll/2'],
  ['Pay rates', '/admin/pay-rates'],
  ['Licensing', '/admin/compliance'],
  ['Site training', '/admin/site-training'],
  ['Site training: sign off', '/admin/site-training', async (p) => p.locator('button[aria-label^="Sign off "]').first().click()],
  ['Site training: withdraw', '/admin/site-training', async (p) => p.locator('button[aria-label^="Withdraw "]').first().click()],
  ['Coaching & discipline', '/admin/conduct'],
  ['Coaching & discipline: record a step', '/admin/conduct', async (p) => p.click('button:has-text("Record a step")')],
  ['Coaching & discipline: refused to sign', '/admin/conduct', async (p) => p.locator('button[aria-label^="Record that "]').first().click()],
  ['Handovers', '/admin/handovers'],
  ['Handovers: chase a relief', '/admin/handovers', async (p) => {
    // Only when somebody's relief is due: the demo's handovers follow the clock.
    const chase = p.locator('button[aria-label^="Chase "]').first();
    if (await chase.count()) await chase.click();
  }],
  ['Scorecards', '/admin/scorecards'],
  ['Training', '/admin/training'],
  ['Broadcasts', '/admin/broadcasts'],
  ['Sites & posts', '/admin/sites'],
  ['Site health', '/admin/site-health'],
  ['Site health: one site', '/admin/site-health/1'],
  ['Clients', '/admin/clients'],
  ['Client notices', '/admin/clients?tab=notices'],
  ['Client feedback', '/admin/feedback'],
  ['Service agreements', '/admin/agreements'],
  ['Invoices', '/admin/invoices'],
  ['Invoices: questions', '/admin/invoices?tab=questions'],
  ['Invoices: client sign-off', '/admin/invoices?tab=signoff'],
  ['Invoices: reply to a dispute', '/admin/invoices?tab=signoff', async (p) => p.locator('.list-item button:has-text("Reply")').first().click()],
  ['Outbox', '/admin/emails'],
  ['Daily report', '/admin/dar'],
  ['Reports', '/admin/reports'],
  ['Report: payroll register', '/admin/reports?report=payroll'],
  ['Report: vehicle mileage', '/admin/reports?report=vehicle-mileage'],
  ['Audit log', '/admin/audit'],
  ['Alerts inbox', '/admin', async (p) => p.click('.bell-btn')],
  ['Navigation menu', '/admin', async (p) => p.click('button[aria-label*="menu" i]')],
  ['Quick search', '/admin', async (p) => { await p.click('button[aria-label*="Search" i]'); await p.keyboard.type('mar'); }],
];

const PORTAL = [
  ['Portal overview', '/portal'],
  ['Portal coverage', '/portal/coverage'],
  ['Portal coverage: coming up', '/portal/coverage?view=upcoming'],
  ['Portal coverage: sign off', '/portal/coverage?view=signoff'],
  ['Portal: query a week', '/portal/coverage?view=signoff', async (p) => p.locator('button:has-text("Something looks wrong")').first().click()],
  ['Portal patrols', '/portal/patrols'],
  ['Portal incidents', '/portal/incidents'],
  ['Portal daily report', '/portal/report'],
  ['Portal invoices', '/portal/invoices'],
  ['Portal requests', '/portal/requests'],
  ['Portal calls', '/portal/calls'],
  ['Portal post orders', '/portal/orders'],
  ['Portal monthly report', '/portal/monthly'],
];

const PUBLIC = [
  ['Sign in', '/login'],
  ['Apply', '/apply'],
  ['Portal sign in', '/portal'],
];

/** Runs in the page: every layout fault on the current screen. */
function measure() {
  const vw = document.documentElement.clientWidth;
  const found = [];
  const name = (el) => {
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls} "${text}"`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    if (el.closest('.sr-only, svg, [aria-hidden="true"], .leaflet-container')) return false;
    return true;
  };
  // Inside something that scrolls or clips sideways on purpose: a wide table, a map, a chart.
  const contained = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
    }
    return false;
  };
  const canvas = document.createElement('canvas').getContext('2d');
  // What can actually be seen of an element: its box cut down by every
  // ancestor that scrolls or clips (a list scrolled under a dialog's footer).
  const clipped = (el) => {
    let { left, top, right, bottom } = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const b = a.getBoundingClientRect();
        left = Math.max(left, b.left); top = Math.max(top, b.top);
        right = Math.min(right, b.right); bottom = Math.min(bottom, b.bottom);
      }
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };

  if (document.documentElement.scrollWidth > vw + 1) {
    found.push(['overflow', `page is ${document.documentElement.scrollWidth}px wide on a ${vw}px screen`]);
  }

  // With a dialog open, only the dialog is in front of the person.
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
  const root = dialogs.length ? dialogs[dialogs.length - 1] : document.body;

  for (const el of root.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const texts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    const own = texts.map((n) => n.textContent).join(' ').trim();
    if (own.length >= 3) {
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight) || fs * 1.35;
      // The text's own box, not the element's: a table cell is as tall as its row.
      const range = document.createRange();
      range.setStartBefore(texts[0]);
      range.setEndAfter(texts[texts.length - 1]);
      const t = range.getBoundingClientRect();
      // Squeezed: three or more lines holding only a few letters each.
      const lines = Math.round(t.height / lh);
      if (lines >= 3 && own.replace(/\s/g, '').length / lines < 6) {
        found.push(['squeezed', `${name(el)} is ${Math.round(t.width)}px wide and ${Math.round(t.height)}px tall`]);
      } else if (cs.whiteSpace !== 'nowrap' && cs.textOverflow !== 'ellipsis') {
        canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        // A line can break at a space or just after a hyphen.
        const longest = own.split(/\s+|(?<=-)/).sort((a, b) => b.length - a.length)[0] || '';
        const w = canvas.measureText(longest).width + (parseFloat(cs.letterSpacing) || 0) * longest.length;
        const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        if (longest.length >= 4 && inner > 0 && w > inner + 2 && !/^https?:|@/.test(longest)) {
          found.push(['word-break', `"${longest}" needs ${Math.round(w)}px in ${name(el)} (${Math.round(inner)}px)`]);
        }
      }
    }
    // Text spilling out of the side of its card: still on the screen, so the
    // check below cannot see it, but over the card's edge (or cut off by it).
    if (own.length >= 3) {
      const card = el.closest('.card, .stat, .modal, [role="dialog"]');
      if (card && card !== el) {
        let scrolls = false;
        // A card that is itself the scroller (".card.table-wrap") counts too.
        for (let a = el.parentElement; a; a = a.parentElement) {
          const ox = getComputedStyle(a).overflowX;
          if (ox === 'auto' || ox === 'scroll') scrolls = true;
          if (a === card) break;
        }
        const c = card.getBoundingClientRect();
        if (!scrolls && (r.right > c.right + 1 || r.left < c.left - 1)) {
          found.push(['spills', `${name(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} past its card (${Math.round(c.left)}..${Math.round(c.right)})`]);
        }
      }
    }
    if ((r.right > vw + 1 || r.left < -1) && !contained(el) && getComputedStyle(el).position !== 'fixed') {
      found.push(['offscreen', `${name(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} on a ${vw}px screen`]);
    }
  }

  const controls = [...root.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')]
    .filter((el) => visible(el) && !el.closest('.leaflet-container'))
    .map((el) => ({ el, r: clipped(el) }))
    .filter(({ r }) => r.width > 0 && r.height > 0);
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const b = controls[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (x > 4 && y > 4) {
        // A fixed bar over scrolled content is not an overlap anyone sees as broken.
        const fixed = (el) => el.closest('.topbar, .tabbar, .bottom-bar, header, nav');
        if (Boolean(fixed(a.el)) !== Boolean(fixed(b.el))) continue;
        found.push(['overlap', `${name(a.el)} and ${name(b.el)}`]);
      }
    }
  }

  // A control with something else lying over its middle: a tap there lands on
  // the other thing. Only what is on screen now can be tested this way.
  const vh = document.documentElement.clientHeight;
  for (const { el, r } of controls) {
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
    const top = document.elementFromPoint(cx, cy);
    if (!top || el.contains(top) || top.contains(el)) continue;
    // A label in front of its own field is how custom checkboxes and pickers work.
    if (top.closest('label') && top.closest('label').contains(el)) continue;
    if (el.labels && [...el.labels].some((l) => l.contains(top))) continue;
    // A fixed bar over content scrolled beneath it is expected.
    if (top.closest('.topbar, .tabbar, .bottom-bar, header, nav') && !el.closest('.topbar, .tabbar, .bottom-bar, header, nav')) continue;
    found.push(['covered', `${name(el)} has ${name(top)} over its middle`]);
  }
  return found;
}

const browser = await chromium.launch(process.env.USC_CHROMIUM_PATH ? { executablePath: process.env.USC_CHROMIUM_PATH } : {});
const staffToken = async (code, pin) =>
  (await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employeeCode: code, pin }) })).json()).token;

let problems = 0;
let screens = 0;
const seen = new Map();

async function audit(who, list, setup) {
  for (const width of WIDTHS) {
    for (const scheme of ['light', 'dark']) {
      // Layout does not change with the theme, so the second width checks dark only.
      if (width !== WIDTHS[0] && scheme === 'light') continue;
      const context = await browser.newContext({
        viewport: { width, height: 800 }, colorScheme: scheme, isMobile: true, hasTouch: true, serviceWorkers: 'block',
        ...(process.env.USC_BROWSER_TZ ? { timezoneId: process.env.USC_BROWSER_TZ } : {}),
      });
      // USC_READ_ONLY: for a live site, nothing but signing in may write.
      // Requests go out through Node rather than the browser, which also gets
      // through a TLS-inspecting proxy the browser itself does not trust.
      if (process.env.USC_READ_ONLY) {
        await context.route('**/*', async (route) => {
          const req = route.request();
          const login = /\/(auth|client)\/login$/.test(new URL(req.url()).pathname);
          if (!['GET', 'HEAD'].includes(req.method()) && !login) return route.abort();
          try {
            const r = await fetch(req.url(), { method: req.method(), headers: req.headers(), body: login ? req.postData() : undefined });
            const headers = Object.fromEntries(r.headers.entries());
            delete headers['content-encoding'];
            delete headers['content-length'];
            return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
          } catch {
            return route.abort();
          }
        });
      }
      const page = await context.newPage();
      await setup(page, context);
      for (const [label, route, act] of list) {
        try {
          await page.goto(WEB + route, { waitUntil: 'networkidle' });
          await page.waitForTimeout(500);
          if (act) {
            await act(page);
            await page.waitForTimeout(700);
          }
          const faults = await page.evaluate(measure);
          screens += 1;
          const tag = `${who} · ${label} @${width}${scheme === 'dark' ? ' night' : ''}`;
          if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${who}-${label}-${width}-${scheme}.png`.replace(/[^\w.-]+/g, '_')), fullPage: true });
          const fresh = faults.filter(([kind, what]) => {
            // The same fault on the same element is reported once, wherever it shows.
            const key = `${who}|${kind}|${what.replace(/\d+px/g, '')}`;
            if (seen.has(key)) return false;
            seen.set(key, true);
            return true;
          });
          if (fresh.length) {
            problems += fresh.length;
            console.log(`FAIL  ${tag}`);
            for (const [kind, what] of fresh.slice(0, 12)) console.log(`        ${kind.padEnd(10)} ${what}`);
            if (fresh.length > 12) console.log(`        ... and ${fresh.length - 12} more`);
          } else {
            console.log(`PASS  ${tag}`);
          }
        } catch (err) {
          problems += 1;
          console.log(`FAIL  ${who} · ${label} @${width}: could not open (${err.message.split('\n')[0]})`);
        }
      }
      await context.close();
    }
  }
}

await audit('public', PUBLIC, async () => {});
const admin = await staffToken('1001', '2468');
await audit('admin', ADMIN, async (page, context) => context.addInitScript((t) => localStorage.setItem('usc.token', t), admin));
const officer = await staffToken('1003', '4812');
await audit('officer', OFFICER, async (page, context) => context.addInitScript((t) => localStorage.setItem('usc.token', t), officer));
await audit('client', PORTAL, async (page) => {
  await page.goto(`${WEB}/portal`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'dana.whitfield@riverfrontholdings.com');
  await page.fill('input[type="password"]', 'riverfront-portal-01');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
});

await browser.close();
console.log(`\n${screens} screens measured at ${WIDTHS.join(' and ')}px. ${problems ? `${problems} LAYOUT PROBLEM(S).` : 'No layout problems.'}`);
process.exit(problems ? 1 : 0);
