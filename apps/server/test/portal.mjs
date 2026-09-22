/**
 * The client portal.
 *
 * Most of this suite is negative: the portal is only worth having if a client
 * cannot see another client's property, cannot reach a staff endpoint, and
 * never receives a number that tells them what we pay an officer.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const officer = await signIn('1003', '4812');

/** The portal has its own login, so the harness helper does not fit. */
async function portalSignIn(email, password) {
  const res = await call('/client/login', { method: 'POST', body: { email, password } });
  return res.data?.token;
}

/* ================================================================ login === */
section('portal sign-in');

const dana = await portalSignIn('dana.whitfield@riverfrontholdings.com', 'riverfront-portal-01');
const marcus = await portalSignIn('marcus.reyes@palmettoridgehoa.org', 'palmetto-portal-02');
log(Boolean(dana && marcus), 'two client contacts signed in');

const wrongPassword = await call('/client/login', {
  method: 'POST',
  body: { email: 'dana.whitfield@riverfrontholdings.com', password: 'not-the-password' },
});
log(wrongPassword.status === 401, 'a wrong password is refused', wrongPassword.data?.error);

const unknownEmail = await call('/client/login', {
  method: 'POST',
  body: { email: 'nobody@example.com', password: 'not-the-password' },
});
log(
  unknownEmail.status === 401 && unknownEmail.data?.error === wrongPassword.data?.error,
  'an unknown email gives the same answer as a wrong password'
);

const noToken = await call('/client/overview');
log(noToken.status === 401, 'the portal needs a token');

/* ======================================================== token crossover === */
section('the two identity spaces stay apart');

// The single most important check in this file: the tokens are signed with the
// same secret, and both `sub` values are small integers from different tables.
const staffWithClientToken = await call('/admin/dashboard', { token: dana });
log(staffWithClientToken.status === 401, 'a client token cannot reach the admin API', staffWithClientToken.data?.error);

const officerWithClientToken = await call('/timeclock/status', { token: dana });
log(officerWithClientToken.status === 401, 'a client token cannot reach the officer API');

const portalWithStaffToken = await call('/client/overview', { token: admin });
log(portalWithStaffToken.status === 401, 'an admin token cannot reach the portal API');

const portalWithOfficerToken = await call('/client/overview', { token: officer });
log(portalWithOfficerToken.status === 401, 'an officer token cannot reach the portal API');

/* ================================================================ scope === */
section('site scoping');

const me = await call('/client/me', { token: dana });
log(me.status === 200 && me.data.sites.length === 1, 'Dana sees exactly one site', me.data?.sites?.[0]?.name);
const riverfront = me.data.sites[0];
log(riverfront.name === 'Riverfront Commerce Center', 'and it is the right one');

const marcusMe = await call('/client/me', { token: marcus });
const palmetto = marcusMe.data.sites[0];
log(palmetto.name === 'Palmetto Ridge Residences', 'Marcus sees his own site instead');

// Asking for someone else's site by id is a 404, not a 403: a client should
// not be able to probe for the existence of other accounts' properties.
const otherSite = await call(`/client/coverage?siteId=${palmetto.id}`, { token: dana });
log(otherSite.status === 404, "another client's site id is not found", otherSite.data?.error);

const danaCoverage = await call('/client/coverage?days=30', { token: dana });
log(danaCoverage.status === 200 && danaCoverage.data.shifts.length > 0, 'coverage is returned', `${danaCoverage.data?.shifts?.length} shifts`);
log(
  danaCoverage.data.shifts.every((s) => s.site_id === riverfront.id),
  'every returned shift belongs to the caller'
);

const danaIncidents = await call('/client/incidents?days=60', { token: dana });
log(danaIncidents.status === 200, 'incidents are returned', `${danaIncidents.data?.incidents?.length} found`);
log(
  danaIncidents.data.incidents.every((i) => i.site_id === riverfront.id),
  'every returned incident belongs to the caller'
);

const marcusIncidents = await call('/client/incidents?days=60', { token: marcus });
const danaIds = new Set(danaIncidents.data.incidents.map((i) => i.id));
log(
  marcusIncidents.data.incidents.every((i) => !danaIds.has(i.id)),
  'the two clients see disjoint incident lists'
);

