/**
 * Every GET endpoint, as every kind of caller, and not one server error.
 *
 * The other suites test what each feature should do. This one tests what
 * none of them should ever do: answer with a 5xx. The routes are read from
 * the source rather than listed by hand, so a new endpoint is swept the day it
 * is written. Each is called signed out, as an officer, a supervisor, an
 * administrator and a client contact, with made-up ids and no query string -
 * the requests a bookmark, a stale tab or a curious user actually sends.
 * A refusal (401, 403, 404, 422) is fine; a crash is not.
 *
 * It also checks the one rule that holds everywhere: without a session,
 * nothing but the public endpoints answers 200.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, call, log, section, signIn, finish } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');

/* ---------------------------------------------------- find the routes -- */

const appSource = fs.readFileSync(path.join(src, 'app.js'), 'utf8');
const importOf = {};
for (const m of appSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/routes\/(\w+)\.js'/g)) {
  for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) importOf[name] = m[2];
}
const mounts = [...appSource.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)].map((m) => ({ prefix: m[1], router: m[2] }));

const routes = new Set(['/api/health', '/api/reference']);
const writes = new Set();
for (const { prefix, router } of mounts) {
  const file = importOf[router];
  if (!file) continue;
  const text = fs.readFileSync(path.join(src, 'routes', `${file}.js`), 'utf8');
  for (const m of text.matchAll(new RegExp(`${router}\\.(get|post|patch|put|delete)\\(\\s*'([^']+)'`, 'g'))) {
    const route = `${prefix}${m[2] === '/' ? '' : m[2]}`.replace(/\/$/, '') || prefix;
    if (m[1] === 'get') routes.add(route);
    else writes.add(`${m[1].toUpperCase()} ${route}`);
  }
}

// Stand-in values for path parameters. Real-looking where it helps the
// handler get further before it can refuse, and deliberately wrong elsewhere.
const PARAMS = { kind: 'hours-by-officer', token: 'not-a-token', userId: '3', shiftId: '1', runId: '1', photoId: '1' };
const fill = (route) => route.replace(/:(\w+)/g, (_, name) => PARAMS[name] || '1');

const list = [...routes].sort();
log(list.length > 90, 'found the GET endpoints in the source', `${list.length}`);

/* -------------------------------------------------------- the callers -- */

const callers = {
  anonymous: null,
  officer: await signIn('1003', '4812'),
  supervisor: await signIn('1002', '3571'),
  admin: await signIn('1001', '2468'),
  client: (await call('/client/login', { method: 'POST', body: { email: 'dfaulkner@capitalplazart.com', password: 'capital-portal-06' } })).data?.token,
};
log(Object.entries(callers).every(([k, v]) => k === 'anonymous' || v), 'signed in as each kind of caller');

/* ------------------------------------------------------------ sweep -- */

const PUBLIC = new Set(['/api/health', '/api/reference', '/api/client/set-password/:token']);
const crashes = [];
const leaks = [];
let requests = 0;

for (const [who, token] of Object.entries(callers)) {
  section(`as ${who}`);
  let fine = 0;
  for (const route of list) {
    const url = fill(route).replace(/^\/api/, '');
    const res = await fetch(BASE + url, { headers: token ? { authorization: `Bearer ${token}` } : {} }).catch((e) => ({ status: 0, error: e }));
    requests++;
    if (res.status >= 500 || res.status === 0) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 160);
      } catch {
        /* nothing to show */
      }
      crashes.push(`${who} GET ${url} -> ${res.status} ${body}`);
    } else {
      fine++;
      if (who === 'anonymous' && res.status === 200 && !PUBLIC.has(route) && !/\/cron\//.test(route)) leaks.push(url);
    }
  }
  log(fine === list.length, `every endpoint answered without a server error`, `${fine}/${list.length}`);
}

/* ------------------------------------------------ hostile parameters -- */

// The same endpoints with every common query parameter set to nonsense: a
// word where a number goes, a date that is not one, a negative page. The
// answer should be a refusal or a sensible default, never a crash.
const JUNK = new URLSearchParams({
  siteId: 'abc', userId: 'x', postId: '-1', employeeId: 'NaN', id: '1.5',
  date: 'not-a-date', from: '2026-13-45', to: 'yesterday', periodStart: 'x', periodEnd: 'y', day: '31/31',
  days: '-5', limit: '-3', page: 'abc', offset: 'lots', status: 'zzz', kind: '../../etc', type: '<script>',
  q: "%_'\\", plate: "'; DROP TABLE users; --", onSite: 'maybe', all: 'yes', role: 'god', format: 'xml',
}).toString();

