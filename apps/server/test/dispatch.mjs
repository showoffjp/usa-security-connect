/**
 * Dispatch: calls for service from raised to cleared.
 *
 * A call goes only to an officer on the clock; only that officer (or a
 * supervisor) can move it on; it is timed at every step; a client sees their
 * own property's calls and nobody else's; and an officer cannot clock out
 * holding one - it goes back on the board.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const alexis = await signIn('1042', '8598'); // a floater with nothing rostered
log(Boolean(admin && supervisor && marcus && alexis), 'signed in as administrator, supervisor and two officers');

const clientToken = async (email, password) => (await call('/client/login', { method: 'POST', body: { email, password } })).data?.token;
const capital = await clientToken('dfaulkner@capitalplazart.com', 'capital-portal-06');
const dana = await clientToken('dana.whitfield@riverfrontholdings.com', 'riverfront-portal-01');
log(Boolean(capital && dana), 'and as two client contacts');

const ref = await call('/reference', { token: supervisor });
const post = ref.data.posts.find((p) => p.post_code === 'CP-01');
const site = post.site_id;
const me = (await call('/auth/me', { token: alexis })).data.user;

/* ================================================================ board === */
section('the board');

const board = await call('/dispatch', { token: supervisor });
log(board.status === 200 && Array.isArray(board.data.calls) && board.data.calls.every((c) => c.open), 'the board lists the calls still open');
log(typeof board.data.summary.waiting === 'number' && typeof board.data.summary.today === 'number', 'with today\'s numbers');
const closed = await call('/dispatch?view=closed&days=30', { token: supervisor });
log(closed.data.calls.length > 0 && closed.data.calls.every((c) => !c.open), 'and the last month\'s closed calls');
log(closed.data.calls.some((c) => c.timings.toArrive != null && typeof c.timings.withinTarget === 'boolean'), 'each timed from call to on scene, against its target');
log((await call('/dispatch', { token: marcus })).status === 403, 'officers cannot see the board');
log((await call('/dispatch')).status === 401, 'nor can anyone signed out');

/* =============================================================== raising === */
section('raising a call');

const raise = (body, token = supervisor) => call('/dispatch', { token, method: 'POST', body });
const good = { siteId: site, postId: post.id, callType: 'suspicious', priority: 2, location: 'Lobby east doors', description: 'Man trying the east doors after hours.', callerName: 'Night manager' };
log((await raise({ ...good, description: 'Hm' })).status === 422, 'a call needs a description');
log((await raise({ ...good, callType: 'aliens' })).status === 422, 'and a type we know');
log((await raise({ ...good, priority: 7 })).status === 422, 'and a priority');
log((await raise({ ...good, siteId: 999999 })).status === 422, 'at a site that exists');
const otherPost = ref.data.posts.find((p) => p.site_id !== site);
log((await raise({ ...good, postId: otherPost.id })).status === 422, 'and a post at that site');
log((await raise(good, marcus)).status === 403, 'officers do not raise calls on the board');
log((await raise({ ...good, assignTo: me.id })).status === 422, 'a call cannot be sent to an officer who is off duty');
const raised = await raise(good);
const id = raised.data.call?.id;
log(raised.status === 201 && raised.data.call.status === 'open' && raised.data.call.source === 'office', 'a supervisor raises a call', `#${id}`);
let alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
log(alerts.some((a) => a.key === `call:${id}:open` && a.severity === 'critical'), 'an urgent call nobody has is a critical alert');
const dash = (await call('/admin/dashboard', { token: supervisor })).data.counts;
log(dash.waitingCalls >= 1 && dash.activeCalls >= dash.waitingCalls, 'and counted on the sidebar');

/* ============================================================ assigning === */
section('sending it to an officer');

