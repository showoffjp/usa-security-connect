/**
 * Post orders, the supervisor alerts inbox and QR checkpoint tags.
 *
 * Post orders are versioned, never edited in place, and each version needs
 * acknowledging by the officers on the post - so the lines to hold are that
 * an officer can only acknowledge the version in force, that a change from
 * either the orders screen or the Sites screen makes a new version, and that
 * the supervisor's list of who has not read it is right. The alerts inbox is
 * computed from the records; only the read marks are kept, per person. A
 * checkpoint accepts its NFC tag, its QR code or its printed checkpoint code,
 * and nothing else.
 */

import { BASE, call, log, section, signIn, finish, localDay } from './harness.mjs';

const supervisor = await signIn('1002', '3571');
const admin = await signIn('1001', '2468');
const marcus = await signIn('1003', '4812'); // on duty at the Riverfront lobby
log(Boolean(supervisor && admin && marcus), 'signed in as supervisor, administrator and an officer on post');

/* ============================================================ post orders === */
section('post orders: the officer');

const home = await call('/post-log', { token: marcus });
const orders = home.data.orders;
const postId = home.data.post.post_id;
log(home.status === 200 && orders?.version >= 2, 'the officer on post is given the orders in force', `v${orders?.version}`);
log(orders.acked_at === null, 'the new version is waiting for them to read it');
log(Boolean(orders.change_note && orders.author_name), 'with what changed and who changed it');

const history = await call(`/post-log/admin/orders/${postId}/history`, { token: supervisor });
const older = history.data.versions.find((v) => v.version < orders.version);
log(history.status === 200 && history.data.versions[0].id === orders.id && older, 'the history keeps every version, newest first');
log((await call(`/post-log/orders/${older.id}/ack`, { token: marcus, method: 'POST' })).status === 409,
  'an old version cannot be acknowledged');
log((await call(`/post-log/orders/999999/ack`, { token: marcus, method: 'POST' })).status === 404, 'nor orders that do not exist');

const before = await call('/post-log/admin/orders', { token: supervisor });
const lobby = before.data.posts.find((p) => p.id === postId);
log(lobby.outstanding.some((o) => o.name === 'Marcus Bell'), 'the supervisor sees who has not read it');

const ack = await call(`/post-log/orders/${orders.id}/ack`, { token: marcus, method: 'POST' });
log(ack.status === 200 && ack.data.orders.acked_at, 'the officer acknowledges the orders');
log((await call(`/post-log/orders/${orders.id}/ack`, { token: marcus, method: 'POST' })).status === 200, 'acknowledging twice is harmless');

const after = await call('/post-log/admin/orders', { token: supervisor });
const lobbyAfter = after.data.posts.find((p) => p.id === postId);
log(!lobbyAfter.outstanding.some((o) => o.name === 'Marcus Bell') && lobbyAfter.acked.some((a) => a.name === 'Marcus Bell'),
  'and moves from outstanding to acknowledged');
log(after.data.outstandingTotal === before.data.outstandingTotal - 1, 'the outstanding total drops by one');

section('post orders: issuing a new version');

const issue = (token, body) => call('/post-log/admin/orders', { token, method: 'POST', body });
log((await issue(marcus, { postId, body: 'Officers do not issue their own orders.' })).status === 403, 'officers cannot issue orders');
log((await issue(supervisor, { postId, body: 'Too short' })).status === 422, 'orders have to say something');
log((await issue(supervisor, { postId, body: orders.body })).status === 409, 'the same text again is not a new version');
log((await issue(supervisor, { postId: 999999, body: 'Orders for a post that is not there.' })).status === 404, 'nor orders for a missing post');

const v3Text = `${orders.body}\nFrom tonight: north doors lock at 18:00.`;
const v3 = await issue(supervisor, { postId, body: v3Text, changeNote: 'North doors now lock at 18:00' });
log(v3.status === 201 && v3.data.order.version === orders.version + 1, 'a supervisor issues a new version', `v${v3.data.order?.version}`);

const reread = await call('/post-log', { token: marcus });
log(reread.data.orders.id === v3.data.order.id && reread.data.orders.acked_at === null,
  'the officer has to acknowledge the new version');
