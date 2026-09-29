/**
 * The post's own logs - visitors and pass-down notes - and the console's
 * quick search.
 *
 * Both logs are written from the post an officer is clocked in at, so most of
 * this is about that line: an officer off duty cannot write to any post's log,
 * cannot sign out someone at another site, and reads only the pass-down for
 * the post they are on or about to be on. The client sees their own building's
 * visitors in the daily report and nobody else's.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812'); // on duty at Riverfront, main lobby
const clientSignIn = async (email, password) =>
  (await call('/client/login', { method: 'POST', body: { email, password } })).data?.token;
const dana = await clientSignIn('dana.whitfield@riverfrontholdings.com', 'riverfront-portal-01');
// A contact no other suite signs in, so the per-email limit is never shared.
const harborview = await clientSignIn('carla.mendez@harborviewhealth.org', 'harborview-portal-04');
log(Boolean(admin && supervisor && marcus && dana && harborview), 'signed in as staff and two client contacts');

// An officer who is not on duty right now, whoever that is in the seed.
let offDuty = null;
for (const [code, pin] of [['1004', '5930'], ['1006', '7285'], ['1008', '9351'], ['1005', '6174']]) {
  const token = await signIn(code, pin);
  const view = await call('/post-log', { token });
  if (view.status === 200 && !view.data.onDuty) {
    offDuty = token;
    break;
  }
}
log(Boolean(offDuty), 'found an officer who is off duty');

/* ============================================================= the officer === */
section("the officer's view of their post");

const view = await call('/post-log', { token: marcus });
log(view.status === 200 && view.data.onDuty && /Riverfront/.test(view.data.post?.site_name),
  'an officer on duty sees the log for the post they are on', view.data?.post?.post_name);
log(Array.isArray(view.data.visitors?.onSite) && view.data.visitors.onSite.every((v) => v.site_id === view.data.post.site_id),
  'with only that site\'s visitors');
log(view.data.unacked >= 1 && view.data.passdown.some((n) => !n.acked_at && !n.mine),
  'and a pass-down note from the last shift waiting to be read', `${view.data.unacked} unread`);

/* ================================================================ visitors === */
section('signing visitors in and out');

const visit = (token, body) => call('/post-log/visitors', { token, method: 'POST', body });
const good = { fullName: 'Test Visitor Okonkwo', company: 'Acme HVAC', purpose: 'Rooftop unit service', kind: 'contractor', vehiclePlate: ' abc 1234 ', host: 'Building engineer' };

log((await visit(marcus, { ...good, fullName: '' })).status === 422, 'a visitor needs a name');
log((await visit(marcus, { ...good, purpose: '' })).status === 422, 'and a reason to be there');
log((await visit(marcus, { ...good, kind: 'spy' })).status === 422, 'and a known kind of visit');
log((await visit(offDuty, good)).status === 409, 'an officer off duty cannot sign anyone in');
log((await call('/post-log/visitors', { token: dana, method: 'POST', body: good })).status === 401, 'nor can a client session');

const signedIn = await visit(marcus, good);
log(signedIn.status === 201 && signedIn.data.visitor.site_id === view.data.post.site_id && !signedIn.data.visitor.departed_at,
  'a visitor is signed in at the officer\'s own site');
log(signedIn.data.visitor.vehicle_plate === 'ABC 1234', 'with the plate tidied to upper case', signedIn.data.visitor.vehicle_plate);
log(signedIn.data.visitor.logged_by_name === 'Marcus Bell', 'recording who signed them in');
const visitorId = signedIn.data.visitor.id;

log((await visit(marcus, { ...good, fullName: 'test visitor OKONKWO' })).status === 409,
  'the same person cannot be signed in twice while still inside');
const again = await call('/post-log', { token: marcus });
log(again.data.visitors.onSite.some((v) => v.id === visitorId), 'and they show as on site');

log((await call(`/post-log/visitors/${visitorId}/depart`, { token: offDuty, method: 'POST' })).status !== 200,
  'an officer who is not on duty cannot sign them out');

/* ======================================================== supervisor view === */
section('the supervisor\'s view');

log((await call('/post-log/admin/visitors', { token: marcus })).status === 403, 'an officer cannot read every site\'s log');
const inside = await call('/post-log/admin/visitors?onSite=1', { token: supervisor });
log(inside.status === 200 && inside.data.visitors.some((v) => v.id === visitorId) && inside.data.visitors.every((v) => !v.departed_at),
  'a supervisor sees everyone still inside, across sites', `${inside.data?.onSiteTotal}`);
log(inside.data.sites.find((s) => s.id === view.data.post.site_id)?.on_site >= 1, 'counted per site');
const dash = await call('/admin/dashboard', { token: admin });
log(dash.data.counts.visitorsOnSite === inside.data.onSiteTotal, 'the dashboard count agrees', `${dash.data.counts.visitorsOnSite}`);

const today = await call(`/post-log/admin/visitors?siteId=${view.data.post.site_id}`, { token: supervisor });
log(today.status === 200 && today.data.visitors.some((v) => v.id === visitorId), "and a site's log for the day");

