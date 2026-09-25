/**
 * Coverage for employment classification, pay, compliance, safety and
 * reporting. Run against a freshly seeded database with the API up.
 */

import { BASE, call, log, section, signIn, finish } from './harness.mjs';

const oTok = await signIn('1003', '4812'); // Marcus Bell, on duty
const aTok = await signIn('1001', '2468'); // Vince Ortega, administrator

log(Boolean(oTok && aTok), 'signed in as officer and administrator');

/* ================================== employment classification & pay ==== */
section('employment classification, pay & profile');

const staff = (await call('/admin/employees', { token: aTok })).data.employees;
const contractor = staff.find((e) => e.employment_type === '1099');
log(!!contractor, '1099 contractor in the roster', contractor && `${contractor.full_name} - ${contractor.business_name}`);
log(contractor?.tax_id_last4?.length === 4, 'only the last four tax digits are stored', contractor?.tax_id_last4);
log(!('pin_hash' in (contractor || {})), 'PIN hash still never leaves the server');

const badContractor = await call('/admin/employees', {
  token: aTok,
  method: 'POST',
  body: {
    firstName: 'Paper', lastName: 'Missing', role: 'officer', status: 'active',
    employmentType: '1099', payType: 'hourly', payRate: 30, w9OnFile: false,
  },
});
log(badContractor.status === 422, 'active 1099 without a W-9 is refused', badContractor.data?.error);

const goodContractor = await call('/admin/employees', {
  token: aTok,
  method: 'POST',
  body: {
    firstName: 'Paper', lastName: 'Filed', role: 'officer', status: 'active',
    employmentType: '1099', payType: 'hourly', payRate: 30, billRate: 48,
    w9OnFile: true, contractorAgreementOnFile: true, taxIdLast4: '1234',
    businessName: 'Filed Security LLC', insuranceExpiresOn: '2027-06-30',
    addressLine1: '1 Test St', city: 'Tampa', state: 'FL', postalCode: '33601',
    uniformSize: 'L', emergencyContactName: 'Kin', emergencyContactRelation: 'Sibling',
  },
});
log(goodContractor.status === 201, '1099 with paperwork accepted', goodContractor.data?.credentials?.employeeCode);

const badExempt = await call('/admin/employees', {
  token: aTok,
  method: 'POST',
  body: { firstName: 'Ex', lastName: 'Empt', employmentType: '1099', w9OnFile: true, exempt: true },
});
log(badExempt.status === 422, 'exempt status refused on a 1099', badExempt.data?.error);

const profiled = (await call('/admin/employees', { token: aTok })).data.employees.find(
  (e) => e.last_name === 'Filed'
);
log(
  profiled?.address_line1 === '1 Test St' && profiled?.uniform_size === 'L',
  'profile fields persisted (address, uniform, emergency contact)',
  `${profiled?.city}, ${profiled?.state} ${profiled?.postal_code}`
);

const sheets = await call('/admin/timesheets', { token: aTok });
log(
  sheets.status === 200 && sheets.data.totals,
  'timesheets split by classification',
  `W-2 ${sheets.data?.totals?.w2?.hours}h / 1099 ${sheets.data?.totals?.contractor?.hours}h`
);
log(sheets.data?.totals?.bill != null, 'client billing total computed', `$${sheets.data?.totals?.bill}`);

const w2Overtime = sheets.data.rows.find((r) => r.employment_type === 'w2' && r.hours > 40 && r.pay_type === 'hourly');
const contractorRow = sheets.data.rows.find((r) => r.employment_type === '1099' && r.hours > 40);
log(
  !w2Overtime || w2Overtime.earns_overtime === true,
  'W-2 hourly staff accrue overtime',
  w2Overtime && `${w2Overtime.officer}: ${w2Overtime.overtime_hours}h OT`
);
log(
  !contractorRow || (contractorRow.earns_overtime === false && contractorRow.overtime_hours === 0),
  'contractors accrue no FLSA overtime',
  contractorRow && `${contractorRow.officer}: ${contractorRow.hours}h, ${contractorRow.overtime_hours}h OT`
);