// Reach for one of Dana's incidents with Marcus's token. Done in this
// direction because Dana's site is the one the seed guarantees incidents on.
const crossRead = await call(`/client/incidents/${danaIncidents.data.incidents[0].id}`, { token: marcus });
log(crossRead.status === 404, "one client cannot open another's incident by id", crossRead.data?.error);

const crossDar = await call(`/client/dar?siteId=${palmetto.id}`, { token: dana });
log(crossDar.status === 404, "the DAR refuses another client's site");

/* ============================================================== payroll === */
section('no pay data leaves the portal');

const FORBIDDEN =
  /^(pay_rate|pay_rate_cents|bill_rate|bill_rate_cents|pay_type|employment_type|exempt|margin|margin_cents|salary_cents|overtime_minutes|employee_code|pin_hash|pin_salt|license_number|license_type|phone|email|failed_attempts|review_notes|reviewed_by|user_id)$/i;

/** Walk every key in a response, at any depth - a leak is rarely top-level. */
function offendingKeys(value, path = '', found = []) {
  if (Array.isArray(value)) {
    value.forEach((v) => offendingKeys(v, path, found));
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN.test(key) && v !== undefined) found.push(path ? `${path}.${key}` : key);
      offendingKeys(v, path ? `${path}.${key}` : key, found);
    }
  }
  return found;
}

const overview = await call('/client/overview', { token: dana });
const patrols = await call('/client/patrols?days=30', { token: dana });
const visits = await call('/client/visits?days=60', { token: dana });
const dar = await call(`/client/dar?siteId=${riverfront.id}`, { token: dana });
const incidentDetail = await call(`/client/incidents/${danaIncidents.data.incidents[0].id}`, { token: dana });

// `me` is left out: it returns the contact's own record, so their own email
// address appearing there is the point rather than a leak.
for (const [name, res] of Object.entries({
  overview, coverage: danaCoverage, patrols, visits, dar, incidentDetail,
})) {
  log(res.status === 200, `${name} responds`, `${res.status}`);
  const leaks = offendingKeys(res.data);
  log(leaks.length === 0, `${name} carries no pay or personnel fields`, leaks.join(', '));
}

log(
  offendingKeys(me.data.sites).length === 0 && me.data.client.email === 'dana.whitfield@riverfrontholdings.com',
  'me returns the contact’s own record and nothing more'
);

/* ============================================================= content === */
section('the portal actually shows something');

log(overview.data.summary.shiftsScheduled > 0, 'coverage summary has shifts', `${overview.data.summary.shiftsScheduled} scheduled`);
log(overview.data.summary.hoursOnSite > 0, 'hours on site are counted', `${overview.data.summary.hoursOnSite}h`);
log(patrols.data.runs.length > 0, 'patrol runs are listed', `${patrols.data?.runs?.length} runs`);
log(
  patrols.data.runs.every((r) => typeof r.officer_name === 'string' && r.officer_name.length > 0),
  'each patrol names the officer who walked it'
);

// The newest run may still be in progress, so take one that reported scans.
const walkedRun = patrols.data.runs.find((r) => r.scanned > 0) || patrols.data.runs[0];
const runDetail = await call(`/client/patrols/${walkedRun.id}`, { token: dana });
log(
  runDetail.status === 200 && runDetail.data.checkpoints.length > 0,
  'a patrol opens with its checkpoint proof',
  `${runDetail.data?.checkpoints?.length} checkpoints`
);
log(
  runDetail.data.checkpoints.some((c) => c.status === 'done' && c.scanned_at),
  'scanned checkpoints carry a timestamp',
  runDetail.data.checkpoints.map((c) => c.status).join('/')
);

const crossRun = await call(`/client/patrols/${walkedRun.id}`, { token: marcus });
log(crossRun.status === 404, "one client cannot open another's patrol by id");

log(dar.status === 200 && dar.data.site.id === riverfront.id, 'the daily activity report is scoped to the site');

