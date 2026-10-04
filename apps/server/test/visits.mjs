/**
 * Supervisor field visits.
 *
 * A visit has two notes: the supervisor's own, which is about the officer and
 * must never reach the client, and a note written for the client. The lines
 * to hold are that the client only ever reads the second, that a visit is
 * tied to a real site and post and dated sensibly, that an officer sees only
 * the visits made to them, and that a site nobody has visited for two weeks
 * shows up - on the board, in the alerts, on site health and in the report -
 * until someone goes.
 */

import { BASE, call, log, section, signIn, finish, localDay } from './harness.mjs';

const supervisor = await signIn('1002', '3571');
const admin = await signIn('1001', '2468');
const marcus = await signIn('1003', '4812');
const dana = (await call('/client/login', {
  method: 'POST', body: { email: 'dana.whitfield@riverfrontholdings.com', password: 'riverfront-portal-01' },
})).data?.token;
log(Boolean(supervisor && admin && marcus && dana), 'signed in as supervisor, administrator, an officer and a client');

const ref = (await call('/reference', { token: supervisor })).data;
const staff = (await call('/admin/employees', { token: admin })).data.employees;
const marcusRow = staff.find((e) => e.employee_code === '1003');
const riverfrontPost = ref.posts.find((p) => p.post_code === 'RF-01');
const otherSitePost = ref.posts.find((p) => p.site_id !== riverfrontPost.site_id);

/* ============================================================ logging === */
section('logging a visit');

const logVisit = (body, token = supervisor) => call('/visits', { token, method: 'POST', body });
const recent = new Date(Date.now() - 3600000).toISOString();
log((await logVisit({ siteId: riverfrontPost.site_id }, marcus)).status === 403, 'officers cannot log visits');
log((await logVisit({ rating: 5 })).status === 422, 'a visit has to say where');
log((await logVisit({ siteId: riverfrontPost.site_id, postId: otherSitePost.id })).status === 422, 'a post at another site is refused');
log((await logVisit({ postId: 999999 })).status === 422, 'as is a post that does not exist');
log((await logVisit({ siteId: 999999 })).status === 422, 'and a site that does not exist');
log((await logVisit({ postId: riverfrontPost.id, officerId: 999999 })).status === 422, 'the officer has to be a real, active one');
log((await logVisit({ postId: riverfrontPost.id, visitedAt: 'yesterday-ish' })).status === 422, 'the time has to be a time');
log((await logVisit({ postId: riverfrontPost.id, visitedAt: new Date(Date.now() + 86400000).toISOString() })).status === 422,
  'a visit cannot be in the future');
log((await logVisit({ postId: riverfrontPost.id, visitedAt: new Date(Date.now() - 10 * 86400000).toISOString() })).status === 422,
  'or more than a week back');
log((await logVisit({ postId: riverfrontPost.id, rating: 9 })).status === 422, 'a rating is one to five');

const internal = 'Officer was on a personal call when I arrived. Spoke to him about it.';
const forClient = 'Supervisor visit to the lobby. Post in order.';
const made = await logVisit({
  postId: riverfrontPost.id, officerId: marcusRow.id, visitedAt: recent,
  uniformOk: true, postOrdersReviewed: true, equipmentOk: false, siteSecure: true, rating: 3,
  notes: internal, clientNote: forClient,
});
const visit = made.data.visit;
log(made.status === 201 && visit.site_id === riverfrontPost.site_id, 'a supervisor logs a visit, and the post decides the site');
log(visit.failed.length === 1 && /Equipment/.test(visit.failed[0]) && visit.equipment_ok === false, 'with the failed check spelled out');
log(visit.officer_name === 'Marcus Bell' && visit.supervisor_name === 'Renata Diaz', 'and who was there');

/* ============================================================ reading === */
section('who sees what');

const all = await call('/visits?days=60&limit=200', { token: supervisor });
log(all.status === 200 && all.data.visits.some((v) => v.id === visit.id), 'supervisors see the visit');
log(new Set(all.data.visits.map((v) => v.supervisor_name)).size > 1, "and every other supervisor's visits too");
const bySite = await call(`/visits?siteId=${riverfrontPost.site_id}&days=60`, { token: supervisor });
log(bySite.data.visits.length > 0 && bySite.data.visits.every((v) => v.site_id === riverfrontPost.site_id), 'the list narrows to one site');
const problems = await call('/visits?issues=1&days=60', { token: supervisor });
log(problems.data.visits.some((v) => v.id === visit.id) && problems.data.visits.every((v) => v.failed.length || v.rating <= 2),
  'and to the visits that found a problem');
log((await call('/visits?siteId=abc', { token: supervisor })).status === 422, 'a junk site id is refused');

const officerView = await call(`/visits?days=60&officerId=${staff.find((e) => e.employee_code === '1011')?.id}`, { token: marcus });
log(officerView.status === 200 && officerView.data.visits.length > 0 && officerView.data.visits.every((v) => v.officer_id === marcusRow.id),
  'an officer sees only the visits made to them, whatever they ask for');