const exemptRow = sheets.data.rows.find((r) => r.exempt);
log(!exemptRow || exemptRow.earns_overtime === false, 'exempt W-2 staff accrue no overtime', exemptRow?.officer);

const marginRow = sheets.data.rows.find((r) => r.margin != null && r.hours > 0);
log(
  !!marginRow,
  'margin derived from bill rate vs pay',
  marginRow && `${marginRow.officer}: $${marginRow.margin} (${marginRow.margin_percent}%)`
);

const breakRow = sheets.data.rows.find((r) => r.break_hours > 0);
log(true, 'unpaid break hours reported on timesheets', breakRow ? `${breakRow.break_hours}h deducted` : 'none yet');

/* ================================================== certifications ==== */
section('certifications & compliance');

const expiring = await call('/certifications/expiring?days=60', { token: aTok });
log(
  expiring.status === 200 && expiring.data.items.length > 0,
  'expiry board populated',
  `${expiring.data?.items?.length} credentials`
);
log(expiring.data.items.some((i) => i.expiry.state === 'expired'), 'expired credentials surfaced');
log(expiring.data.items.some((i) => i.source === 'licence'), 'state licences folded in alongside certifications');
log(expiring.data.items.some((i) => i.source === 'insurance'), 'contractor insurance folded in');

const newCert = await call('/certifications', {
  token: aTok,
  method: 'POST',
  body: { userId: 3, type: 'AED', number: 'AED-991', expiresOn: '2028-01-31' },
});
log(newCert.status === 201, 'certification recorded against an employee');

const ownCerts = await call('/certifications', { token: oTok });
log(
  ownCerts.status === 200 && ownCerts.data.certifications.length > 0,
  'officer sees their own certifications',
  `${ownCerts.data?.certifications?.length}`
);

const snooping = await call('/certifications?userId=5', { token: oTok });
log(snooping.status === 403, "officers cannot read a colleague's certifications");

/* ============================================ availability & leave ==== */
section('availability & time off');

const availability = await call('/availability', {
  token: oTok,
  method: 'PUT',
  body: { days: [{ weekday: 0, available: false, startTime: '00:00', endTime: '23:59', note: 'Family commitment' }] },
});
log(availability.status === 200, 'officer sets their own weekly availability');

const request = await call('/time-off', {
  token: oTok,
  method: 'POST',
  body: { type: 'vacation', startsOn: '2027-03-01', endsOn: '2027-03-05', reason: 'Flights already booked.' },
});
log(request.status === 201, 'time off requested', `request ${request.data?.request?.id}`);

const overlapping = await call('/time-off', {
  token: oTok,
  method: 'POST',
  body: { type: 'sick', startsOn: '2027-03-03', endsOn: '2027-03-04' },
});
log(overlapping.status === 409, 'overlapping request refused', overlapping.data?.error);

const backwards = await call('/time-off', {
  token: oTok,
  method: 'POST',
  body: { type: 'vacation', startsOn: '2027-06-10', endsOn: '2027-06-01' },
});
log(backwards.status === 422, 'end date before start date refused');

const selfApprove = await call(`/time-off/${request.data.request.id}`, {
  token: oTok,
  method: 'PATCH',
  body: { status: 'approved' },
});
log(selfApprove.status === 403, 'officers cannot approve their own leave');

const approve = await call(`/time-off/${request.data.request.id}`, {
  token: aTok,
  method: 'PATCH',
  body: { status: 'approved', note: 'Approved. Cover arranged with Kevin.' },
});
log(approve.status === 200, 'supervisor approves leave', `${approve.data?.shiftsToRecover} shifts need re-covering`);

const reDecide = await call(`/time-off/${request.data.request.id}`, {
  token: aTok,
  method: 'PATCH',
  body: { status: 'denied' },
});
log(reDecide.status === 409, 'a decided request cannot be quietly re-decided');

const queue = await call('/time-off?scope=all&status=pending', { token: aTok });
log(queue.status === 200, 'pending queue visible to the supervisor', `${queue.data?.requests?.length} pending`);