const viaSites = await call(`/admin/posts/${postId}`, {
  token: admin, method: 'PATCH', body: { instructions: `${v3Text}\nRadio check with dispatch on the hour.` },
});
log(viaSites.status === 200, 'an edit on the Sites screen is accepted');
const v4 = await call('/post-log', { token: marcus });
log(v4.data.orders.version === v3.data.order.version + 1 && /Radio check/.test(v4.data.orders.body),
  'and becomes the next version too');
const unchanged = await call(`/admin/posts/${postId}`, { token: admin, method: 'PATCH', body: { name: home.data.post.post_name } });
const still = await call('/post-log', { token: marcus });
log(unchanged.status === 200 && still.data.orders.version === v4.data.orders.version, 'editing anything else leaves the orders alone');

const fullHistory = await call(`/post-log/admin/orders/${postId}/history`, { token: supervisor });
log(fullHistory.data.versions.length === history.data.versions.length + 2, 'both new versions are on record');
log(fullHistory.data.versions.find((v) => v.id === orders.id)?.acks >= 1, 'with who acknowledged each');
log((await call(`/post-log/admin/orders/${postId}/history`, { token: marcus })).status === 403, 'officers do not see the admin history');
log((await call('/post-log/admin/orders?siteId=abc', { token: supervisor })).status === 422, 'a junk site filter is refused');

/* ================================================================ alerts === */
section('alerts inbox');

const inbox = await call('/admin/alerts', { token: supervisor });
const alerts = inbox.data.alerts;
log(inbox.status === 200 && alerts.length > 5, 'the supervisor has an inbox', `${alerts.length} alerts, ${inbox.data.unread} unread`);
log(alerts.every((a) => a.key && a.title && a.link?.startsWith('/admin') && ['critical', 'warning', 'info'].includes(a.severity)),
  'each alert says what it is, how serious, and where to deal with it');
const kinds = new Set(alerts.map((a) => a.kind));
log(['flag', 'watchlist', 'issue', 'feedback'].every((k) => kinds.has(k)), 'drawn from flags, the watchlist, building issues and feedback',
  [...kinds].join(', '));
const rank = { critical: 0, warning: 1, info: 2 };
log(alerts.every((a, i) => i === 0 || rank[alerts[i - 1].severity] <= rank[a.severity]), 'the most serious come first');
log((await call('/admin/alerts', { token: marcus })).status === 403, 'officers have no alerts inbox');

const first = alerts[0];
const marked = await call('/admin/alerts/read', { token: supervisor, method: 'POST', body: { keys: [first.key] } });
log(marked.status === 200 && marked.data.unread === inbox.data.unread - 1, 'opening an alert marks it read');
const reread2 = await call('/admin/alerts', { token: supervisor });
log(reread2.data.alerts.at(-1).key === first.key || reread2.data.alerts.find((a) => a.key === first.key).read,
  'and it drops below the unread ones');
const adminInbox = await call('/admin/alerts', { token: admin });
log(adminInbox.data.alerts.find((a) => a.key === first.key)?.read === false, 'read marks are per person');
log((await call('/admin/alerts/read', { token: supervisor, method: 'POST', body: {} })).status === 422, 'marking nothing is refused');
log((await call('/admin/alerts/read', { token: supervisor, method: 'POST', body: { keys: 'flag:1' } })).status === 422, 'keys must be a list');
const all = await call('/admin/alerts/read', { token: supervisor, method: 'POST', body: { all: true } });
log(all.status === 200 && all.data.unread === 0, 'mark all read clears the badge');
const coverage = reread2.data.alerts.find((a) => a.kind === 'coverage');
log(!coverage || (coverage.detailAt && !Number.isNaN(Date.parse(coverage.detailAt))), 'dates are sent as dates, for the browser to format');

/* =============================================================== QR tags === */
section('QR checkpoint tags');

