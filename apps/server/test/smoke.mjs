const BASE = 'http://localhost:4000/api';
let failures = 0;

const log = (ok, label, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON (csv) */ }
  return { status: res.status, data };
}

const health = await call('/health');
log(health.status === 200, 'health', health.data?.service);

// --- auth ---------------------------------------------------------------
const bad = await call('/auth/login', { method: 'POST', body: { employeeCode: '1003', pin: '0000' } });
log(bad.status === 401, 'wrong PIN rejected', bad.data?.error);

const unknown = await call('/auth/login', { method: 'POST', body: { employeeCode: '9999', pin: '1234' } });
log(unknown.status === 401, 'unknown code rejected');

const officer = await call('/auth/login', { method: 'POST', body: { employeeCode: '1003', pin: '4812' } });
log(officer.status === 200 && !!officer.data?.token, 'officer login', officer.data?.user?.full_name);
const oTok = officer.data?.token;

const admin = await call('/auth/login', { method: 'POST', body: { employeeCode: '1001', pin: '2468' } });
log(admin.status === 200, 'admin login', admin.data?.user?.full_name);
const aTok = admin.data?.token;

const noAuth = await call('/timeclock/status');
log(noAuth.status === 401, 'unauthenticated request blocked');

const forbidden = await call('/admin/dashboard', { token: oTok });
log(forbidden.status === 403, 'officer blocked from admin area');

// --- officer ------------------------------------------------------------
const status = await call('/timeclock/status', { token: oTok });
log(status.status === 200 && status.data.onDuty === true, 'officer on duty',
  `${status.data?.entry?.post_name} / ${status.data?.entry?.minutes_on_post}m on post`);
log(typeof status.data.weekMinutes === 'number', 'week minutes present', String(status.data.weekMinutes));

const dupe = await call('/timeclock/clock-in', { token: oTok, method: 'POST', body: { method: 'manual' } });
log(dupe.status === 409, 'double clock-in refused', dupe.data?.error);

const check = await call('/timeclock/check-in', { token: oTok });
log(check.status === 200, 'check-in prompt', check.data?.checkIn ? `due ${check.data.checkIn.due_at}` : 'none pending');

if (check.data?.checkIn?.id) {
  const ans = await call('/timeclock/check-in', {
    token: oTok, method: 'POST',
    body: { checkId: check.data.checkIn.id, latitude: 30.3196, longitude: -81.6795 },
  });
  log(ans.status === 200, 'check-in answered', ans.data?.status);
}

const entries = await call('/timeclock/entries', { token: oTok });
log(entries.status === 200 && entries.data.entries.length > 0, 'time entry history', `${entries.data?.entries?.length} rows`);

const sched = await call('/schedule', { token: oTok });
log(sched.status === 200 && sched.data.shifts.length > 0, 'officer schedule', `${sched.data?.shifts?.length} shifts`);

const hours = await call('/schedule/hours', { token: oTok });
log(hours.status === 200, 'hours summary', `${hours.data?.thisWeek?.hours}h this week`);

const bcast = await call('/broadcasts', { token: oTok });
log(bcast.status === 200 && bcast.data.broadcasts.length >= 3, 'broadcasts', `${bcast.data?.broadcasts?.length}`);

const training = await call('/training', { token: oTok });
log(training.status === 200 && training.data.trainings.length >= 3, 'training list', `${training.data?.trainings?.length}`);

const earlyComplete = await call(`/training/${training.data.trainings[0].id}/progress`, {
  token: oTok, method: 'POST', body: { secondsWatched: 5, completed: true },
});
log(earlyComplete.status === 409, 'required video cannot be skipped', earlyComplete.data?.error);

// --- incidents ----------------------------------------------------------
const shortReport = await call('/incidents', {
  token: oTok, method: 'POST',
  body: { occurredAt: new Date().toISOString(), whatHappened: 'too short' },
});
log(shortReport.status === 422, 'incident validation', shortReport.data?.details?.[0]?.message);

const newIncident = await call('/incidents', {
  token: oTok, method: 'POST',
  body: {
    occurredAt: new Date().toISOString(),
    category: 'Suspicious Activity',
    severity: 'medium',
    locationText: 'East parking deck, level 3',
    whatHappened: 'Observed an unfamiliar vehicle parked in a reserved bay with occupants remaining inside for roughly twenty minutes.',
    resolution: 'Approached the vehicle, verified the occupants were waiting for a tenant, and directed them to visitor parking.',
    peopleNotified: 'Dispatch',
    costRecovery: 0,
  },
});
log(newIncident.status === 201, 'incident created', newIncident.data?.refNumber);