log(officerView.data.visits.some((v) => v.id === visit.id && v.notes === internal), 'including what the supervisor said');
log((await call('/visits/board', { token: marcus })).status === 403, 'officers do not see the board');

const clientVisits = await call('/client/visits?days=60', { token: dana });
const theirs = clientVisits.data.visits.find((v) => v.id === visit.id);
log(clientVisits.status === 200 && theirs?.note === forClient, 'the client reads the note written for them');
log(clientVisits.data.visits.every((v) => !('notes' in v) && !('rating' in v) && !('officer_name' in v)),
  "never the supervisor's own notes, the rating or the officer's name");
log(!JSON.stringify(clientVisits.data).includes('personal call'), 'the internal note appears nowhere in the response');
const dar = await call(`/client/dar?siteId=${riverfrontPost.site_id}`, { token: dana });
log(dar.status === 200 && dar.data.visits.every((v) => !('notes' in v) && !('rating' in v)) && !JSON.stringify(dar.data).includes('personal call'),
  'nor in the daily activity report');

/* ============================================================== board === */
section('sites due a visit');

const board = (await call('/visits/board', { token: supervisor })).data;
log(board.sites.length >= 10 && board.dueAfterDays === 14, 'the board lists every active site', `${board.sites.length} sites`);
const order = board.sites.map((s) => s.days_since ?? Infinity);
log(order.every((d, i) => i === 0 || order[i - 1] >= d), 'longest without a visit first');
const due = board.sites.filter((s) => s.due);
log(due.length >= 1 && due.every((s) => s.days_since === null || s.days_since >= 14) && board.due === due.length,
  'sites with no visit in 14 days are due', due.map((s) => s.name).join(', '));
log(board.sites.find((s) => s.id === riverfrontPost.site_id)?.due === false, 'a site just visited is not');

const dash = await call('/admin/dashboard', { token: supervisor });
log(dash.data.counts.visitsDue === board.due, 'the navigation badge counts the same sites');
const alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
const dueSite = due[0];
const dueKey = alerts.find((a) => a.kind === 'visit_due' && a.key.startsWith(`visit-due:${dueSite.id}:`))?.key;
log(Boolean(dueKey), 'each site due a visit is in the alerts inbox');
log(alerts.some((a) => a.key === `visit:${visit.id}` && a.kind === 'visit' && /equipment/.test(a.detail)), 'as is a visit that found a problem');
const health = await call('/admin/site-health', { token: supervisor });
const dueHealth = health.data.sites.find((s) => s.id === dueSite.id);
log(dueHealth?.visitDue && dueHealth.concerns.some((c) => /supervisor visit|visited by a supervisor/.test(c)), 'and site health says so');

const duePost = ref.posts.find((p) => p.site_id === dueSite.id);
const visitDue = await logVisit({ siteId: dueSite.id, postId: duePost?.id ?? null, visitedAt: recent, uniformOk: true, postOrdersReviewed: true, equipmentOk: true, siteSecure: true, rating: 5 });
log(visitDue.status === 201, `a supervisor goes to ${dueSite.name}`);
const after = (await call('/visits/board', { token: supervisor })).data;
log(after.sites.find((s) => s.id === dueSite.id)?.due === false && after.due === board.due - 1, 'and it drops off the due list');
log(!(await call('/admin/alerts', { token: supervisor })).data.alerts.some((a) => a.key === dueKey), 'and out of the alerts');

/* ============================================================= report === */
section('visits report');

const today = localDay();
const monthAgo = localDay(-29);
const report = await call(`/admin/reports/visits-by-site?from=${monthAgo}&to=${today}`, { token: supervisor });
log(report.status === 200 && report.data.rows.length === after.sites.length, 'the report has a row for every active site');
const inRange = (await call('/visits?days=30&limit=200', { token: supervisor })).data.visits.length;
log(report.data.totals.visits === report.data.rows.reduce((n, r) => n + r.visits, 0) && report.data.totals.visits <= inRange,
  'and its visits add up', `${report.data.totals.visits}`);
log(report.data.rows.find((r) => r.site === 'Riverfront Commerce Center')?.problems >= 1, 'counting the visits that found a problem');
const scoped = await call(`/admin/reports/visits-by-site?from=${monthAgo}&to=${today}&siteId=${riverfrontPost.site_id}`, { token: supervisor });
log(scoped.data.rows.length === 1, 'it can be run for one site');
const csv = await fetch(`${BASE}/admin/reports/visits-by-site/export.csv?from=${monthAgo}&to=${today}`, { headers: { authorization: `Bearer ${supervisor}` } });
log(csv.ok && (await csv.text()).startsWith('Site,Visits,'), 'and exported');

finish('Supervisor field visits');