const siteId = home.data.post.site_id;
const built = await call('/admin/tours', {
  token: admin, method: 'POST',
  body: {
    siteId, name: 'QR tag test walk',
    checkpoints: [
      { name: 'QR only', qrCode: 'USC-QR-TEST-1' },
      { name: 'NFC and QR', nfcTagId: 'USC-NFC-TEST-2', qrCode: 'USC-QR-TEST-2' },
      { name: 'No tag', required: false },
      { name: 'No tag either', required: false },
    ],
  },
});
log(built.status === 201, 'a tour is built with QR, NFC and untagged checkpoints');
const detail = await call(`/admin/tours/${built.data.tourId}`, { token: supervisor });
log(detail.status === 200 && detail.data.checkpoints.length === 4, 'the tag sheet has every checkpoint');
log((await call('/admin/tours/abc', { token: supervisor })).status === 422, 'a junk tour id is refused');

// Earlier suites can leave this officer part-way round another tour; finish
// it the way an officer would, skipping what is left with a reason.
const begin = () => call(`/tours/${built.data.tourId}/start`, { token: marcus, method: 'POST' });
let start = await begin();
if (start.status === 409 && start.data.details?.activeRunId) {
  const active = start.data.details.activeRunId;
  const open = await call(`/tours/runs/${active}`, { token: marcus });
  for (const c of open.data.checkpoints.filter((x) => x.status === 'pending')) {
    await call(`/tours/runs/${active}/checkpoints/${c.checkpoint_id}/skip`, {
      token: marcus, method: 'POST', body: { reason: 'Ended by the test suite' },
    });
  }
  await call(`/tours/runs/${active}/complete`, { token: marcus, method: 'POST' });
  start = await begin();
}
log(start.status === 201, 'the officer starts the walk');
const runId = start.data.run.id;
const cp = (name) => start.data.checkpoints.find((c) => c.name === name);
const scan = (c, tagId, method = 'qr') =>
  call(`/tours/runs/${runId}/checkpoints/${c.checkpoint_id}/scan`, { token: marcus, method: 'POST', body: { method, tagId } });

log((await scan(cp('QR only'), 'USC-QR-TEST-2')).status === 409, "another checkpoint's QR is refused");
log((await scan(cp('QR only'), 'usc-qr-test-1 ')).status === 200, 'its own QR is accepted, whatever the case');
log((await scan(cp('NFC and QR'), 'USC-QR-TEST-2')).status === 200, 'a checkpoint with both takes the QR');
const noTag = cp('No tag');
const otherCode = `USC-CP-${cp('No tag either').checkpoint_id}`;
log((await scan(noTag, otherCode)).status === 409, "an untagged checkpoint refuses another checkpoint's printed code");
const own = await scan(noTag, `USC-CP-${noTag.checkpoint_id}`);
log(own.status === 200, 'and accepts its own printed code');
const recorded = own.data.checkpoints.find((c) => c.checkpoint_id === cp('QR only').checkpoint_id);
log(recorded.method === 'qr', 'the scan is recorded as a QR scan');
const manual = await call(`/tours/runs/${runId}/checkpoints/${cp('No tag either').checkpoint_id}/scan`, {
  token: marcus, method: 'POST', body: { method: 'manual' },
});
log(manual.status === 200 && manual.data.checkpoints.find((c) => c.name === 'No tag either').method === 'manual',
  'marking a checkpoint visited without a tag is recorded as manual, not as a scan');
await call(`/tours/runs/${runId}/complete`, { token: marcus, method: 'POST' });

/* ================================================ client change requests === */
section('post orders: clients asking for changes');

const clientSignIn = async (email, password) =>
  (await call('/client/login', { method: 'POST', body: { email, password } })).data?.token;
const gulfport = await clientSignIn('alicia.grant@gulfportfreight.com', 'gulfport-portal-03');
const pensacola = await clientSignIn('rpike@emeraldcoastlogistics.com', 'pensacola-portal-05');
log(Boolean(gulfport && pensacola), 'signed in as two client contacts');

const theirs = await call('/client/post-orders', { token: gulfport });
const gpSite = theirs.data.sites[0];
const gpPost = gpSite?.posts.find((p) => p.order);
log(theirs.status === 200 && theirs.data.sites.length >= 1 && gpPost, 'a client reads the orders in force at their posts', gpPost?.name);
log(theirs.data.sites.every((x) => x.posts.every((p) => !p.order || (!('created_by' in p.order) && !('author_name' in p.order)))),
  'without which of our staff wrote them');
