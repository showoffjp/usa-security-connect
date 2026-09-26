/**
 * What each kind of account can actually do.
 *
 * Three tiers of staff, plus the separate client identity:
 *
 *   Officer     - their own work only. No admin console at all.
 *   Supervisor  - runs the shift. Sees everything operational, approves
 *                 things, but changes no records and touches no money.
 *   Administrator - everything, including people, pay, money and the audit log.
 *
 * Every boundary below is checked in both directions: that the tier which
 * should have it does, and that the tier below it is refused. A permission
 * model nobody tests is a permission model nobody has.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');       // Vince Ortega
const supervisor = await signIn('1002', '3571');  // Renata Diaz
const officer = await signIn('1003', '4812');     // Marcus Bell

log(Boolean(admin && supervisor && officer), 'all three tiers sign in');

const sites = (await call('/admin/sites', { token: admin })).data.sites;
const riverfront = sites.find((s) => s.name.includes('Riverfront'));

/**
 * A throwaway employee for the destructive checks.
 *
 * Resetting a PIN or editing a record has to be done to somebody, and doing it
 * to a seeded officer would leave the documented demo credentials broken for
 * whoever runs this next.
 */
const scratch = (
  await call('/admin/employees', {
    token: admin,
    method: 'POST',
    body: {
      firstName: 'Role',
      lastName: 'Fixture',
      role: 'officer',
      employmentType: 'w2',
      payType: 'hourly',
      status: 'applicant',
    },
  })
).data.employee;
log(Boolean(scratch?.id), 'a scratch employee exists for the destructive checks', `id ${scratch?.id}`);

/** Assert one endpoint against all three tiers at once. */
async function tiers(label, request, expected) {
  const got = {
    officer: (await request(officer)).status,
    supervisor: (await request(supervisor)).status,
    admin: (await request(admin)).status,
  };
  const ok = (actual, want) => (want === 'allow' ? actual < 400 : actual === want);
  const pass =
    ok(got.officer, expected.officer) &&
    ok(got.supervisor, expected.supervisor) &&
    ok(got.admin, expected.admin);
  log(pass, label, `officer ${got.officer} · supervisor ${got.supervisor} · admin ${got.admin}`);
}

/* ============================================================= identity === */
section('who they are');

for (const [token, code, role, name] of [
  [officer, '1003', 'officer', 'Marcus Bell'],
  [supervisor, '1002', 'supervisor', 'Renata Diaz'],
  [admin, '1001', 'admin', 'Vince Ortega'],
]) {
  const me = await call('/auth/me', { token });
  log(
    me.data?.user?.role === role && me.data.user.employee_code === code,
    `${code} is ${role}`,
    me.data?.user?.full_name
  );
  log(me.data.user.pin_hash === undefined, `and ${name}'s PIN hash never leaves the server`);
}

/* ========================================================= the console === */
section('who gets the admin console at all');

await tiers('the dashboard', (t) => call('/admin/dashboard', { token: t }), {
  officer: 403,
  supervisor: 'allow',
  admin: 'allow',
});

await tiers('the employee list', (t) => call('/admin/employees', { token: t }), {
  officer: 403,
  supervisor: 'allow',
  admin: 'allow',
});

await tiers('timesheets and pay', (t) => call('/admin/timesheets', { token: t }), {
  officer: 403,
  supervisor: 'allow',
  admin: 'allow',
});

await tiers('the compliance flag queue', (t) => call('/admin/flags', { token: t }), {
  officer: 403,
  supervisor: 'allow',
  admin: 'allow',
});

await tiers('the daily activity report', (t) => call('/reports/dar', { token: t }), {
  officer: 403,
  supervisor: 'allow',
  admin: 'allow',
});

await tiers('the live operations map', (t) => call('/reports/map', { token: t }), {
  officer: 403,
  supervisor: 'allow',
  admin: 'allow',
});

/* =============================================== supervisor's ceiling === */
section('what a supervisor may look at but not change');

await tiers(
  'creating an employee',
  (t) =>
    call('/admin/employees', {
      token: t,
      method: 'POST',
      body: { firstName: 'Test', lastName: 'Hire', role: 'officer', employmentType: 'w2', payType: 'hourly' },
    }),
  { officer: 403, supervisor: 403, admin: 'allow' }
);

await tiers(
  'resetting an officer PIN',
  (t) => call(`/admin/employees/${scratch.id}/reset-pin`, { token: t, method: 'POST' }),
  { officer: 403, supervisor: 403, admin: 'allow' }
);

await tiers(
  'editing an employee record',
  (t) => call(`/admin/employees/${scratch.id}`, { token: t, method: 'PATCH', body: { uniformSize: 'L' } }),
  { officer: 403, supervisor: 403, admin: 'allow' }
);

// Editing is a partial update, which a refined zod schema cannot express -
// getting that wrong 500s every save from the Employees screen.
const edited = await call(`/admin/employees/${scratch.id}`, {
  token: admin,
  method: 'PATCH',
  body: { uniformSize: 'L', notes: 'Role suite fixture.' },
});
log(edited.status === 200, 'an admin can actually save an employee edit', `${edited.status}`);
log(edited.data?.employee?.uniform_size === 'L', 'and the change sticks');

// The classification rule has to survive a partial update: patching only the
// status must still be judged against the contractor's existing paperwork.
const contractor = (
  await call('/admin/employees', {
    token: admin,
    method: 'POST',
    body: {
      firstName: 'Contractor',
      lastName: 'Fixture',
      role: 'officer',
      employmentType: '1099',
      payType: 'hourly',
      status: 'active',
      w9OnFile: true,
    },
  })
).data.employee;
log(Boolean(contractor?.id), 'a 1099 fixture exists for the classification checks');
const clearW9 = await call(`/admin/employees/${contractor.id}`, {
  token: admin,
  method: 'PATCH',
  body: { w9OnFile: false, status: 'on_leave' },
});
log(clearW9.status === 200, 'a contractor can have their W-9 marked missing while off duty');

