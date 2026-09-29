/**
 * The activity log, building issues and lost and found.
 *
 * The lines drawn here: an officer writes only to the post they are on and
 * only for the shift they are working; the client reads the activity log
 * without the entries marked internal, and acts on their own building's
 * issues and nobody else's; property leaves lost and found only with a
 * record of who took it, and only a supervisor disposes of it.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812'); // on duty at Riverfront
const clientSignIn = async (email, password) =>
  (await call('/client/login', { method: 'POST', body: { email, password } })).data?.token;
const dana = await clientSignIn('dana.whitfield@riverfrontholdings.com', 'riverfront-portal-01');
const pensacola = await clientSignIn('rpike@emeraldcoastlogistics.com', 'pensacola-portal-05');
log(Boolean(supervisor && marcus && dana && pensacola), 'signed in as staff and two client contacts');

let offDuty = null;
for (const [code, pin] of [['1004', '5930'], ['1006', '7285'], ['1008', '9351'], ['1005', '6174']]) {
  const token = await signIn(code, pin);
  if (!(await call('/post-log', { token })).data.onDuty) {
    offDuty = token;
    break;
  }
}

const site = await call('/post-log/site', { token: marcus });
log(site.status === 200 && /Riverfront/.test(site.data.post?.site_name), "an officer on post reads their site's logs");
log(site.data.activity.every((a) => a.site_id === site.data.post.site_id), 'only their own site');
const riverfront = site.data.post.site_id;

/* ================================================================ activity === */
section('the activity log');

const write = (body, token = marcus) => call('/post-log/activity', { token, method: 'POST', body });
log((await write({ body: 'ok' })).status === 422, 'an entry has to say something');
log((await write({ body: 'Rounds complete.', category: 'napping' })).status === 422, 'and be a known kind');
log((await write({ body: 'Rounds complete.' }, offDuty)).status === 409, 'an officer off duty cannot write one');
log((await write({ body: 'Rounds complete.', occurredAt: new Date(Date.now() + 3600000).toISOString() })).status === 422,
  'nor date one in the future');
log((await write({ body: 'Rounds complete.', occurredAt: new Date(Date.now() - 30 * 86400000).toISOString() })).status === 422,
  'nor before the shift began');

const tag = `Test entry ${Date.now()}`;
const visible = await write({ body: `${tag}: east doors secure`, category: 'patrol' });
log(visible.status === 201 && visible.data.entry.client_visible && visible.data.entry.officer_name === 'Marcus Bell',
  'an entry is logged under the officer, for the client to see');
const internal = await write({ body: `${tag}: radio swapped`, category: 'other', clientVisible: false });
log(internal.status === 201 && internal.data.entry.client_visible === false, 'or marked internal');

const clientDar = await call('/client/dar', { token: dana });
log(clientDar.data.activity.some((a) => a.body.includes('east doors secure')), "the client's daily report shows the entry");
log(!clientDar.data.activity.some((a) => a.body.includes('radio swapped')), 'but not the internal one');
log(!(await call('/client/dar', { token: pensacola })).data.activity.some((a) => a.body.includes(tag)), "nor does another client's");
const dar = await call(`/reports/dar?siteId=${riverfront}`, { token: supervisor });
log(dar.data.activity.some((a) => a.body.includes('radio swapped') && a.client_visible === false),
  'the internal report shows both, marked');

const someoneElse = site.data.activity.find((a) => a.user_id && a.officer_name !== 'Marcus Bell');
if (someoneElse) {
  log((await call(`/post-log/activity/${someoneElse.id}`, { token: marcus, method: 'DELETE' })).status === 403,
    "an officer cannot remove someone else's entry");
}
log((await call(`/post-log/activity/${internal.data.entry.id}`, { token: marcus, method: 'DELETE' })).status === 200,
  'but can remove their own from this shift');

/* ================================================================== issues === */
section('building issues');

const report = (body, token = marcus) => call('/post-log/issues', { token, method: 'POST', body });
log((await report({ category: 'leak', description: 'wet' })).status === 422, 'an issue needs a description');
log((await report({ category: 'ghosts', description: 'Strange noises.' })).status === 422, 'and a known category');
log((await report({ category: 'leak', description: 'Water under the sink.' }, offDuty)).status === 409, 'an officer off duty cannot report one');
const issue = await report({ category: 'lighting', priority: 'urgent', locationText: 'Garage level 3', description: `${tag}: all lights out on level 3.` });
log(issue.status === 201 && issue.data.issue.status === 'open' && issue.data.issue.priority === 'urgent', 'an officer reports an urgent issue');
const id = issue.data.issue.id;

