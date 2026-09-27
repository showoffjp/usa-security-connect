/**
 * Extra coverage requested from the client portal, and an officer's own pay.
 *
 * Coverage requests cross the line between the two sessions - a client
 * writes, staff answer - so most of this suite is about that line: a client
 * sees and touches only their own property's requests, a request is answered
 * once, answering it really puts shifts on the schedule, and the client hears
 * back. An officer's pay is checked against the payroll lines it comes from.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const clientSignIn = async (email, password) =>
  (await call('/client/login', { method: 'POST', body: { email, password } })).data?.token;

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const officer = await signIn('1003', '4812');
const contractor = await signIn('1005', '6174');
const dana = await clientSignIn('dana.whitfield@riverfrontholdings.com', 'riverfront-portal-01');
const marcus = await clientSignIn('marcus.reyes@palmettoridgehoa.org', 'palmetto-portal-02');
log(Boolean(admin && supervisor && officer && contractor && dana && marcus), 'signed in as staff and two client contacts');

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000).toISOString();

/* ============================================================ client side === */
section('a client asking for extra coverage');

const me = await call('/client/me', { token: dana });
const danaSite = me.data.sites[0].id;
const marcusSite = (await call('/client/me', { token: marcus })).data.sites[0].id;

const mine = await call('/client/coverage-requests', { token: dana });
log(mine.status === 200 && mine.data.requests.length >= 1 && mine.data.requests.every((r) => r.site_id === danaSite),
  'a client sees only requests for their own property', `${mine.data?.requests?.length}`);
const leak = JSON.stringify(mine.data);
log(!/pay_rate|bill_rate|handled_by|client_email|margin/i.test(leak), 'with no internal names, rates or notes in the response');

const ask = (token, body) => call('/client/coverage-requests', { token, method: 'POST', body });
const good = { siteId: danaSite, startsAt: hoursFromNow(48), endsAt: hoursFromNow(54), officers: 2, armed: false, reason: 'Board meeting in the east wing.' };

log((await ask(dana, { ...good, siteId: marcusSite })).status === 404, "asking for someone else's property is refused as not found");
log((await ask(dana, { ...good, startsAt: hoursFromNow(-2), endsAt: hoursFromNow(2) })).status === 422, 'coverage that has already started is refused');
log((await ask(dana, { ...good, startsAt: hoursFromNow(0.5), endsAt: hoursFromNow(3) })).status === 422, 'so is anything inside the next hour');
log((await ask(dana, { ...good, endsAt: hoursFromNow(47) })).status === 422, 'an end before the start is refused');
log((await ask(dana, { ...good, endsAt: hoursFromNow(48 + 17) })).status === 422, 'more than 16 hours in one request is refused');
log((await ask(dana, { ...good, officers: 11 })).status === 422, 'more than ten officers is refused');
log((await ask(dana, { ...good, reason: 'x' })).status === 422, 'a request has to say what it is for');
log((await ask(null, good)).status === 401, 'nobody signed out can ask');
log((await call('/client/coverage-requests', { token: officer, method: 'POST', body: good })).status === 401,
  'a staff session is not a client session');

const created = await ask(dana, good);
log(created.status === 201 && created.data.request.status === 'open' && created.data.request.officers === 2,
  'a valid request is taken, waiting for a reply');
const reqId = created.data.request.id;
const toWithdraw = (await ask(dana, { ...good, reason: 'Second thoughts - may not need this.' })).data.request.id;

log((await call(`/client/coverage-requests/${reqId}/cancel`, { token: marcus, method: 'POST' })).status === 404,
  "another client cannot withdraw it, or learn it exists");

/* ============================================================= staff side === */
section('staff answering it');

log((await call('/admin/coverage-requests', { token: officer })).status === 403, 'an officer cannot see client requests');
const list = await call('/admin/coverage-requests?status=open', { token: supervisor });
log(list.status === 200 && list.data.requests.some((r) => r.id === reqId), 'a supervisor sees it in the open list');
log(list.data.posts.every((p) => list.data.requests.some((r) => r.site_id === p.site_id)), "with only those sites' posts offered");
const dash = await call('/admin/dashboard', { token: admin });
log(dash.data.counts.coverageRequests >= 2, 'the dashboard counts the requests waiting', `${dash.data.counts.coverageRequests}`);

const riverfrontPost = list.data.posts.find((p) => p.site_id === danaSite);
const otherPost = (await call('/reference', { token: supervisor })).data.posts.find((p) => p.site_id !== danaSite);
const schedule = (id, token, body) => call(`/admin/coverage-requests/${id}/schedule`, { token, method: 'POST', body });

log((await schedule(reqId, supervisor, { postId: otherPost.id })).status === 422, "it cannot be scheduled on another site's post");

const before = (await call(`/admin/shifts?siteId=${danaSite}&from=${hoursFromNow(47)}&to=${hoursFromNow(49)}`, { token: supervisor })).data.shifts
  .filter((s) => !s.user_id).length;
