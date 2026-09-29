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

import { call, log, section, signIn, finish } from './harness.mjs';

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

finish('Post orders, alerts and QR tags');