const list = await call('/client/issues', { token: dana });
const seen = list.data.issues.find((i) => i.id === id);
log(seen && seen.status === 'open', 'the client sees it in the portal');
log(seen && !('reported_by' in seen) && !('reported_by_name' in seen), 'without the name of the officer who reported it');
log(!(await call('/client/issues', { token: pensacola })).data.issues.some((i) => i.id === id), 'another client does not see it');
log((await call(`/client/issues/${id}/status`, { token: pensacola, method: 'POST', body: { status: 'fixed' } })).status === 404,
  'and cannot close it');
log((await call(`/client/issues/${id}/status`, { token: marcus, method: 'POST', body: { status: 'fixed' } })).status === 401,
  'a staff session is not a client session');

const ack = await call(`/client/issues/${id}/status`, { token: dana, method: 'POST', body: { status: 'acknowledged', note: 'Electrician booked for 9 AM.' } });
log(ack.status === 200 && ack.data.issue.status === 'acknowledged' && ack.data.issue.acknowledged_at, 'the client acknowledges it with a note');
const officerView = (await call('/post-log/site', { token: marcus })).data.issues.find((i) => i.id === id);
log(officerView?.client_note === 'Electrician booked for 9 AM.', 'and the officer on post sees the reply');
const fixed = await call(`/client/issues/${id}/status`, { token: dana, method: 'POST', body: { status: 'fixed' } });
log(fixed.status === 200 && fixed.data.issue.status === 'fixed' && fixed.data.issue.closed_by_name, 'then marks it fixed, recorded against them');
log((await call(`/client/issues/${id}/status`, { token: dana, method: 'POST', body: { status: 'acknowledged' } })).status === 409,
  'a fixed issue stays closed for the client');

log((await call(`/post-log/issues/${id}/status`, { token: marcus, method: 'POST', body: { status: 'open' } })).status === 403,
  'an officer cannot reopen it');
const reopened = await call(`/post-log/issues/${id}/status`, { token: supervisor, method: 'POST', body: { status: 'open', note: 'Still dark - two lights only.' } });
log(reopened.status === 200 && reopened.data.issue.status === 'open' && !reopened.data.issue.fixed_at, 'a supervisor can reopen it');
const adminIssues = await call('/post-log/admin/issues', { token: supervisor });
log(adminIssues.data.issues.some((i) => i.id === id) && adminIssues.data.issues.every((i) => i.status !== 'fixed'),
  'supervisors see every unresolved issue');
log((await call('/admin/dashboard', { token: supervisor })).data.counts.openIssues >= 1, 'counted on the dashboard');
log((await call('/client/dar', { token: dana })).data.issues.some((i) => i.id === id), "and it is in the day's client report");

/* ============================================================ lost & found === */
section('lost and found');

const logFound = (body, token = marcus) => call('/post-log/found', { token, method: 'POST', body });
log((await logFound({ description: 'Blue umbrella' })).status === 422, 'a found item needs a place it is kept');
const item = await logFound({ description: `${tag} blue umbrella`, category: 'other', foundLocation: 'Lobby', storedLocation: 'Security desk' });
log(item.status === 201 && item.data.item.status === 'held' && item.data.item.found_by_name === 'Marcus Bell', 'an officer logs an item');
const iid = item.data.item.id;
const close = (itemId, body, token = marcus) => call(`/post-log/found/${itemId}/close`, { token, method: 'POST', body });

log((await close(iid, { status: 'returned', returnedTo: 'Jo' })).status === 422, 'handing it back needs a name and a contact');
log((await close(iid, { status: 'disposed' })).status === 403, 'an officer cannot dispose of property');
log((await close(iid, { status: 'returned', returnedTo: 'Jo Smith', returnedContact: '(904) 555-0199' }, offDuty)).status === 409,
  'an officer off duty cannot hand anything back');
const back = await close(iid, { status: 'returned', returnedTo: 'Jo Smith', returnedContact: '(904) 555-0199' });
log(back.status === 200 && back.data.item.status === 'returned' && back.data.item.closed_by_name === 'Marcus Bell',
  'it goes back to its owner, with who handed it over');
log((await close(iid, { status: 'returned', returnedTo: 'Jo Smith', returnedContact: '(904) 555-0199' })).status === 409,
  'and cannot go back twice');

const held = await call('/post-log/admin/found', { token: supervisor });
log(held.status === 200 && held.data.items.every((f) => f.status === 'held') && typeof held.data.overdue === 'number',
  'supervisors see everything still held');
const toDispose = held.data.items[0];
if (toDispose) {
  const gone = await close(toDispose.id, { status: 'disposed' }, supervisor);
  log(gone.status === 200 && gone.data.item.status === 'disposed', 'and can dispose of an item');
}
log((await call('/post-log/admin/found', { token: marcus })).status === 403, "officers do not see every site's property");

finish('Activity log, issues and lost and found');