const dar = await call(`/reports/dar?siteId=${view.data.post.site_id}`, { token: supervisor });
log(dar.status === 200 && dar.data.summary.visitors >= 1 && dar.data.visitors.some((v) => v.id === visitorId),
  'the daily activity report lists the visitors');

/* =================================================================== client === */
section('the client');

const clientDar = await call('/client/dar', { token: dana });
const seen = clientDar.data.visitors?.find((v) => v.full_name === good.fullName);
log(clientDar.status === 200 && seen, "the client's daily report shows who came through their building");
log(seen && !('logged_by' in seen) && !('logged_by_name' in seen), 'without naming the officer who logged them');
log(clientDar.data.visitorsOnSiteNow >= 1, 'with how many are inside now');
const otherDar = await call('/client/dar', { token: harborview });
log(otherDar.status === 200 && !otherDar.data.visitors.some((v) => v.full_name === good.fullName),
  "another client's report does not include them");
log((await call(`/client/dar?siteId=${view.data.post.site_id}`, { token: harborview })).status === 404,
  "and cannot ask for this building's");

/* ============================================================ signing out === */
section('signing out');

const out = await call(`/post-log/visitors/${visitorId}/depart`, { token: marcus, method: 'POST' });
log(out.status === 200 && out.data.visitor.departed_at && out.data.visitor.departed_by_name === 'Marcus Bell',
  'the officer signs them out');
log((await call(`/post-log/visitors/${visitorId}/depart`, { token: supervisor, method: 'POST' })).status === 409,
  'and they cannot be signed out twice');
const back = await visit(marcus, good);
log(back.status === 201, 'once out, they can be signed in again on a later visit');
const closed = await call(`/post-log/visitors/${back.data.visitor.id}/depart`, { token: supervisor, method: 'POST' });
log(closed.status === 200 && closed.data.visitor.departed_by_name === 'Renata Diaz', 'a supervisor can close off anyone left signed in');

/* ============================================================== pass-down === */
section('pass-down notes');

const note = (token, body) => call('/post-log/passdown', { token, method: 'POST', body });
log((await note(marcus, { body: 'ok' })).status === 422, 'a note has to say something useful');
log((await note(offDuty, { body: 'Gate is sticking, push it shut.' })).status === 409, 'an officer off duty cannot leave one');
const written = await note(marcus, { body: 'Loading dock gate is sticking - push it until it latches.', priority: 'important' });
log(written.status === 201 && written.data.note.priority === 'important' && written.data.note.mine, 'an officer leaves a note for the next shift');
log((await call(`/post-log/passdown/${written.data.note.id}/ack`, { token: marcus, method: 'POST' })).status === 422,
  'and cannot acknowledge their own');

const waiting = view.data.passdown.find((n) => !n.acked_at && !n.mine);
const ack = await call(`/post-log/passdown/${waiting.id}/ack`, { token: marcus, method: 'POST' });
log(ack.status === 200, "the officer acknowledges the last shift's note");
log((await call(`/post-log/passdown/${waiting.id}/ack`, { token: marcus, method: 'POST' })).status === 200, 'twice is harmless');
const after = await call('/post-log', { token: marcus });
log(after.data.unacked === view.data.unacked - 1 && after.data.passdown.find((n) => n.id === waiting.id)?.acked_at,
  'and it no longer counts as unread', `${view.data.unacked} -> ${after.data.unacked}`);

const all = await call('/post-log/admin/passdown', { token: supervisor });
log(all.status === 200 && all.data.notes.find((n) => n.id === waiting.id)?.acks.some((a) => a.name === 'Marcus Bell'),
  'the supervisor can see who read each note');
const elsewhere = all.data.notes.find((n) => n.post_id !== view.data.post.post_id);
log(elsewhere && (await call(`/post-log/passdown/${elsewhere.id}/ack`, { token: marcus, method: 'POST' })).status === 404,
  "an officer cannot acknowledge another post's notes");
log((await call('/post-log/admin/passdown', { token: marcus })).status === 403, "nor read every post's");

/* =========================================================== quick search === */
section('quick search');

const find = (q, token = admin) => call(`/admin/search?q=${encodeURIComponent(q)}`, { token });
const byCode = await find('1003');
log(byCode.status === 200 && byCode.data.employees[0]?.full_name === 'Marcus Bell', 'an employee code finds the officer');
const byName = await find('bell');
log(byName.data.employees.some((e) => e.employee_code === '1003'), 'so does a surname, whatever the case');
log((await find('riverfront')).data.sites.some((s) => /Riverfront/.test(s.name)), 'a site by name');
const inc = await find('USC-');
log(inc.data.incidents.length >= 1, 'an incident by reference');
log((await find('a')).data.employees.length === 0, 'one letter is not a search');
const wild = await find('%_%');
log(wild.status === 200 && wild.data.employees.length === 0, 'wildcards are searched for literally');
log((await find('1003', marcus)).status === 403, 'an officer cannot search the console');
log(!JSON.stringify(byName.data).match(/pin_hash|pin_salt|pay_rate/), 'and the results carry no PINs or pay');

finish('Post logs and search');