const myIncidents = await call('/incidents', { token: oTok });
log(myIncidents.status === 200, 'incident list', `${myIncidents.data?.incidents?.length} visible to officer`);

// --- tours --------------------------------------------------------------
const tours = await call('/tours', { token: oTok });
log(tours.status === 200 && tours.data.tours.length > 0, 'tours at site', `${tours.data?.tours?.length}`);

const run = await call(`/tours/${tours.data.tours[0].id}/start`, { token: oTok, method: 'POST' });
log(run.status === 201, 'tour started', `${run.data?.progress?.total} checkpoints`);

const runId = run.data?.run?.id;
const firstCp = run.data?.checkpoints?.[0];
const scan = await call(`/tours/runs/${runId}/checkpoints/${firstCp.checkpoint_id}/scan`, {
  token: oTok, method: 'POST', body: { method: 'nfc', tagId: firstCp.nfc_tag_id },
});
log(scan.status === 200 && scan.data.progress.done === 1, 'checkpoint scanned (NFC)', `${scan.data?.progress?.done}/${scan.data?.progress?.total}`);

const wrongTag = await call(`/tours/runs/${runId}/checkpoints/${run.data.checkpoints[1].checkpoint_id}/scan`, {
  token: oTok, method: 'POST', body: { method: 'nfc', tagId: 'USC-NFC-WRONG-999' },
});
log(wrongTag.status === 409, 'wrong NFC tag rejected', wrongTag.data?.error);

const earlyFinish = await call(`/tours/runs/${runId}/complete`, { token: oTok, method: 'POST' });
log(earlyFinish.status === 409, 'tour cannot finish with required checkpoints open', earlyFinish.data?.error);

// --- admin --------------------------------------------------------------
const dash = await call('/admin/dashboard', { token: aTok });
log(dash.status === 200, 'admin dashboard',
  `${dash.data?.counts?.onDuty} on duty, ${dash.data?.counts?.openFlags} open flags, ${dash.data?.counts?.unfilledShifts} unfilled`);

const staff = await call('/admin/employees', { token: aTok });
log(staff.status === 200 && staff.data.employees.length >= 8, 'employee list', `${staff.data?.employees?.length}`);
log(!('pin_hash' in (staff.data.employees[0] || {})), 'PIN hash never leaves the server');

const created = await call('/admin/employees', {
  token: aTok, method: 'POST',
  body: { firstName: 'Test', lastName: 'Recruit', role: 'officer', phone: '(904) 555-0000' },
});
log(created.status === 201 && /^\d{4}$/.test(created.data?.credentials?.pin || ''),
  'employee created with generated PIN',
  `code ${created.data?.credentials?.employeeCode} pin ${created.data?.credentials?.pin}`);

// The generated credentials must actually work.
const newLogin = await call('/auth/login', {
  method: 'POST',
  body: { employeeCode: created.data.credentials.employeeCode, pin: created.data.credentials.pin },
});
log(newLogin.status === 200 && newLogin.data.mustChangePin === true, 'new hire must change PIN at first sign-in');

const weakPin = await call('/auth/change-pin', {
  token: newLogin.data.token, method: 'POST',
  body: { currentPin: created.data.credentials.pin, newPin: '1234', confirmPin: '1234' },
});
log(weakPin.status === 422, 'weak PIN refused', weakPin.data?.error);

const goodPin = await call('/auth/change-pin', {
  token: newLogin.data.token, method: 'POST',
  body: { currentPin: created.data.credentials.pin, newPin: '7391', confirmPin: '7391' },
});
log(goodPin.status === 200 && goodPin.data.user.must_change_pin === false, 'PIN changed');

const reset = await call(`/admin/employees/${created.data.employee.id}/reset-pin`, { token: aTok, method: 'POST' });
log(reset.status === 200 && /^\d{4}$/.test(reset.data?.pin || ''), 'admin PIN reset', reset.data?.pin);