const other = await call('/client/post-orders', { token: pensacola });
log(!other.data.sites.some((x) => x.id === gpSite.id), "and cannot see another client's property");

const ask = (token, body) => call('/client/post-orders/requests', { token, method: 'POST', body });
log((await ask(gulfport, { postId: gpPost.id, body: 'More' })).status === 422, 'a request has to say what should change');
log((await ask(pensacola, { postId: gpPost.id, body: 'Please check the north gate every hour.' })).status === 404,
  "a client cannot ask about another client's post");
log((await ask(gulfport, { postId: 999999, body: 'Please check the north gate every hour.' })).status === 404, 'nor a post that is not there');
const asked = await ask(gulfport, { postId: gpPost.id, body: 'Please check the north gate chain and padlock every hour after dark.' });
const askedRow = asked.data.sites?.flatMap((x) => x.posts).find((p) => p.id === gpPost.id)?.requests[0];
log(asked.status === 201 && askedRow?.status === 'open' && askedRow.mine === true, 'a client asks for a change');
const second = await ask(gulfport, { postId: gpPost.id, body: 'Please also log every truck that parks overnight.' });
await ask(gulfport, { postId: gpPost.id, body: 'And confirm the yard lights are on at dusk.' });
log((await ask(gulfport, { postId: gpPost.id, body: 'A fourth request while three are waiting.' })).status === 409,
  'no more than three waiting at once for one post');
const secondId = second.data.sites.flatMap((x) => x.posts).find((p) => p.id === gpPost.id).requests.find((r) => /truck/.test(r.body)).id;
log((await call(`/client/post-orders/requests/${secondId}/withdraw`, { token: pensacola, method: 'POST' })).status === 404,
  'another client cannot withdraw it');
const withdrawn = await call(`/client/post-orders/requests/${secondId}/withdraw`, { token: gulfport, method: 'POST' });
log(withdrawn.status === 200 && withdrawn.data.sites.flatMap((x) => x.posts).flatMap((p) => p.requests).find((r) => r.id === secondId).status === 'withdrawn',
  'the client withdraws one of theirs');

const staffView = await call('/post-log/admin/orders', { token: supervisor });
const staffPost = staffView.data.posts.find((p) => p.id === gpPost.id);
const openReq = staffPost.requests.find((r) => r.id === askedRow.id);
log(openReq && openReq.client_name && staffPost.requests.every((r) => r.id !== secondId), 'supervisors see the open requests, with who asked');
log(staffView.data.requestsTotal >= 2, 'and how many are waiting', `${staffView.data.requestsTotal}`);
const inboxNow = await call('/admin/alerts', { token: supervisor });
log(inboxNow.data.alerts.some((a) => a.key === `order-request:${askedRow.id}` && a.link === '/admin/post-logs?tab=orders'),
  'each request is in the alerts inbox');
log(inboxNow.data.alerts.some((a) => a.kind === 'tour'), 'as are patrols finished with required checkpoints skipped');

const lobbyPostId = postId;
log((await issue(supervisor, { postId: lobbyPostId, body: `${gpPost.order.body} (wrong post)`, requestId: askedRow.id })).status === 422,
  'a request can only be applied to its own post');
const applied = await issue(supervisor, {
  postId: gpPost.id, body: `${gpPost.order.body}\nAfter dark: check the north gate chain and padlock every hour.`,
  changeNote: 'North gate checked hourly after dark', requestId: askedRow.id, response: 'Added from tonight.',
});
log(applied.status === 201, 'a supervisor applies it as a new version');
log((await issue(supervisor, { postId: gpPost.id, body: `${gpPost.order.body} again`, requestId: askedRow.id })).status === 409,
  'an answered request cannot be applied twice');
const clientAfter = await call('/client/post-orders', { token: gulfport });
const done = clientAfter.data.sites.flatMap((x) => x.posts).flatMap((p) => p.requests).find((r) => r.id === askedRow.id);
log(done.status === 'applied' && done.applied_version === applied.data.order.version && done.response === 'Added from tonight.',
  'the client sees it changed, in which version, with the reply');
log(clientAfter.data.sites.flatMap((x) => x.posts).find((p) => p.id === gpPost.id).order.version === applied.data.order.version,
  'and reads the new orders');

