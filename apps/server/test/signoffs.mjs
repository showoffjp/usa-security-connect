/**
 * Client sign-off of the week's hours.
 *
 * A client contact sees each completed week at their property - the hours
 * worked on each post, never a rate - and signs it off or disputes it with a
 * reason. A week signed off whose hours then change reads as changed and is
 * signed again. The office sees every property's weeks, gets disputes in the
 * alerts inbox, and an administrator replies to them; the reply reaches the
 * client in the portal and by email. Invoice previews say whether the weeks
 * they bill are signed off.
 *
 * Harborview's contact signs last week off here, and Capital Plaza's contact
 * re-signs the week the demo seeded as changed since it was signed.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const clientLogin = async (email, password) => (await call('/client/login', { method: 'POST', body: { email, password } })).data?.token;
const carla = await clientLogin('carla.mendez@harborviewhealth.org', 'harborview-portal-04');
const capital = await clientLogin('dfaulkner@capitalplazart.com', 'capital-portal-06');
log(Boolean(admin && supervisor && marcus && carla && capital), 'signed in as staff, an officer and two client contacts');

const mondayOf = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const thisMonday = mondayOf(new Date());
const lastMonday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7);
const sign = (token, body) => call('/client/signoffs', { token, method: 'POST', body });
const mine = async (token) => (await call('/client/signoffs', { token })).data;

/* ============================================================ the client === */
section('what the client sees');

const view = await call('/client/signoffs', { token: carla });
log(view.status === 200 && view.data.sites.length === 1 && view.data.sites[0].name.startsWith('Harborview'),
  'a contact sees the weeks for their own property only', view.data.sites?.map((s) => s.name).join(', '));
const harborview = view.data.sites[0];
const weeks = harborview.weeks;
log(weeks.length >= 1 && weeks.every((w, i) => i === 0 || w.week_of < weeks[i - 1].week_of) && weeks[0].week_of === ymd(lastMonday),
  'completed weeks, newest first, starting with last week', weeks.map((w) => w.week_of).join(', '));
log(weeks.every((w) => Math.abs(w.posts.reduce((n, p) => n + p.minutes, 0) - w.minutes) < 1), "each week's hours are its posts' hours added up");
const leaks = JSON.stringify(view.data).match(/"(rate[^"]*|pay[^"]*|cost[^"]*|margin[^"]*|bill[^"]*|fingerprint|client_user_id|responded_by)"/g);
log(!leaks, 'with no rates, pay, margin or internal fields', (leaks || []).join(', '));
const disputedBefore = weeks.find((w) => w.status === 'disputed' && w.signoff?.response);
log(Boolean(disputedBefore), 'a week they disputed shows our reply', disputedBefore?.signoff?.response?.slice(0, 40));

/* ============================================================ the rules === */
section('what can be signed');

const target = weeks[0];
log(['waiting', 'changed', 'approved'].includes(target.status), 'last week is ready to answer for', target.status);
log((await sign(carla, { siteId: harborview.id, weekStart: target.week_of, decision: 'dispute', note: 'Wrong.' })).status === 422,
  'a dispute has to say what looks wrong');
log((await sign(carla, { siteId: harborview.id, weekStart: ymd(thisMonday), decision: 'approve' })).status === 422,
  'this week cannot be signed off until it is over');
const tuesday = new Date(lastMonday.getFullYear(), lastMonday.getMonth(), lastMonday.getDate() + 1);
log((await sign(carla, { siteId: harborview.id, weekStart: ymd(tuesday), decision: 'approve' })).status === 422, 'a week starts on a Monday');
const longAgo = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 70);
log((await sign(carla, { siteId: harborview.id, weekStart: ymd(longAgo), decision: 'approve' })).status === 422, 'and only recent weeks can be answered for');
const capitalSite = (await mine(capital)).sites[0];
log((await sign(carla, { siteId: capitalSite.id, weekStart: target.week_of, decision: 'approve' })).status === 404,
  "another client's property is not found, rather than refused");
log((await call('/client/signoffs', { token: marcus })).status === 401, 'staff sessions do not open the client routes');

/* ========================================================== signing off === */
section('signing off and disputing');

const approved = await sign(carla, { siteId: harborview.id, weekStart: target.week_of, decision: 'approve' });
log([200, 201].includes(approved.status) && approved.data.signoff.status === 'approved' && approved.data.signoff.client_name,
  'the contact signs off last week', `${approved.data.signoff?.hours} h`);
log((await mine(carla)).sites[0].weeks[0].status === 'approved', 'and it reads as signed off');
log((await sign(carla, { siteId: harborview.id, weekStart: target.week_of, decision: 'approve' })).status === 409, 'signing it again changes nothing');