// Today may be quiet depending on the hour, so the content check uses a day
// the seed always fills.
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const pastDar = await call(`/client/dar?siteId=${riverfront.id}&date=${yesterday}`, { token: dana });
log(pastDar.status === 200 && pastDar.data.coverage.length > 0, 'the DAR lists who stood the posts', `${pastDar.data?.coverage?.length} entries`);
log(pastDar.data.totalHours > 0, 'and totals the hours on site', `${pastDar.data?.totalHours}h`);
log(
  pastDar.data.coverage.every((c) => typeof c.officer_name === 'string' && c.minutes_worked === undefined),
  'DAR coverage names the officer and drops the raw minutes'
);

/* ============================================ admin management of logins === */
section('admin manages portal logins');

const list = await call('/admin/clients', { token: admin });
log(list.status === 200 && list.data.clients.length >= 3, 'admin lists the portal logins', `${list.data?.clients?.length} contacts`);
log(
  list.data.clients.every((c) => !('password_hash' in c) && !('password_salt' in c)),
  'the list carries no password material'
);

const officerList = await call('/admin/clients', { token: officer });
log(officerList.status === 403, 'an officer cannot manage portal logins');

const created = await call('/admin/clients', {
  token: admin,
  method: 'POST',
  body: {
    email: 'nina.alvarez@coralbaypg.com',
    name: 'Nina Alvarez',
    company: 'Coral Bay Property Group',
    siteIds: [],
  },
});
log(created.status === 201 && created.data.password?.length >= 12, 'a login is created with a generated password');

const duplicate = await call('/admin/clients', {
  token: admin,
  method: 'POST',
  body: { email: 'NINA.ALVAREZ@coralbaypg.com', name: 'Nina Alvarez', siteIds: [] },
});
log(duplicate.status === 409, 'the same email cannot be added twice, whatever the case', duplicate.data?.error);

// A contact with no sites is told why the portal is empty rather than shown one.
const ninaToken = await portalSignIn('nina.alvarez@coralbaypg.com', created.data.password);
const ninaOverview = await call('/client/overview', { token: ninaToken });
log(ninaOverview.status === 403, 'a contact with no sites is told to call their account manager', ninaOverview.data?.error);

const ninaId = created.data.client.id;
const coralSiteId = (await call('/admin/sites', { token: admin })).data.sites.find((s) =>
  s.name.includes('Coral Bay')
)?.id;

const granted = await call(`/admin/clients/${ninaId}`, {
  token: admin,
  method: 'PATCH',
  body: { siteIds: [coralSiteId] },
});
log(granted.status === 200, 'admin grants access to a site');

const ninaAfter = await call('/client/me', { token: ninaToken });
log(
  ninaAfter.status === 200 && ninaAfter.data.sites[0]?.id === coralSiteId,
  'the contact can now see that site, on the token they already had'
);

// Two sites at once, then back to one - the grant is a replacement, not an add.
await call(`/admin/clients/${ninaId}`, {
  token: admin,
  method: 'PATCH',
  body: { siteIds: [coralSiteId, riverfront.id] },
});
const ninaTwo = await call('/client/me', { token: ninaToken });
log(ninaTwo.data.sites.length === 2, 'a contact can hold more than one site');

await call(`/admin/clients/${ninaId}`, { token: admin, method: 'PATCH', body: { siteIds: [coralSiteId] } });
const ninaOne = await call('/client/me', { token: ninaToken });
log(
  ninaOne.data.sites.length === 1 && ninaOne.data.sites[0].id === coralSiteId,
  'revoking a site takes effect immediately'
);

/* ============================================================ lifecycle === */
section('suspend, reset and delete');

