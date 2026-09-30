/**
 * Site contacts, client feedback and the CSV exports.
 *
 * Contacts are kept from both sides - supervisors and the client - so the
 * line to hold is that a client edits only their own properties' contacts,
 * and an officer reads the list for the site they are on. Feedback is one
 * rating per contact, property and month; a low one needs a reason, and a
 * manager's reply reaches the client. Every export is a real CSV that a
 * spreadsheet will not execute.
 */

import { BASE, call, log, section, signIn, finish } from './harness.mjs';

const supervisor = await signIn('1002', '3571');
const admin = await signIn('1001', '2468');
const marcus = await signIn('1003', '4812'); // on duty at Riverfront
const clientSignIn = async (email, password) =>
  (await call('/client/login', { method: 'POST', body: { email, password } })).data?.token;
const capital = await clientSignIn('dfaulkner@capitalplazart.com', 'capital-portal-06');
const pensacola = await clientSignIn('rpike@emeraldcoastlogistics.com', 'pensacola-portal-05');
log(Boolean(supervisor && admin && marcus && capital && pensacola), 'signed in as staff and two client contacts');

/* ================================================================ contacts === */
section('site contacts');

const officerView = await call('/post-log/site', { token: marcus });
log(officerView.status === 200 && officerView.data.contacts.length >= 3, 'the officer on post has the site contacts', `${officerView.data.contacts?.length}`);
log(officerView.data.contacts.every((c) => c.site_id === officerView.data.post.site_id), 'for their own site only');
log(officerView.data.contacts.some((c) => c.phone && c.after_hours), 'including who to call after hours');

const mine = await call('/client/contacts', { token: capital });
const capitalSite = mine.data.sites[0];
log(mine.status === 200 && capitalSite?.contacts.length >= 3, 'a client sees the contacts for their property');
log(capitalSite.contacts.every((c) => !('added_by_user' in c) && ['you', 'us'].includes(c.added_by)),
  'with who added each - them or us - but not which of our staff');

const add = (token, body) => call('/client/contacts', { token, method: 'POST', body });
log((await add(capital, { siteId: capitalSite.id, name: 'X', role: 'Manager', phone: '850-555-0100' })).status === 422, 'a contact needs a real name');
log((await add(capital, { siteId: capitalSite.id, name: 'Night Engineer', role: 'Engineer' })).status === 422, 'and a way to reach them');
log((await add(capital, { siteId: capitalSite.id, name: 'Night Engineer', role: 'Engineer', phone: 'call me' })).status === 422,
  'a phone number has to be one');
log((await add(pensacola, { siteId: capitalSite.id, name: 'Night Engineer', role: 'Engineer', phone: '(850) 555-0199' })).status === 404,
  "a client cannot add to another client's property");
const added = await add(capital, { siteId: capitalSite.id, name: 'Night Engineer', role: 'Building engineer', phone: '(850) 555-0199', afterHours: true });
log(added.status === 201 && added.data.contacts.some((c) => c.name === 'Night Engineer' && c.added_by === 'you'), 'a client adds a contact');
const newId = added.data.contacts.find((c) => c.name === 'Night Engineer').id;

log((await call(`/client/contacts/${newId}`, { token: pensacola, method: 'PATCH', body: { name: 'Hijacked', role: 'x', phone: '555-555-5555' } })).status === 404,
  "another client cannot edit it");
const edited = await call(`/client/contacts/${newId}`, {
  token: capital, method: 'PATCH', body: { name: 'Night Engineer', role: 'Building engineer', phone: '(850) 555-0123', afterHours: true },
});
log(edited.status === 200 && edited.data.contacts.find((c) => c.id === newId).phone === '(850) 555-0123', 'the client updates it');

const staffList = await call(`/post-log/admin/contacts?siteId=${capitalSite.id}`, { token: supervisor });
log(staffList.data.contacts.some((c) => c.id === newId && c.added_by_client_name), 'supervisors see it, with the client who added it');
log((await call(`/post-log/admin/contacts?siteId=${capitalSite.id}`, { token: marcus })).status === 403, 'officers do not manage contacts');
const staffAdd = await call('/post-log/admin/contacts', {
  token: supervisor, method: 'POST', body: { siteId: capitalSite.id, name: 'Capital Towing', role: 'Towing', phone: '(850) 555-0777', sort: 9 },
});
log(staffAdd.status === 201, 'a supervisor adds one too');
log((await call('/client/contacts', { token: capital })).data.sites[0].contacts.some((c) => c.name === 'Capital Towing' && c.added_by === 'us'),
  'and the client sees it as ours');
log((await call(`/client/contacts/${newId}`, { token: capital, method: 'DELETE' })).status === 200, 'the client removes their own');

/* ================================================================ feedback === */
section('client feedback');

const rate = (token, body) => call('/client/feedback', { token, method: 'POST', body });
log((await rate(capital, { siteId: capitalSite.id, rating: 6 })).status === 422, 'a rating is one to five');
log((await rate(capital, { siteId: capitalSite.id, rating: 1 })).status === 422, 'a low one has to say why');
log((await rate(pensacola, { siteId: capitalSite.id, rating: 5 })).status === 404, "nobody rates another client's property");
const low = await rate(capital, { siteId: capitalSite.id, rating: 2, comment: 'Gate officer left early twice this month.' });
log(low.status === 201 && low.data.feedback.rating === 2, 'a client rates the month');
const again = await rate(capital, { siteId: capitalSite.id, rating: 2, comment: 'Gate officer left early three times this month.' });
log(again.status === 201 && again.data.feedback.id === low.data.feedback.id, 'rating again the same month replaces it');