const clockIn = await call('/timeclock/clock-in', {
  token: alexis, method: 'POST',
  body: { postId: post.id, latitude: post.latitude + 0.0001, longitude: post.longitude, accuracy: 6, method: 'gps' },
});
log(clockIn.status === 201, 'Alexis clocks in at Capital Plaza', clockIn.data?.error || '');
const detail = await call(`/dispatch/${id}`, { token: supervisor });
const first = detail.data.candidates[0];
log(detail.status === 200 && detail.data.events[0]?.kind === 'raised', 'the call\'s log starts with who raised it');
log(first?.id === me.id && first.same_site === true, 'the officer already at the property is suggested first');
log(detail.data.candidates.every((c) => 'distance_km' in c && 'busy' in c), 'every officer on duty is listed with how far away they are');

const assign = (callId, userId, token = supervisor) => call(`/dispatch/${callId}/assign`, { token, method: 'POST', body: { userId } });
log((await assign(id, me.id, marcus)).status === 403, 'officers cannot send calls');
const sent = await assign(id, me.id);
log(sent.status === 200 && sent.data.call.status === 'assigned' && sent.data.call.officer_name === `${me.first_name} ${me.last_name}`, 'the supervisor sends it to Alexis');
log((await assign(id, me.id)).status === 409, 'sending it to her twice is refused');

const mine = await call('/dispatch/mine', { token: alexis });
log(mine.data.active.some((c) => c.id === id), 'it is on Alexis\'s screen');
log(!(await call('/dispatch/mine', { token: marcus })).data.active.some((c) => c.id === id), 'and not on anyone else\'s');
log((await call(`/dispatch/${id}/acknowledge`, { token: marcus, method: 'POST' })).status === 404, 'another officer cannot touch it');
log((await call(`/dispatch/${id}/clear`, { token: alexis, method: 'POST', body: { disposition: 'resolved', outcome: 'All fine here.' } })).status === 409,
  'it cannot be cleared before she is on scene');

/* ======================================================= the officer's go === */
section('acknowledge, arrive, clear');

const ack = await call(`/dispatch/${id}/acknowledge`, { token: alexis, method: 'POST' });
log(ack.status === 200 && ack.data.call.status === 'en_route' && ack.data.call.acknowledged_at, 'she acknowledges: on the way');
log((await call(`/dispatch/${id}/acknowledge`, { token: alexis, method: 'POST' })).status === 409, 'once');
const arrive = await call(`/dispatch/${id}/arrive`, { token: alexis, method: 'POST' });
log(arrive.status === 200 && arrive.data.call.status === 'on_scene' && arrive.data.call.timings.toArrive != null, 'on scene, with the time it took');
log((await assign(id, me.id + 0)).status === 409, 'a call with an officer on scene is not re-sent');
log((await call(`/dispatch/${id}/decline`, { token: alexis, method: 'POST', body: { reason: 'Changed my mind' } })).status === 409,
  'and cannot be turned back once on scene');
log((await call(`/dispatch/${id}/clear`, { token: alexis, method: 'POST', body: { disposition: 'resolved', outcome: 'ok' } })).status === 422,
  'clearing it needs a word on what was found');
log((await call(`/dispatch/${id}/clear`, { token: alexis, method: 'POST', body: { disposition: 'bogus', outcome: 'Subject left.' } })).status === 422,
  'and an outcome we know');