const lights = clientAfter.data.sites.flatMap((x) => x.posts).flatMap((p) => p.requests).find((r) => /yard lights/.test(r.body));
const decline = (token, id, body) => call(`/post-log/admin/order-requests/${id}/decline`, { token, method: 'POST', body });
log((await decline(marcus, lights.id, { response: 'Officers cannot do this.' })).status === 403, 'officers cannot answer client requests');
log((await decline(supervisor, lights.id, { response: 'No' })).status === 422, 'declining needs a reason the client can read');
log((await decline(supervisor, lights.id, { response: 'The yard lights are on a timer the landlord controls; we report any that are out.' })).status === 200,
  'a supervisor declines with a reason');
log((await decline(supervisor, lights.id, { response: 'Changed my mind about this one.' })).status === 409, 'and cannot answer it twice');
log((await decline(supervisor, 'abc', { response: 'Junk id in the path.' })).status === 422, 'a junk request id is refused');
const declined = (await call('/client/post-orders', { token: gulfport })).data.sites.flatMap((x) => x.posts).flatMap((p) => p.requests).find((r) => r.id === lights.id);
log(declined.status === 'declined' && /timer/.test(declined.response), 'the client sees it declined, with the reason');
const outbox = await call('/admin/emails', { token: admin });
log(['post_orders_changed', 'post_orders_declined'].every((k) => outbox.data.emails.some((e) => e.kind === k && /gulfport/.test(e.to_email))),
  'and is emailed both answers');
const inboxAfter = await call('/admin/alerts', { token: supervisor });
log(!inboxAfter.data.alerts.some((a) => a.key === `order-request:${askedRow.id}` || a.key === `order-request:${lights.id}`),
  'answered requests leave the alerts inbox');

/* ============================================================= follow-ups === */
section('incident follow-ups');

const fuBoard = await call('/incidents/follow-ups?show=all', { token: supervisor });
log(fuBoard.status === 200 && fuBoard.data.actions.length >= 5, 'supervisors see every follow-up across incidents', `${fuBoard.data.actions?.length}`);
log(fuBoard.data.actions.some((a) => a.overdue) && fuBoard.data.actions.some((a) => a.status === 'done'), 'with overdue and done ones among them');
log((await call('/incidents/follow-ups', { token: marcus })).status === 403, 'officers do not see the follow-up board');
const openOnly = await call('/incidents/follow-ups', { token: supervisor });
log(openOnly.data.actions.every((a) => a.status === 'open') && openOnly.data.counts.open === openOnly.data.actions.length,
  'the default list is the open ones, and the count matches');
const overdueOnly = await call('/incidents/follow-ups?show=overdue', { token: supervisor });
log(overdueOnly.data.actions.length === overdueOnly.data.counts.overdue && overdueOnly.data.actions.every((a) => a.overdue),
  'the overdue filter lists exactly the overdue ones');

// Work on an incident at the Pensacola client's property, so the client side can be checked too.
const pensacolaRefs = new Set(((await call('/client/incidents', { token: pensacola })).data.incidents || []).map((i) => i.ref_number));
const target = fuBoard.data.actions.find((a) => pensacolaRefs.has(a.ref_number)) || fuBoard.data.actions[0];
const incidentId = target.incident_id;
const staff = (await call('/admin/employees', { token: admin })).data.employees;
const renata = staff.find((e) => e.employee_code === '1002');
const officerRow = staff.find((e) => e.employee_code === '1003');
const addAction = (body, token = supervisor, id = incidentId) => call(`/incidents/${id}/actions`, { token, method: 'POST', body });
log((await addAction({ title: 'Fix' })).status === 422, 'a follow-up has to say what needs doing');
log((await addAction({ title: 'Replace the broken gate latch', ownerId: officerRow.id })).status === 422, 'an officer cannot own one');
log((await addAction({ title: 'Replace the broken gate latch', dueOn: 'next week' })).status === 422, 'the due date has to be a date');
log((await addAction({ title: 'Replace the broken gate latch' }, marcus)).status === 403, 'officers cannot add them');
log((await addAction({ title: 'Replace the broken gate latch' }, supervisor, 'abc')).status === 422, 'a junk incident id is refused');
log((await addAction({ title: 'Replace the broken gate latch' }, supervisor, 999999)).status === 404, 'and an unknown one is not found');
const yesterday = localDay(-1);
const created = await addAction({ title: 'Replace the broken gate latch', ownerId: renata.id, dueOn: yesterday, clientVisible: true });
const latch = created.data.actions?.find((a) => a.title === 'Replace the broken gate latch');
log(created.status === 201 && latch?.owner_name === 'Renata Diaz' && latch.due_on === yesterday && latch.overdue,
  'a supervisor adds one with an owner and a due date', latch?.due_on);