const suspended = await call(`/admin/clients/${ninaId}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'suspended' },
});
log(suspended.status === 200, 'a login can be suspended');

const suspendedAccess = await call('/client/me', { token: ninaToken });
log(suspendedAccess.status === 401, 'a suspended contact loses access on their existing token');

const suspendedLogin = await call('/client/login', {
  method: 'POST',
  body: { email: 'nina.alvarez@coralbaypg.com', password: created.data.password },
});
log(suspendedLogin.status === 403, 'and cannot sign in again', suspendedLogin.data?.error);

await call(`/admin/clients/${ninaId}`, { token: admin, method: 'PATCH', body: { status: 'active' } });

const reset = await call(`/admin/clients/${ninaId}/reset-password`, { token: admin, method: 'POST' });
log(reset.status === 200 && reset.data.password?.length >= 12, 'admin resets the password');

// The whole point of a reset is that a session someone else has open dies.
const staleSession = await call('/client/me', { token: ninaToken });
log(staleSession.status === 401, 'a reset kills the session that was already open', staleSession.data?.error);

const oldPassword = await call('/client/login', {
  method: 'POST',
  body: { email: 'nina.alvarez@coralbaypg.com', password: created.data.password },
});
log(oldPassword.status === 401, 'the old password stops working');

const newToken = await portalSignIn('nina.alvarez@coralbaypg.com', reset.data.password);
log(Boolean(newToken), 'the new password works');

/* ------------------------------------------------------ self-service --- */

const badCurrent = await call('/client/change-password', {
  token: newToken,
  method: 'POST',
  body: { currentPassword: 'wrong', newPassword: 'a-much-longer-passphrase', confirmPassword: 'a-much-longer-passphrase' },
});
log(badCurrent.status === 401, 'changing a password needs the current one');

const tooShort = await call('/client/change-password', {
  token: newToken,
  method: 'POST',
  body: { currentPassword: reset.data.password, newPassword: 'short', confirmPassword: 'short' },
});
log(tooShort.status === 422, 'a short password is refused');

const mismatch = await call('/client/change-password', {
  token: newToken,
  method: 'POST',
  body: { currentPassword: reset.data.password, newPassword: 'a-much-longer-passphrase', confirmPassword: 'something-else-entirely' },
});
log(mismatch.status === 422, 'the confirmation has to match');

const changed = await call('/client/change-password', {
  token: newToken,
  method: 'POST',
  body: {
    currentPassword: reset.data.password,
    newPassword: 'a-much-longer-passphrase',
    confirmPassword: 'a-much-longer-passphrase',
  },
});
log(changed.status === 200 && Boolean(changed.data.token), 'the contact changes their own password');
log(Boolean(await portalSignIn('nina.alvarez@coralbaypg.com', 'a-much-longer-passphrase')), 'and signs in with it');

const removed = await call(`/admin/clients/${ninaId}`, { token: admin, method: 'DELETE' });
log(removed.status === 200, 'admin deletes the login');
log(
  (await call('/client/login', {
    method: 'POST',
    body: { email: 'nina.alvarez@coralbaypg.com', password: 'a-much-longer-passphrase' },
  })).status === 401,
  'a deleted login cannot sign in'
);

/* ============================================================== lockout === */
section('lockout');

for (let i = 0; i < 5; i++) {
  await call('/client/login', {
    method: 'POST',
    body: { email: 'marcus.reyes@palmettoridgehoa.org', password: `guess-${i}` },
  });
}
const locked = await call('/client/login', {
  method: 'POST',
  body: { email: 'marcus.reyes@palmettoridgehoa.org', password: 'palmetto-portal-02' },
});
log(locked.status === 423, 'repeated failures lock the account, even with the right password', locked.data?.error);

const unlocked = await call(
  `/admin/clients/${list.data.clients.find((c) => c.email === 'marcus.reyes@palmettoridgehoa.org').id}/unlock`,
  { token: admin, method: 'POST' }
);
log(unlocked.status === 200, 'a supervisor can unlock it');
log(
  Boolean(await portalSignIn('marcus.reyes@palmettoridgehoa.org', 'palmetto-portal-02')),
  'and the contact can sign in again'
);

/* ================================================================ audit === */
section('audit trail');

const auditLog = await call('/admin/audit?limit=200', { token: admin });
const actions = new Set((auditLog.data?.entries || []).map((e) => e.action));
log(actions.has('client.login'), 'a portal sign-in is audited');
log(actions.has('client.created'), 'creating a login is audited');
log(actions.has('client.password_reset'), 'a password reset is audited');
log(actions.has('client.deleted'), 'deleting a login is audited');

finish('portal');