for (const who of ['officer', 'supervisor', 'admin', 'client']) {
  section(`as ${who}, with nonsense parameters`);
  let fine = 0;
  for (const route of list) {
    const url = `${fill(route).replace(/^\/api/, '')}?${JUNK}`;
    const res = await fetch(BASE + url, { headers: { authorization: `Bearer ${callers[who]}` } }).catch(() => ({ status: 0 }));
    requests++;
    if (res.status >= 500 || res.status === 0) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 160);
      } catch {
        /* nothing to show */
      }
      crashes.push(`${who} GET ${fill(route)} (junk query) -> ${res.status} ${body}`);
    } else fine++;
  }
  log(fine === list.length, 'every endpoint refused or coped', `${fine}/${list.length}`);
}

/* ------------------------------------------ bugs this sweep turned up -- */

section('found by this sweep, and fixed');
{
  // Acknowledging a broadcast already opened hit an ambiguous column and failed.
  const inbox = (await call('/broadcasts', { token: callers.officer })).data.broadcasts || [];
  const msg = inbox[0];
  const read = await call(`/broadcasts/${msg.id}/receipt`, { token: callers.officer, method: 'POST', body: {} });
  const ack = await call(`/broadcasts/${msg.id}/receipt`, { token: callers.officer, method: 'POST', body: { acknowledge: true } });
  log(read.status === 200 && ack.status === 200, 'an officer can open a broadcast and then acknowledge it', `${read.status} then ${ack.status}`);
  const after = (await call('/broadcasts', { token: callers.officer })).data.broadcasts.find((b) => b.id === msg.id);
  log(after && !after.unread && !after.needs_ack, 'and it then reads as read and acknowledged');
  log((await call('/broadcasts/999999/receipt', { token: callers.officer, method: 'POST', body: {} })).status === 404,
    'a receipt for a message that does not exist is a 404, not a crash');

  // Saving training progress used SQLite's two-argument MAX(), which Postgres
  // does not have - so no progress was ever saved and no video could finish.
  const officer = callers.officer;
  const course = ((await call('/training', { token: officer })).data.trainings || []).find((t) => t.duration_seconds > 0);
  const first = await call(`/training/${course.id}/progress`, { token: officer, method: 'POST', body: { secondsWatched: 10 } });
  const second = await call(`/training/${course.id}/progress`, { token: officer, method: 'POST', body: { secondsWatched: 5 } });
  log(first.status === 200 && second.status === 200, 'training progress saves, and saves again', `${first.status}, ${second.status}`);
  const done = await call(`/training/${course.id}/progress`, {
    token: officer, method: 'POST', body: { secondsWatched: course.duration_seconds, completed: true },
  });
  log(done.status === 200, 'and a video watched to the end can be marked complete', `${done.status} ${done.data?.error || ''}`);
}

/* ------------------------------------------------ writes, badly formed -- */

// Every POST, PATCH, PUT and DELETE with a body of the wrong shape: fields
// of the wrong type, a string where an object goes, nothing at all. Run as
// an officer and an administrator; signing out is left to last so the
// session lasts the whole pass. This comes after the reads because some of
// these do change things - an empty body is a perfectly good way to, say,
// start a break - and it is the last suite in the run.
const BODIES = [
  {},
  { id: 'x', siteId: 'abc', userId: -1, postId: 1.5, status: 42, name: ['x'], email: {}, date: 'nope', startsAt: 'soon', amount: 'lots' },
  'not json at all',
];
const ordered = [...writes].sort((a, b) => /logout|revoke|sessions/.test(a) - /logout|revoke|sessions/.test(b));
log(ordered.length > 80, 'found the write endpoints in the source', `${ordered.length}`);

for (const who of ['officer', 'admin']) {
  section(`as ${who}, writing nonsense`);
  let fine = 0;
  let total = 0;
  for (const entry of ordered) {
    const [method, route] = entry.split(' ');
    for (const body of BODIES) {
      total++;
      const res = await fetch(BASE + fill(route).replace(/^\/api/, ''), {
        method,
        headers: { authorization: `Bearer ${callers[who]}`, 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }).catch(() => ({ status: 0 }));
      requests++;
      if (res.status >= 500 || res.status === 0) {
        let text = '';
        try {
          text = (await res.text()).slice(0, 160);
        } catch {
          /* nothing to show */
        }
        crashes.push(`${who} ${method} ${fill(route)} ${JSON.stringify(body).slice(0, 40)} -> ${res.status} ${text}`);
      } else fine++;
    }
  }
  log(fine === total, 'every write refused or coped', `${fine}/${total}`);
}

section('findings');
for (const c of crashes) console.log(`   ${c}`);
log(crashes.length === 0, 'no 5xx anywhere', `${crashes.length} of ${requests} requests`);
log(leaks.length === 0, 'nothing but the public endpoints answers without a session', leaks.join(', '));

finish('Endpoint sweep');
