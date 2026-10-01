/**
 * Service agreements: what each site pays for, against the roster and the
 * hours worked.
 *
 * Supervisors read the board; only an administrator sets or removes an
 * agreement. A site rostered short of its agreement for the next week, and
 * an agreement inside its notice period, are raised as alerts and counted.
 * A client sees their own properties' agreements and hours, never another
 * client's and never our notes.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const officer = await signIn('1003', '4812');
log(Boolean(admin && supervisor && officer), 'signed in as administrator, supervisor and officer');
const clientToken = async (email, password) => (await call('/client/login', { method: 'POST', body: { email, password } })).data?.token;
const carla = await clientToken('carla.mendez@harborviewhealth.org', 'harborview-portal-04');
log(Boolean(carla), 'and as a client contact');

const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* =============================================================== board === */
section('the board');

const board = await call('/admin/agreements', { token: supervisor });
log(board.status === 200 && board.data.sites.length > 0 && typeof board.data.summary.short === 'number', 'supervisors see every site against its agreement');
log(board.data.sites.every((s) => 'rostered_hours' in s && 'delivered_hours' in s), 'with the hours rostered for the next week and worked in the last');
log((await call('/admin/agreements', { token: officer })).status === 403, 'officers cannot');
log((await call('/admin/agreements')).status === 401, 'nor can anyone signed out');

// A site to work with: one the client above can see, so the portal can be checked too.
const me = (await call('/client/me', { token: carla })).data;
const siteId = (me.sites || [])[0]?.id;
const row = board.data.sites.find((s) => s.id === siteId);
log(Boolean(row), 'Harborview is on the board', row?.name);
const original = row.agreement;

/* ============================================================= editing === */
section('setting an agreement');

const put = (body, token = admin, id = siteId) => call(`/admin/agreements/${id}`, { token, method: 'PUT', body });
const good = { weeklyHours: 120, startsOn: inDays(-200), endsOn: inDays(165), noticeDays: 60, autoRenew: false, notes: 'Rate review due in the spring.' };
log((await put(good, supervisor)).status === 403, 'only an administrator sets an agreement');
log((await put({ ...good, weeklyHours: 0 })).status === 422, 'an agreement needs hours');
log((await put({ ...good, weeklyHours: 5000 })).status === 422, 'and a believable number of them');
log((await put({ ...good, endsOn: inDays(-300) })).status === 422, 'it has to end after it starts');
log((await put({ ...good, endsOn: '31/12/2027' })).status === 422, 'dates are calendar dates');
log((await put(good, admin, 999999)).status === 404, 'and the site has to exist');

const short = await put({ ...good, weeklyHours: row.rostered_hours + 40 });
log(short.status === 200 && short.data.agreement.weekly_hours === row.rostered_hours + 40, 'an administrator sets the hours a week the client pays for');
let now = (await call('/admin/agreements', { token: supervisor })).data.sites.find((s) => s.id === siteId);
log(now.short && now.shortfall_hours === 40, 'a site rostered 40 hours short of it is flagged short', `${now.shortfall_hours} h`);
let alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
log(alerts.some((a) => a.kind === 'agreement' && a.key.startsWith(`agreement-short:${siteId}:`)), 'and raised in the alerts inbox');
const dash = (await call('/admin/dashboard', { token: supervisor })).data.counts;
log(dash.agreementsShort >= 1, 'and counted on the sidebar');

const met = await put({ ...good, weeklyHours: row.rostered_hours });
now = (await call('/admin/agreements', { token: supervisor })).data.sites.find((s) => s.id === siteId);
log(met.status === 200 && !now.short, 'rostered to the agreement, it is not short');
alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
log(!alerts.some((a) => a.key.startsWith(`agreement-short:${siteId}:`)), 'and the alert clears');

/* ============================================================= renewal === */
section('renewals');

await put({ ...good, weeklyHours: row.rostered_hours, endsOn: inDays(30), noticeDays: 60 });
now = (await call('/admin/agreements', { token: supervisor })).data.sites.find((s) => s.id === siteId);
log(now.agreement.renewal_due && now.agreement.days_left === 30, 'an agreement ending inside its notice period is due for renewal');
alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
log(alerts.some((a) => a.key === `agreement-renewal:${siteId}:${inDays(30)}`), 'and in the alerts inbox');
await put({ ...good, weeklyHours: row.rostered_hours, endsOn: inDays(30), noticeDays: 60, autoRenew: true });
now = (await call('/admin/agreements', { token: supervisor })).data.sites.find((s) => s.id === siteId);
log(!now.agreement.renewal_due, 'unless it renews on its own');

/* ============================================================== client === */
section('the client portal');

const portal = await call('/client/agreement', { token: carla });
const mine = portal.data.sites.find((s) => s.id === siteId);
log(portal.status === 200 && mine?.agreement?.weekly_hours === row.rostered_hours, 'the client sees the hours their property is contracted for');
log(mine.weeks.length >= 1 && mine.weeks.length <= 4 && mine.weeks.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.week_of) && typeof w.hours === 'number'), 'and the hours worked in each of the last four weeks we have records for');
log(!('notes' in mine.agreement), 'but not our notes on it');
log(portal.data.sites.every((s) => (me.sites || []).some((x) => x.id === s.id)), 'and only their own properties');
log((await call('/client/agreement')).status === 401, 'signed out, nothing');

/* ============================================================== report === */
section('the report');

const report = await call('/admin/reports/agreement-hours', { token: admin });
log(report.status === 200 && report.data.rows.some((r) => r.site === row.name) && report.data.columns.some((c) => c.key === 'pct'),
  'hours against agreements, site by site');

/* ============================================================= removal === */
section('removing an agreement');

log((await call(`/admin/agreements/${siteId}`, { token: supervisor, method: 'DELETE' })).status === 403, 'only an administrator removes one');
log((await call(`/admin/agreements/${siteId}`, { token: admin, method: 'DELETE' })).status === 200, 'an administrator removes it');
log((await call(`/admin/agreements/${siteId}`, { token: admin, method: 'DELETE' })).status === 404, 'once');
if (original) {
  await put({
    weeklyHours: original.weekly_hours, startsOn: original.starts_on, endsOn: original.ends_on,
    noticeDays: original.notice_days, autoRenew: original.auto_renew, notes: original.notes,
  });
}

const audit = (await call('/admin/audit?limit=200', { token: admin })).data?.entries || [];
log(audit.some((e) => e.action === 'agreement.saved') && audit.some((e) => e.action === 'agreement.removed'), 'changes to agreements are audited');

finish('Service agreements');