const foreign = (await call('/admin/incidents?limit=200', { token: supervisor })).data?.incidents?.find((i) => i.site_id && i.site_id !== site);
if (foreign) {
  log((await call(`/dispatch/${id}/clear`, { token: alexis, method: 'POST', body: { disposition: 'report', outcome: 'Wrote it up.', incidentId: foreign.id } })).status === 422,
    'a linked incident report has to be from the same site');
}
const cleared = await call(`/dispatch/${id}/clear`, { token: alexis, method: 'POST', body: { disposition: 'nothing_found', outcome: 'Walked the lobby and the east doors. Doors secure, nobody about.' } });
log(cleared.status === 200 && cleared.data.call.status === 'cleared' && cleared.data.call.disposition_label === 'Nothing found', 'she clears it with what she found');
const log1 = (await call(`/dispatch/${id}`, { token: supervisor })).data;
log(log1.events.map((e) => e.kind).join(',') === 'raised,assigned,acknowledged,arrived,cleared', 'the log has every step, in order');
log(log1.candidates.length === 0, 'and a closed call suggests nobody');
log((await call(`/dispatch/${id}/cancel`, { token: supervisor, method: 'POST', body: { reason: 'Too late now' } })).status === 409, 'a cleared call cannot be cancelled');
log((await call('/dispatch/mine', { token: alexis })).data.recent.some((c) => c.id === id), 'it stays in her recent calls');
alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
log(!alerts.some((a) => a.key.startsWith(`call:${id}:`)), 'and is off the alerts');

/* ========================================================= turning back === */
section('turning a call back, cancelling it');

const second = (await raise({ ...good, callType: 'lockout', priority: 3, description: 'Tenant locked out of suite 210.' })).data.call;
await assign(second.id, me.id);
log((await call(`/dispatch/${second.id}/decline`, { token: alexis, method: 'POST', body: {} })).status === 422, 'turning a call back needs a reason');
const declined = await call(`/dispatch/${second.id}/decline`, { token: alexis, method: 'POST', body: { reason: 'Mid-tour at the far end.' } });
const afterDecline = (await call(`/dispatch/${second.id}`, { token: supervisor })).data;
log(declined.status === 200 && afterDecline.call.status === 'open' && afterDecline.call.assigned_to === null, 'Alexis turns it back: it is waiting again');
log(afterDecline.events.some((e) => e.kind === 'declined' && e.note === 'Mid-tour at the far end.'), 'with her reason in the log');
log((await call(`/dispatch/${second.id}/cancel`, { token: supervisor, method: 'POST', body: { reason: 'x' } })).status === 422, 'cancelling needs a reason');
const cancelled = await call(`/dispatch/${second.id}/cancel`, { token: supervisor, method: 'POST', body: { reason: 'Tenant found their key.' } });
log(cancelled.status === 200 && cancelled.data.call.status === 'cancelled', 'and the supervisor cancels it');

/* ============================================================== clients === */
section('the client portal');

const portalRaise = (body, token = capital) => call('/client/calls', { token, method: 'POST', body });
const clientCall = { siteId: site, callType: 'parking', priority: 3, location: 'Visitor lot row C', description: 'A truck is blocking the visitor lot entrance.' };
log((await portalRaise({ ...clientCall, priority: 1 })).status === 422, 'a client cannot raise an emergency: that is a 911 call');
log((await portalRaise({ ...clientCall, siteId: 999999 })).status === 404, 'nor a call at a site that is not theirs');
log((await portalRaise(clientCall, dana)).status === 404, 'another client\'s property is invisible');
const fromClient = await portalRaise(clientCall);
const cid = fromClient.data.call?.id;
log(fromClient.status === 201 && fromClient.data.call.status === 'open' && fromClient.data.call.raised_by_you, 'the client asks for an officer');
const onBoard = (await call('/dispatch', { token: supervisor })).data.calls.find((c) => c.id === cid);
log(onBoard?.source === 'client' && onBoard.client_contact, 'it lands on the board, marked as from the client');
const extra1 = (await portalRaise({ ...clientCall, description: 'Second thing that needs looking at.' })).data.call;
const extra2 = (await portalRaise({ ...clientCall, description: 'Third thing that needs looking at.' })).data.call;
log((await portalRaise({ ...clientCall, description: 'Fourth thing that needs looking at.' })).status === 409, 'three open calls per contact, then the phone');
for (const c of [extra1, extra2]) await call(`/client/calls/${c.id}/cancel`, { token: capital, method: 'POST', body: {} });
log((await call(`/client/calls/${cid}/cancel`, { token: dana, method: 'POST', body: {} })).status === 404, 'another client cannot cancel it');