const preview = await call(`/invoices/preview?siteId=${harborview.id}&periodStart=${target.week_of}&periodEnd=${ymd(new Date(lastMonday.getFullYear(), lastMonday.getMonth(), lastMonday.getDate() + 6))}`, { token: admin });
log(preview.status === 200 && preview.data.signoff.weeks.length === 1 && preview.data.signoff.allApproved === true,
  'an invoice for that week shows its hours signed off by the client');

const note = 'The Emergency Department Entrance shows a shift on Thursday night that we did not see on the camera log.';
const disputed = await sign(carla, { siteId: harborview.id, weekStart: target.week_of, decision: 'dispute', note });
log(disputed.status === 200 && disputed.data.signoff.status === 'disputed' && disputed.data.signoff.note === note,
  'a contact can change their mind and dispute it with a reason');
const preview2 = await call(`/invoices/preview?siteId=${harborview.id}&periodStart=${target.week_of}&periodEnd=${ymd(new Date(lastMonday.getFullYear(), lastMonday.getMonth(), lastMonday.getDate() + 6))}`, { token: admin });
log(preview2.data.signoff.allApproved === false && preview2.data.signoff.weeks[0].status === 'disputed' && preview2.data.signoff.weeks[0].note === note,
  'and the invoice preview then says the week is disputed, and why');

/* ============================================================ the office === */
section('the office');

const board = await call('/admin/signoffs', { token: supervisor });
const row = board.data?.sites?.find((s) => s.id === harborview.id)?.weeks.find((w) => w.week_of === target.week_of);
log(board.status === 200 && row?.status === 'disputed' && row.signoff.client_name && board.data.counts.disputed >= 1,
  'supervisors see every property\'s weeks, with the dispute and who raised it');
log((await call('/admin/signoffs', { token: marcus })).status === 403, 'officers do not');
const alerts = (await call('/admin/alerts', { token: admin })).data.alerts;
log(alerts.some((a) => a.kind === 'signoff' && a.title.includes('Harborview')), 'a dispute lands in the alerts inbox');
log((await call('/admin/dashboard', { token: admin })).data.counts.signoffDisputes >= 1, 'and is counted for the sidebar');

const id = row.signoff.id;
log((await call(`/admin/signoffs/${id}/reply`, { token: supervisor, method: 'POST', body: { response: 'We will check.' } })).status === 403,
  'only an administrator replies');
log((await call(`/admin/signoffs/${id}/reply`, { token: admin, method: 'POST', body: { response: 'Ok' } })).status === 422,
  'with a reply the client can read');
const reply = 'The Thursday shift was the relief officer covering the ambulance bay while the regular officer was at the front desk - the camera log for bay 2 shows him from 23:10.';
const replied = await call(`/admin/signoffs/${id}/reply`, { token: admin, method: 'POST', body: { response: reply } });
log(replied.status === 200 && replied.data.signoff.response === reply, 'an administrator replies to the dispute');
log((await mine(carla)).sites[0].weeks[0].signoff.response === reply, 'the client reads the reply in the portal');
const outbox = (await call('/admin/emails?limit=300', { token: admin })).data;
const email = outbox.emails.find((e) => e.kind === 'signoff_reply' && e.to_email.includes('harborview'));
log(Boolean(email), 'and by email');
log(!(await call('/admin/alerts', { token: admin })).data.alerts.some((a) => a.key?.startsWith(`signoff:${id}:`)), 'and the alert goes once it is answered');

const again = await sign(carla, { siteId: harborview.id, weekStart: target.week_of, decision: 'approve' });
log(again.status === 200 && again.data.signoff.status === 'approved' && !again.data.signoff.response, 'satisfied, the contact signs the week off');
log((await call(`/admin/signoffs/${id}/reply`, { token: admin, method: 'POST', body: { response: 'Thanks again for checking.' } })).status === 409,
  'and a week that is signed off has nothing to reply to');

/* ======================================================== changed since === */
section('hours that change after they are signed');

const capitalWeeks = (await mine(capital)).sites[0].weeks;
const changed = capitalWeeks.find((w) => w.status === 'changed');
log(Boolean(changed) && changed.signoff.hours !== changed.hours,
  'a week whose hours changed after it was signed reads as changed, with the hours signed and the hours now', changed ? `${changed.signoff.hours} h -> ${changed.hours} h` : 'none');
if (changed) {
  const resigned = await sign(capital, { siteId: capitalSite.id, weekStart: changed.week_of, decision: 'approve' });
  log(resigned.status === 200 && resigned.data.signoff.hours === changed.hours, 'and the client signs the hours as they now stand');
  log((await mine(capital)).sites[0].weeks.find((w) => w.week_of === changed.week_of).status === 'approved', 'after which it reads as signed off');
}

const auditLog = (await call('/admin/audit?limit=300', { token: admin })).data?.entries || [];
const actions = new Set(auditLog.map((e) => e.action));
log(['signoff.approved', 'signoff.disputed', 'signoff.replied'].every((a) => actions.has(a)), 'sign-offs, disputes and replies are audited');

finish('Client sign-off of hours');