const secret = await addAction({ title: 'Review the officer statement with HR', clientVisible: false });
const hr = secret.data.actions.find((a) => a.title === 'Review the officer statement with HR');
log(secret.status === 201 && hr.client_visible === false && hr.owner_name === null, 'an internal one, with nobody yet');

const mineNow = await call('/incidents/follow-ups?show=mine', { token: supervisor });
log(mineNow.data.actions.some((a) => a.id === latch.id) && mineNow.data.actions.every((a) => a.owner_id === renata.id),
  "'mine' lists the caller's own");
const inboxFu = await call('/admin/alerts', { token: supervisor });
log(inboxFu.data.alerts.some((a) => a.key === `followup:${latch.id}:${yesterday}` && a.kind === 'followup'), 'an overdue follow-up is in the alerts inbox');

const incDetail = await call(`/incidents/${incidentId}`, { token: supervisor });
log(incDetail.data.actions?.some((a) => a.id === latch.id), 'the incident carries its follow-ups');
const ownForm = new FormData();
ownForm.append('category', 'Disturbance');
ownForm.append('severity', 'medium');
ownForm.append('occurredAt', new Date().toISOString());
ownForm.append('whatHappened', 'Test incident for the follow-up visibility checks.');
const ownIncident = await (await fetch(`${BASE}/incidents`, { method: 'POST', headers: { authorization: `Bearer ${marcus}` }, body: ownForm })).json();
await addAction({ title: 'Speak to the tenant about the noise' }, supervisor, ownIncident.incident.id);
const ownView = await call(`/incidents/${ownIncident.incident.id}`, { token: marcus });
log(ownView.status === 200 && Array.isArray(ownView.data.actions) && ownView.data.actions.length === 0,
  'the officer who filed an incident opens it without its follow-ups');

const markDone = (id, body, token = supervisor) => call(`/incidents/actions/${id}`, { token, method: 'PATCH', body });
log((await markDone(latch.id, { status: 'done' })).status === 422, 'marking one done needs what was done');
log((await markDone(latch.id, { status: 'done', note: 'Latch replaced.' }, marcus)).status === 403, 'officers cannot close them');
log((await markDone('abc', { status: 'done', note: 'Latch replaced.' })).status === 422, 'a junk follow-up id is refused');
log((await markDone(999999, { status: 'done', note: 'Latch replaced.' })).status === 404, 'and an unknown one is not found');
const closed = await markDone(latch.id, { status: 'done', note: 'Latch replaced by the property manager on Tuesday.' });
const doneRow = closed.data.actions.find((a) => a.id === latch.id);
log(closed.status === 200 && doneRow.status === 'done' && !doneRow.overdue && doneRow.done_by_name === 'Renata Diaz' && doneRow.done_at,
  'a supervisor marks it done, with who and when');
log(!(await call('/admin/alerts', { token: supervisor })).data.alerts.some((a) => a.key.startsWith(`followup:${latch.id}:`)), 'and it leaves the alerts inbox');
const updates = async () => ((await call('/admin/emails?limit=300', { token: admin })).data.emails || [])
  .filter((e) => e.kind === 'incident_update' && e.subject.includes('Replace the broken gate latch'));
const sentUpdate = await updates();
log(sentUpdate.some((e) => /rpike@/.test(e.to_email)), 'the client is emailed that a shared follow-up is done',
  sentUpdate.map((e) => e.to_email).join(', '));
const updateBody = (await call(`/admin/emails/${sentUpdate[0]?.id}`, { token: admin })).data.email?.body || '';
log(/now done/.test(updateBody) && !/property manager on Tuesday/.test(updateBody) && !/Renata/.test(updateBody),
  'without our note on how it was done or who did it');