await assign(cid, me.id);
await call(`/dispatch/${cid}/arrive`, { token: alexis, method: 'POST' });
log((await call(`/client/calls/${cid}/cancel`, { token: capital, method: 'POST', body: {} })).status === 409, 'once the officer is on scene the client cannot cancel it');
let portal = (await call('/client/calls', { token: capital })).data;
let seen = portal.calls.find((c) => c.id === cid);
log(seen?.status === 'on_scene' && /^Alexis [A-Z]\.$/.test(seen.officer || ''), 'the client sees the officer on scene, by first name');
log(!('officer_phone' in seen) && !('events' in seen) && !('caller_phone' in seen), 'and no phone numbers or internal log');
await call(`/dispatch/${cid}/clear`, { token: alexis, method: 'POST', body: { disposition: 'resolved', outcome: 'Driver moved the truck to the loading bay.' } });
portal = (await call('/client/calls', { token: capital })).data;
seen = portal.calls.find((c) => c.id === cid);
log(seen?.status === 'cleared' && seen.outcome.startsWith('Driver moved') && seen.minutes_to_arrive != null, 'then sees it cleared, what was done and how long it took');
log(portal.calls.some((c) => c.id === id && !c.raised_by_you), 'and the calls the office raised for their property');
log(!(await call('/client/calls', { token: dana })).data.calls.some((c) => c.id === cid), 'which another client never sees');
let emailed = false;
for (let i = 0; i < 10 && !emailed; i += 1) {
  const outbox = (await call('/admin/emails?limit=100', { token: admin })).data.emails || [];
  emailed = outbox.some((e) => e.kind === 'call_cleared' && e.to_email === 'dfaulkner@capitalplazart.com');
  if (!emailed) await new Promise((r) => setTimeout(r, 200));
}
log(emailed, 'and is emailed when it is cleared');

/* ===================================================== going off duty === */
section('clocking out with a call');

const third = (await raise({ ...good, callType: 'escort', priority: 3, description: 'Escort a contractor to the plant room.' })).data.call;
await assign(third.id, me.id);
await call(`/dispatch/${third.id}/acknowledge`, { token: alexis, method: 'POST' });
const summary = (await call('/timeclock/shift-summary', { token: alexis })).data;
log(summary.calls?.open === 1 && summary.calls.cleared >= 2, 'her shift summary counts the calls cleared and the one still open');
const out = await call('/timeclock/clock-out', { token: alexis, method: 'POST', body: { latitude: post.latitude, longitude: post.longitude, accuracy: 6 } });
log(out.status === 200 && out.data.callsReturned === 1, 'she clocks out, and is told the call went back');
const back = (await call(`/dispatch/${third.id}`, { token: supervisor })).data;
log(back.call.status === 'open' && back.call.assigned_to === null && back.events.at(-1).kind === 'returned', 'it is waiting on the board again, and the log says why');
log(!back.candidates.some((c) => c.id === me.id), 'and she is no longer suggested');
await call(`/dispatch/${third.id}/cancel`, { token: supervisor, method: 'POST', body: { reason: 'Contractor rescheduled.' } });

/* ================================================================ report === */
section('the response-time report');

const report = await call('/admin/reports/calls-by-site', { token: admin });
log(report.status === 200 && report.data.rows.length > 0 && report.data.columns.some((c) => c.key === 'avg_arrive'), 'calls by site, with the average time to on scene');
log(report.data.summary.some((s) => s.label === 'Within target'), 'and how many were inside the target');

const audit = (await call('/admin/audit?limit=300', { token: admin })).data?.entries || [];
const actions = new Set(audit.map((e) => e.action));
log(['call.raised', 'call.assigned', 'call.cleared', 'call.cancelled'].every((a) => actions.has(a)), 'raising, sending, clearing and cancelling are audited');

finish('Dispatch');