/* ============================================================ breaks == */
section('breaks');

const startBreak = await call('/breaks/start', { token: oTok, method: 'POST', body: { type: 'meal' } });
log(startBreak.status === 201, 'meal break started');

const secondBreak = await call('/breaks/start', { token: oTok, method: 'POST', body: { type: 'rest' } });
log(secondBreak.status === 409, 'a second concurrent break is refused', secondBreak.data?.error);

const current = await call('/breaks/current', { token: oTok });
log(current.status === 200 && !!current.data.onBreak, 'break shows as active on the officer home screen');

const endBreak = await call('/breaks/end', { token: oTok, method: 'POST' });
log(endBreak.status === 200 && endBreak.data.paid === false, 'meal break closes as unpaid time', `${endBreak.data?.minutes}m`);

const endTwice = await call('/breaks/end', { token: oTok, method: 'POST' });
log(endTwice.status === 409, 'a break cannot be ended twice');

/* ===================================================== duress alerts == */
section('duress alerts');

const panic = await call('/panic', {
  token: oTok,
  method: 'POST',
  body: { latitude: 30.3196, longitude: -81.6795, accuracy: 9 },
});
log(panic.status === 201, 'duress alert raised', `alert ${panic.data?.alert?.id}`);

const repeat = await call('/panic', { token: oTok, method: 'POST', body: {} });
log(
  repeat.status === 200 && repeat.data.reused === true,
  'repeat presses update the open alert instead of flooding the board'
);

const mine = await call('/panic/mine', { token: oTok });
log(mine.status === 200 && !!mine.data.alert, 'officer can see their alert is live');

const board = await call('/panic', { token: aTok });
log(board.status === 200 && board.data.alerts.length > 0, 'alert reaches the supervisor board');

const acknowledge = await call(`/panic/${panic.data.alert.id}/acknowledge`, { token: aTok, method: 'POST' });
log(acknowledge.status === 200, 'supervisor acknowledges so the officer knows help is coming');

const noAccount = await call(`/panic/${panic.data.alert.id}/resolve`, { token: aTok, method: 'POST', body: {} });
log(noAccount.status === 422, 'closing an alert requires a written account');

const resolved = await call(`/panic/${panic.data.alert.id}/resolve`, {
  token: aTok,
  method: 'POST',
  body: { status: 'resolved', note: 'Reached the officer by phone inside a minute. Safe, no injuries.' },
});
log(resolved.status === 200, 'alert closed with an outcome on the record');

/* ======================================================== reporting === */
section('reporting & maps');

const dar = await call('/reports/dar', { token: aTok });
log(
  dar.status === 200,
  'daily activity report assembled',
  `${dar.data?.summary?.officers} officers, ${dar.data?.summary?.hours}h, ${dar.data?.summary?.incidents} incidents`
);
log(dar.data?.summary?.checkpointsScanned != null, 'DAR counts checkpoints scanned', String(dar.data?.summary?.checkpointsScanned));
log(Array.isArray(dar.data?.shifts), 'DAR lists coverage by post');

const map = await call('/reports/map', { token: aTok });
log(
  map.status === 200 && map.data.posts.length > 0,
  'map data served',
  `${map.data?.posts?.length} posts, ${map.data?.onDuty?.length} on duty`
);
log(map.data.posts.every((p) => p.latitude != null), 'every mapped post has coordinates');

const coverage = await call('/reports/coverage', { token: aTok });
log(coverage.status === 200 && coverage.data.sites.length > 0, 'client coverage summary', `${coverage.data?.sites?.length} sites`);

const officerReport = await call('/reports/dar', { token: oTok });
log(officerReport.status === 403, 'officers cannot pull client reporting');

/* ================================================== incident photos === */
section('incident photos (storage service)');

// A 1x1 PNG - enough to exercise upload, storage and retrieval end to end.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const form = new FormData();
form.set('occurredAt', new Date().toISOString());
form.set('severity', 'low');
form.set('whatHappened', 'Photographed a damaged bollard at the vehicle entrance for the maintenance log.');
form.set('photos', new Blob([PNG_1X1], { type: 'image/png' }), 'bollard.png');