// A six-digit PIN - what a reset can issue and what the first administrator
// is given - has to sign in like any other.
const reset6 = await call(`/admin/employees/${created.data.employee.id}/reset-pin`, {
  token: aTok, method: 'POST', body: { length: 6 },
});
log(reset6.status === 200 && /^\d{6}$/.test(reset6.data?.pin || ''), 'a six-digit PIN can be issued', reset6.data?.pin);
const login6 = await call('/auth/login', {
  method: 'POST', body: { employeeCode: created.data.employee.employee_code, pin: reset6.data?.pin },
});
log(login6.status === 200 && Boolean(login6.data?.token), 'and signs in');

const timesheets = await call('/admin/timesheets', { token: aTok });
log(timesheets.status === 200 && timesheets.data.rows.length > 0, 'timesheets',
  `top: ${timesheets.data?.rows?.[0]?.officer} ${timesheets.data?.rows?.[0]?.hours}h`);

const flags = await call('/admin/flags', { token: aTok });
log(flags.status === 200, 'flag queue', `${flags.data?.flags?.length} open: ${[...new Set((flags.data?.flags || []).map(f => f.label))].join(', ')}`);

if (flags.data.flags.length) {
  const noNote = await call(`/admin/flags/${flags.data.flags[0].id}/resolve`, { token: aTok, method: 'POST', body: {} });
  log(noNote.status === 422, 'flag resolution requires a note');

  const resolved = await call(`/admin/flags/${flags.data.flags[0].id}/resolve`, {
    token: aTok, method: 'POST', body: { note: 'Spoke with the officer; traffic delay, verbal coaching given.' },
  });
  log(resolved.status === 200, 'flag resolved');
}

// Scheduling conflict detection.
const shiftsAdmin = await call('/admin/shifts', { token: aTok });
log(shiftsAdmin.status === 200, 'admin schedule', `${shiftsAdmin.data?.shifts?.length} shifts in range`);

const tomorrow = new Date(Date.now() + 86400000);
tomorrow.setHours(6, 0, 0, 0);
const overlap = await call('/admin/shifts', {
  token: aTok, method: 'POST',
  body: {
    userId: 3, postId: 1,
    startsAt: tomorrow.toISOString(),
    endsAt: new Date(tomorrow.getTime() + 4 * 3600000).toISOString(),
  },
});
log(overlap.status === 409, 'overlapping shift refused', overlap.data?.error);

const bulkStart = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const bulkEnd = new Date(Date.now() + 44 * 86400000).toISOString().slice(0, 10);
const bulk = await call('/admin/shifts/bulk', {
  token: aTok, method: 'POST',
  body: {
    userId: 6, postId: 5,
    startDate: bulkStart,
    endDate: bulkEnd,
    startTime: '22:00', endTime: '06:00',
    weekdays: [1, 2, 3, 4, 5],
  },
});
// Fifteen days hold ten or eleven weekdays depending on where they start, so
// count them the way the server walks the range rather than assuming ten.
let weekdaysInRange = 0;
for (let d = new Date(bulkStart); d <= new Date(bulkEnd); d.setDate(d.getDate() + 1)) {
  if (d.getDay() >= 1 && d.getDay() <= 5) weekdaysInRange += 1;
}
log(bulk.status === 201 && bulk.data.created === weekdaysInRange, 'bulk roster generated (overnight)', `${bulk.data?.created} of ${weekdaysInRange} weekdays`);

const csv = await fetch(BASE + '/admin/export/timesheets.csv', { headers: { Authorization: `Bearer ${aTok}` } });
const csvText = await csv.text();
log(csv.status === 200 && csvText.split('\n').length > 5, 'payroll CSV export', `${csvText.split('\n').length - 1} rows`);

// --- messaging ----------------------------------------------------------
const threads = await call('/messages/threads', { token: oTok });
log(threads.status === 200 && threads.data.threads.length >= 1, 'message threads', threads.data?.threads?.[0]?.subject);

const sent = await call(`/messages/threads/${threads.data.threads[0].id}/messages`, {
  token: oTok, method: 'POST', body: { body: 'Copy that, noted on the pass-down log.' },
});
log(sent.status === 201, 'message sent');

const audit = await call('/admin/audit', { token: aTok });
log(audit.status === 200 && audit.data.entries.length > 0, 'audit trail', `${audit.data?.entries?.length} events`);

console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' CHECK(S) FAILED.'}`);
process.exit(failures === 0 ? 0 : 1);