const reactivate = await call(`/admin/employees/${contractor.id}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'active' },
});
log(
  reactivate.status === 422,
  'but cannot be made active again without it, even though the patch never mentions the W-9',
  reactivate.data?.error
);

// Leave the fixtures out of the way rather than active in the roster.
for (const id of [scratch.id, contractor.id]) {
  await call(`/admin/employees/${id}`, { token: admin, method: 'PATCH', body: { status: 'terminated' } });
}

// A finished entry from this week: older weeks may sit in a closed pay
// period, where a correction is refused for every role.
const weekAgo = new Date(Date.now() - 3 * 86400000).toISOString();
const adjustable = (await call(`/admin/time-entries?from=${weekAgo}`, { token: admin })).data.entries.find((e) => e.clock_out_at);

await tiers(
  'adjusting a recorded time entry',
  (t) =>
    call(`/admin/time-entries/${adjustable.id}`, {
      token: t,
      method: 'PATCH',
      body: { reason: 'Role boundary check, no change intended.' },
    }),
  { officer: 403, supervisor: 403, admin: 'allow' }
);

await tiers(
  'creating a site',
  (t) => call('/admin/sites', { token: t, method: 'POST', body: { name: `Role check ${Date.now()}` } }),
  { officer: 403, supervisor: 403, admin: 'allow' }
);

await tiers('reading the audit log', (t) => call('/admin/audit', { token: t }), {
  officer: 403,
  supervisor: 403,
  admin: 'allow',
});

/* ================================================================ money === */
section('money is administrators only');

await tiers('seeing the invoice list', (t) => call('/invoices', { token: t }), {
  officer: 403,
  supervisor: 'allow',
  admin: 'allow',
});

await tiers(
  'raising an invoice',
  (t) =>
    call('/invoices', {
      token: t,
      method: 'POST',
      body: { siteId: riverfront.id, periodStart: '2020-01-01', periodEnd: '2020-01-02' },
    }),
  // 409 for the admin: no billable hours in 2020, which still proves the gate
  // was passed. A supervisor never reaches the check.
  { officer: 403, supervisor: 403, admin: 409 }
);

await tiers('managing client portal logins', (t) => call('/admin/clients', { token: t }), {
  officer: 403,
  supervisor: 'allow',
  admin: 'allow',
});

await tiers(
  'creating a client portal login',
  (t) =>
    call('/admin/clients', {
      token: t,
      method: 'POST',
      body: { email: `role.check.${Date.now()}@example.com`, name: 'Role Check', siteIds: [] },
    }),
  { officer: 403, supervisor: 403, admin: 201 }
);

/* ========================================== what an officer does have === */
section('an officer is not locked out of their own work');

for (const [label, path] of [
  ['their duty status', '/timeclock/status'],
  ['their own schedule', '/schedule'],
  ['their own hours', '/schedule/hours'],
  ['their incident reports', '/incidents'],
  ['their tours', '/tours'],
  ['open shifts to claim', '/shifts/open'],
  ['their time-off requests', '/time-off'],
  ['their certifications', '/certifications'],
  ['broadcasts to them', '/broadcasts'],
  ['their training', '/training'],
  ['sites and posts to clock into', '/reference'],
]) {
  const res = await call(path, { token: officer });
  log(res.status === 200, `an officer can reach ${label}`, `${res.status}`);
}

// The supervisor is an officer too - they stand posts as well as run them.
const supervisorClock = await call('/timeclock/status', { token: supervisor });
log(supervisorClock.status === 200, 'a supervisor still has their own time clock');

/* ==================================================== supervisor extras === */
section('what a supervisor gets that an officer does not');

await tiers('the shift request queue', (t) => call('/shifts/requests?scope=all', { token: t }), {
  officer: 'allow', // an officer sees their own; the queue is filtered, not refused
  supervisor: 'allow',
  admin: 'allow',
});

const officerQueue = await call('/shifts/requests?scope=all', { token: officer });
const supervisorQueue = await call('/shifts/requests?scope=all', { token: supervisor });
log(
  supervisorQueue.data.requests.length >= officerQueue.data.requests.length,
  'and the supervisor sees at least as many requests as one officer does',
  `${officerQueue.data.requests.length} vs ${supervisorQueue.data.requests.length}`
);

await tiers('approving time off', (t) => call('/time-off?scope=all', { token: t }), {
  officer: 'allow', // scoped to themselves
  supervisor: 'allow',
  admin: 'allow',
});

const officerTimeOff = await call('/time-off?scope=all', { token: officer });
log(
  officerTimeOff.data.requests.every((r) => r.user_id === undefined || r.user_id === 3),
  "an officer's time-off list is only ever their own"
);

/* ============================================ the client is not staff === */
section('a client contact is none of the above');

const dana = (
  await call('/client/login', {
    method: 'POST',
    body: { email: 'dana.whitfield@riverfrontholdings.com', password: 'riverfront-portal-01' },
  })
).data.token;

for (const [label, path] of [
  ['the admin dashboard', '/admin/dashboard'],
  ['the employee list', '/admin/employees'],
  ['timesheets', '/admin/timesheets'],
  ['invoices as staff see them', '/invoices'],
  ["an officer's time clock", '/timeclock/status'],
]) {
  const res = await call(path, { token: dana });
  log(res.status === 401, `a client cannot reach ${label}`, `${res.status}`);
}

const danaPortal = await call('/client/overview', { token: dana });
log(danaPortal.status === 200, 'but their own portal works');

finish('roles');