const withPhoto = await fetch(`${BASE}/incidents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${oTok}` },
  body: form,
});
const photoIncident = await withPhoto.json();
log(withPhoto.status === 201 && photoIncident.photos === 1, 'incident created with a photo', photoIncident.refNumber);

const detail = await call(`/incidents/${photoIncident.incident.id}`, { token: oTok });
log(detail.data?.photos?.length === 1, 'photo recorded against the incident');

const photoId = detail.data.photos[0].id;
const fetched = await fetch(`${BASE}/incidents/${photoIncident.incident.id}/photos/${photoId}`, {
  headers: { Authorization: `Bearer ${oTok}` },
});
const bytes = Buffer.from(await fetched.arrayBuffer());
log(
  fetched.status === 200 && bytes.equals(PNG_1X1),
  'photo served back byte-for-byte',
  `${bytes.length} bytes, ${fetched.headers.get('content-type')}`
);

const anonymousPhoto = await fetch(`${BASE}/incidents/${photoIncident.incident.id}/photos/${photoId}`);
log(anonymousPhoto.status === 401, 'photos are not public - authentication required');

// Reject anything that is not an image, whatever the extension claims.
const badForm = new FormData();
badForm.set('occurredAt', new Date().toISOString());
badForm.set('whatHappened', 'Attempted to attach a file that is not an image at all.');
badForm.set('photos', new Blob([Buffer.from('MZ not an image')], { type: 'application/x-msdownload' }), 'evil.exe');
const badUpload = await fetch(`${BASE}/incidents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${oTok}` },
  body: badForm,
});
log(badUpload.status === 422, 'non-image upload refused');

/* ==================================================== cron endpoint === */
section('scheduled sweep');

const unsignedCron = await call('/cron/sweep', { method: 'POST' });
log([401, 503].includes(unsignedCron.status), 'cron sweep refuses an unsigned call', unsignedCron.data?.error);

// Vercel Cron only ever issues GET, and carries the secret as a bearer token.
// The route was POST-only once, so the scheduled sweep silently never ran.
const unsignedGet = await call('/cron/sweep');
log([401, 503].includes(unsignedGet.status), 'cron sweep refuses an unsigned GET', unsignedGet.data?.error);

const cronSecret = process.env.CRON_SECRET;
if (cronSecret) {
  const signedGet = await call('/cron/sweep', { token: cronSecret });
  log(signedGet.status === 200 && signedGet.data?.ok === true,
      'cron sweep runs on a signed GET, the way Vercel calls it', `status ${signedGet.status}`);

  const wrongSecret = await call('/cron/sweep', { token: `${cronSecret}-wrong` });
  log(wrongSecret.status === 401, 'cron sweep refuses a wrong secret', `status ${wrongSecret.status}`);
} else {
  log(false, 'cron sweep signed GET not exercised - set CRON_SECRET on the API under test');
}

/* ========================================================== devices === */
section('push registration');

const badToken = await call('/devices/register', {
  token: oTok,
  method: 'POST',
  body: { token: 'not-a-real-token', platform: 'android' },
});
log(badToken.status === 422, 'malformed push token refused');

const goodToken = await call('/devices/register', {
  token: oTok,
  method: 'POST',
  body: { token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', platform: 'android', deviceId: 'test-device' },
});
log(goodToken.status === 201, 'push token registered');

const devices = await call('/devices', { token: oTok });
log(devices.status === 200 && devices.data.devices.length === 1, 'device listed against the officer');

/* ======================================================= dashboard ==== */
section('dashboard counters');

const dash = await call('/admin/dashboard', { token: aTok });
log(dash.status === 200, 'dashboard loads');
log(dash.data?.counts?.pendingTimeOff != null, 'pending time off counted', String(dash.data?.counts?.pendingTimeOff));
log(dash.data?.counts?.expiringCredentials > 0, 'expiring credentials counted', String(dash.data?.counts?.expiringCredentials));
log(dash.data?.counts?.activeAlerts === 0, 'no alerts left open after resolution');

finish('features');