const board = await call('/admin/feedback', { token: supervisor });
const theirs = board.data.feedback.find((f) => f.id === low.data.feedback.id);
log(board.status === 200 && theirs && /three times/.test(theirs.comment), 'supervisors see it');
log(board.data.needsReply >= 1 && typeof board.data.average === 'number', 'with the unanswered low ratings counted');
log((await call('/admin/dashboard', { token: supervisor })).data.counts.unhappyClients >= 1, 'on the dashboard too');
log((await call(`/admin/feedback/${theirs.id}/respond`, { token: supervisor, method: 'POST', body: { response: 'ok' } })).status === 422,
  'a reply has to say something');
const reply = await call(`/admin/feedback/${theirs.id}/respond`, {
  token: supervisor, method: 'POST', body: { response: 'Sorry - the officer has been moved and a supervisor now checks the gate at 5 PM.' },
});
log(reply.status === 200, 'a supervisor replies');
const history = await call('/client/feedback', { token: capital });
log(history.data.feedback.find((f) => f.id === theirs.id)?.response?.includes('supervisor now checks'), 'and the client reads the reply');
log(!JSON.stringify(history.data).includes('responded_by'), 'without the name of who wrote it');
log((await call('/admin/feedback', { token: marcus })).status === 403, 'officers do not see client feedback');

/* ================================================================== exports === */
section('CSV exports');

const csv = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${supervisor}` } });
  return { status: res.status, type: res.headers.get('content-type') || '', disposition: res.headers.get('content-disposition') || '', text: await res.text() };
};
for (const [label, path, header] of [
  ['visitors on site', '/post-log/admin/visitors?onSite=1&format=csv', 'Name,Company'],
  ['vehicle violations', '/post-log/admin/vehicles?format=csv', 'Plate,State'],
  ['activity log', '/post-log/admin/activity?format=csv', 'When,Site'],
  ['building issues', '/post-log/admin/issues?status=all&format=csv', 'Reported,Site'],
  ['lost and found', '/post-log/admin/found?status=all&format=csv', 'Found,Item'],
  ['scorecards', '/admin/scorecards?format=csv', 'Officer,Code'],
  ['client feedback', '/admin/feedback?format=csv', 'Month,Site'],
]) {
  const r = await csv(path);
  const lines = r.text.replace(/^﻿/, '').split('\r\n');
  log(r.status === 200 && r.type.includes('text/csv') && /attachment; filename=".+\.csv"/.test(r.disposition) && lines[0].startsWith(header) && lines.length > 1,
    `${label} download as CSV`, `${lines.length - 1} rows`);
}

// A value a spreadsheet would run as a formula comes out inert.
await call('/post-log/activity', { token: marcus, method: 'POST', body: { category: 'other', body: '=HYPERLINK("http://evil.example","click")' } });
const act = await csv('/post-log/admin/activity?format=csv');
log(act.text.includes(`"'=HYPERLINK(`) && !/(^|,)=HYPERLINK/m.test(act.text), 'a value starting with = is neutralised in the export');
const officerCsv = await fetch(`${BASE}/post-log/admin/activity?format=csv`, { headers: { authorization: `Bearer ${marcus}` } });
log(officerCsv.status === 403, 'officers cannot download the exports');

/* ========================================================= monthly report === */
section('monthly service report');

const monthly = (token, q = '') => call(`/client/monthly${q}`, { token });
const now = new Date();
const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const lastMonth = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;

const report = await monthly(capital);
const r = report.data;
log(report.status === 200 && r.month === thisMonth && r.partial === true && r.site?.id === capitalSite.id,
  "a client's report defaults to this month so far, for their property");
log(r.posts.reduce((a, p) => a + p.scheduled, 0) === r.coverage.scheduled && r.posts.reduce((a, p) => a + p.covered, 0) === r.coverage.covered,
  'the posts add up to the totals');
log(r.coverage.covered <= r.coverage.scheduled && (r.coverage.pct === null || (r.coverage.pct >= 0 && r.coverage.pct <= 100)),
  'coverage is a fair percentage', `${r.coverage.pct}%`);
log(r.patrols.scanned + r.patrols.skipped <= r.patrols.checkpoints, 'checkpoints scanned and skipped never exceed those on the rounds');
log(r.incidents.list.length === r.incidents.total && Object.values(r.incidents.bySeverity).reduce((a, b) => a + b, 0) === r.incidents.total,
  'incidents are listed in full and counted by severity');
log(!JSON.stringify(r).match(/pay_rate|bill_rate|margin|employee_code|first_name/), 'no pay, bill rate or staff detail in the report');
const previous = await monthly(capital, `?month=${lastMonth}`);
log(previous.status === 200 && previous.data.partial === false && previous.data.month === lastMonth, 'last month is a whole month');
const pensacolaSite = (await call('/client/me', { token: pensacola })).data.sites[0].id;
log((await monthly(capital, `?siteId=${pensacolaSite}`)).status === 404, "a client cannot read another client's property");
log((await monthly(capital, '?month=2026-13')).status === 422, 'a month has to be a real month');
log((await monthly(capital, `?month=${now.getFullYear() + 1}-01`)).status === 422, 'and not one that has not started');
log((await monthly(capital, '?month=2019-01')).status === 422, 'reports go back two years');
log([401, 403].includes((await call('/client/monthly', { token: marcus })).status), 'staff tokens do not open the client report');

finish('Contacts, feedback and exports');