const done = await schedule(reqId, supervisor, { postId: riverfrontPost.id, note: 'Two officers from 6 PM, briefed on the east wing.' });
log(done.status === 200 && done.data.request.status === 'scheduled' && done.data.request.shifts_created === 2,
  'scheduling it records who answered and how many shifts', done.data?.error);
const after = (await call(`/admin/shifts?siteId=${danaSite}&from=${hoursFromNow(47)}&to=${hoursFromNow(49)}`, { token: supervisor })).data.shifts
  .filter((s) => !s.user_id);
log(after.length === before + 2 && after.every((s) => s.post_id === riverfrontPost.id),
  'and puts exactly two open shifts on the schedule, on that post', `${before} -> ${after.length}`);
log((await schedule(reqId, admin, { postId: riverfrontPost.id })).status === 409, 'a request is only answered once');

const emails = (await call('/admin/emails?limit=20', { token: admin })).data.emails;
log(emails.some((e) => e.kind === 'coverage_scheduled' && e.entity_id === reqId && /riverfrontholdings/.test(e.to_email)),
  'the client is emailed the confirmation');

const clientView = (await call('/client/coverage-requests', { token: dana })).data.requests.find((r) => r.id === reqId);
log(clientView.status === 'scheduled' && /east wing/.test(clientView.response || ''), 'and sees it scheduled, with the note, in the portal');

// The seeded armed request at Gulfport was declined; make a fresh armed one.
const armedAsk = await ask(dana, { ...good, armed: true, officers: 1, reason: 'Cash collection on the loading dock.' });
const unarmedPost = list.data.posts.find((p) => p.site_id === danaSite && !p.armed) || riverfrontPost;
if (!unarmedPost.armed) {
  log((await schedule(armedAsk.data.request.id, supervisor, { postId: unarmedPost.id })).status === 422,
    'an armed request cannot go on an unarmed post');
}
log((await call(`/admin/coverage-requests/${armedAsk.data.request.id}/decline`, { token: supervisor, method: 'POST', body: { response: 'no' } })).status === 422,
  'declining needs a reason the client can read');
const declined = await call(`/admin/coverage-requests/${armedAsk.data.request.id}/decline`, {
  token: supervisor, method: 'POST', body: { response: 'No armed officer free that evening - we can offer an unarmed one.' },
});
log(declined.status === 200 && declined.data.request.status === 'declined', 'a request can be declined with a reason');
const declinedView = (await call('/client/coverage-requests', { token: dana })).data.requests.find((r) => r.id === armedAsk.data.request.id);
log(declinedView.status === 'declined' && /unarmed/.test(declinedView.response), 'and the client sees why');

log((await call(`/client/coverage-requests/${reqId}/cancel`, { token: dana, method: 'POST' })).status === 409,
  'an answered request cannot be withdrawn from the portal');
const withdrawn = await call(`/client/coverage-requests/${toWithdraw}/cancel`, { token: dana, method: 'POST' });
log(withdrawn.status === 200, 'an unanswered one can');
log((await schedule(toWithdraw, supervisor, { postId: riverfrontPost.id })).status === 409, 'and cannot then be scheduled');

/* ================================================================ my pay === */
section("an officer's own pay");

const pay = await call('/schedule/my-pay', { token: officer });
log(pay.status === 200 && pay.data.stubs.length >= 1, 'an officer sees their closed pay periods', `${pay.data?.stubs?.length}`);
log(pay.data.basis.employment_type === 'w2' && pay.data.basis.earns_overtime === true, 'and their own pay basis');

const period = pay.data.stubs[0];
const review = await call(`/admin/payroll/periods/${period.period_id}`, { token: admin });
const line = review.data.lines.find((l) => l.employee_code === '1003');
log(line && Math.abs(line.gross_pay - period.gross_pay) < 0.001 && Math.abs(line.hours - period.hours) < 0.001,
  'which match the payroll line to the cent', `${period.gross_pay} vs ${line?.gross_pay}`);
log(Math.abs(period.regular_pay + period.overtime_pay - period.gross_pay) < 0.011, 'regular plus overtime is the gross');
log(typeof pay.data.thisWeek.estimated_pay === 'number' && pay.data.thisWeek.hours >= 0, 'with an estimate for this week so far');

const contractorPay = await call('/schedule/my-pay', { token: contractor });
log(contractorPay.status === 200 && contractorPay.data.basis.earns_overtime === false && contractorPay.data.basis.employment_type === '1099',
  'a 1099 contractor is shown as earning no overtime');
log(contractorPay.data.stubs.every((s) => s.overtime_hours === 0), 'and no stub of theirs carries any');

const others = JSON.stringify(pay.data);
log(!others.includes('"1005"') && !/Dwayne/.test(others), "and nobody else's pay appears in it");
log((await call('/schedule/my-pay', { token: dana })).status === 401, 'a client session cannot read it');

finish('Requests and pay');