const incidentRef = incDetail.data.incident.ref_number;
const clientList = (await call('/client/incidents', { token: pensacola })).data;
const clientRow = (clientList.incidents || []).find((i) => i.ref_number === incidentRef);
if (clientRow) {
  const clientView = await call(`/client/incidents/${clientRow.id}`, { token: pensacola });
  const seen = clientView.data.actions || [];
  log(seen.some((a) => a.id === latch.id && a.status === 'done'), 'the client sees what was done on their incident');
  log(!seen.some((a) => a.id === hr.id), 'but not the internal follow-up');
  log(seen.every((a) => !('owner_id' in a) && !('done_note' in a) && !('owner_name' in a)), 'nor who owns them or the internal note');
} else {
  log(false, 'the seeded incident belongs to the Pensacola client', incidentRef);
}

const reopened = await markDone(latch.id, { status: 'open' });
const reRow = reopened.data.actions.find((a) => a.id === latch.id);
log(reopened.status === 200 && reRow.status === 'open' && reRow.done_note === null && reRow.overdue, 'reopening clears the note and it is overdue again');
await markDone(latch.id, { status: 'done', note: 'Latch replaced by the property manager on Tuesday.' });
await markDone(hr.id, { status: 'done', note: 'Reviewed with HR, no further action.' });
log((await updates()).length === sentUpdate.length, 'closing it again after a reopen does not email twice');
const hrMail = ((await call('/admin/emails?limit=300', { token: admin })).data.emails || []).filter((e) => e.subject.includes('officer statement'));
log(hrMail.length === 0, 'and an internal follow-up is never emailed');

/* ======================================================= incident reports === */
section('incident reports');

const catalogue = (await call('/admin/reports', { token: admin })).data.reports;
log(['incidents-by-site', 'incidents-by-category', 'incidents-daily'].every((id) => catalogue.some((r) => r.id === id && r.group === 'Incidents')),
  'the three incident reports are in the catalogue');
const yearAgo = localDay(-360);
const range = `from=${yearAgo}&to=${localDay()}`;
log((await call('/admin/reports/incidents-by-site?from=2020-01-01&to=2030-12-31', { token: admin })).status === 422, 'a range longer than a year is refused');
const bySite = await call(`/admin/reports/incidents-by-site?${range}`, { token: admin });
const byCat = await call(`/admin/reports/incidents-by-category?${range}`, { token: admin });
log(bySite.status === 200 && bySite.data.totals.total > 0 && bySite.data.rows.reduce((n, r) => n + r.total, 0) === bySite.data.totals.total,
  'incidents by site adds up', `${bySite.data.totals?.total}`);
log(byCat.status === 200 && byCat.data.totals.total === bySite.data.totals.total, 'by type counts the same incidents');
log(bySite.data.rows.every((r) => r.open <= r.total && r.police <= r.total), 'police and still-open never exceed the total');
const lastMonth = localDay(-30);
const todayStr = localDay();
const daily = await call(`/admin/reports/incidents-daily?from=${lastMonth}&to=${todayStr}`, { token: admin });
log(daily.status === 200 && daily.data.rows.length >= 28 && daily.data.chart?.series === 'time', 'by day has a row for every day in the range', `${daily.data.rows?.length}`);
const siteScoped = await call(`/admin/reports/incidents-by-site?${range}&siteId=${incDetail.data.incident.site_id}`, { token: admin });
log(siteScoped.status === 200, 'a report can be scoped to one site');
const csvRes = await fetch(`${BASE}/admin/reports/incidents-by-category/export.csv?${range}`, { headers: { authorization: `Bearer ${admin}` } });
const csvText = await csvRes.text();
log(csvRes.ok && /text\/csv/.test(csvRes.headers.get('content-type')) && csvText.split('\n')[0].startsWith('Type,Incidents') && /\nTOTAL,/.test(csvText),
  'and exports as a CSV with a total row');
log((await call(`/admin/reports/incidents-by-site?${range}`, { token: marcus })).status === 403, 'officers cannot run reports');

finish('Post orders, alerts, QR tags and incident follow-ups');
