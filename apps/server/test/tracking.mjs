/**
 * Live GPS tracking, the punch log, pay rates, the report centre and copying a
 * week's roster.
 *
 * Adversarial where money or location is concerned: overtime is recomputed
 * here from the raw time entries rather than trusted from the report, a ping
 * sent while off duty is checked to have left no trace, and a walk-off is
 * checked to raise exactly one flag however long the officer stays out.
 */

import { BASE, call, log, section, signIn, finish } from './harness.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// verify.mjs runs the API with a two-second thinning gap.
const GAP_MS = 2300;

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const mondayOf = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
/** A point `m` metres north of (lat, lng). */
const north = (lat, lng, m) => [lat + m / 111320, lng];

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const officer = await signIn('1003', '4812');
const alexis = await signIn('1042', '8598'); // a floater with nothing rostered
const kevinCode = '1007';

log(Boolean(admin && supervisor && officer && alexis), 'signed in as admin, supervisor and two officers');

const ref = await call('/reference', { token: alexis });
const post = ref.data.posts.find((p) => p.post_code === 'CP-01');
log(Boolean(post?.latitude), 'the Capital Plaza lobby post exists with a geofence', post ? `${post.geofence_radius_m} m` : '');

/* ============================================================ pinging === */
section('location reports');

const offDuty = await call('/timeclock/location', {
  token: alexis,
  method: 'POST',
  body: { latitude: post.latitude, longitude: post.longitude, accuracy: 8 },
});
log(offDuty.status === 200 && offDuty.data.onDuty === false && offDuty.data.recorded === false,
  'off duty, a position is compared but not recorded');

const badFix = await call('/timeclock/location', {
  token: alexis,
  method: 'POST',
  body: { latitude: 200, longitude: 0 },
});
log(badFix.status === 422, 'an impossible latitude is refused');

const clockIn = await call('/timeclock/clock-in', {
  token: alexis,
  method: 'POST',
  body: { postId: post.id, latitude: post.latitude + 0.0001, longitude: post.longitude, accuracy: 6, method: 'gps' },
});
log(clockIn.status === 201 && clockIn.data.geofence.status === 'inside', 'clock-in inside the fence', clockIn.data?.error || '');

const tooSoon = await call('/timeclock/location', {
  token: alexis,
  method: 'POST',
  body: { latitude: post.latitude, longitude: post.longitude, accuracy: 6 },
});
log(tooSoon.status === 200 && tooSoon.data.onDuty === true && tooSoon.data.recorded === false,
  'a report straight after the clock-in is thinned, not stored');
log(tooSoon.data.target?.post_id === post.id && tooSoon.data.target.kind === 'current',
  'and names the post the officer is working');

await pause(GAP_MS);
const [outLat, outLng] = north(post.latitude, post.longitude, post.geofence_radius_m + 250);
const walkOff = await call('/timeclock/location', {
  token: alexis,
  method: 'POST',
  body: { latitude: outLat, longitude: outLng, accuracy: 7, speed: 1.4 },
});
log(walkOff.data?.recorded === true && walkOff.data.offset.status === 'outside',
  'walking out of the fence is recorded as outside', `${walkOff.data?.offset?.distance} m`);
log(walkOff.data?.offset?.heading === 'S', 'and says which way is back to post', walkOff.data?.offset?.heading);

await pause(GAP_MS);
const stillOut = await call('/timeclock/location', {
  token: alexis,
  method: 'POST',
  body: { latitude: outLat + 0.0005, longitude: outLng, accuracy: 7 },
});
log(stillOut.data?.recorded === true, 'staying out is recorded too');

const flags = await call('/admin/flags?type=off_post', { token: supervisor });
const mine = (flags.data?.flags || []).filter((f) => f.employee_code === '1042');
log(mine.length === 1, 'exactly one walk-off flag, however long they stay out', `${mine.length}`);

const trail = await call('/timeclock/location/trail', { token: alexis });
log(trail.status === 200 && trail.data.pings.length === 3,
  'the officer can see their own trail: clock-in and two reports', `${trail.data?.pings?.length}`);

/* ========================================================= live board === */
section('live board');

log((await call('/admin/live', { token: officer })).status === 403, 'an officer cannot see the live board');
const live = await call('/admin/live', { token: supervisor });
log(live.status === 200, 'a supervisor can');

const board = live.data;
const me = board.officers.find((o) => o.employee_code === '1042');
log(me?.status === 'off_post', 'the officer who walked off shows as off post', me?.status);
log(me?.location?.geofence === 'outside' && me.location.distance_m > post.geofence_radius_m,
  'with their actual position against the post', `${me?.location?.distance_m} m`);
log(Boolean(me?.job?.address && me.job.post_name === post.name), 'and the address they should be at', me?.job?.address);

const statusTotal = ['duress', 'off_post', 'no_show', 'late', 'on_break', 'on_post', 'upcoming', 'off_duty']
  .reduce((n, s) => n + board.counts[s], 0);
log(statusTotal === board.officers.length, 'status counts add up to the people listed', `${statusTotal}/${board.officers.length}`);
log(board.counts.on_duty === board.officers.filter((o) => o.entry).length, 'on-duty count matches open time entries');
log(board.counts.on_break >= 1, 'the seeded officer on a meal break is on the board');
// The demo has an officer whose phone stopped reporting, but nobody can have gone quiet for longer
// than they have been on duty: in the first minutes of a payroll week every shift is that young.
const quietLongEnough = board.officers.some((o) => o.entry && o.entry.minutes_on_post > board.rules.gpsStaleMinutes);
log(quietLongEnough ? board.counts.gps_stale >= 1 : board.counts.gps_stale === 0,
  'an officer whose phone went quiet is flagged as GPS stale', quietLongEnough ? `${board.counts.gps_stale}` : 'nobody on duty long enough yet');
log(board.counts.no_show + board.counts.late >= 2, 'officers who have not turned up are listed', `${board.counts.late} late, ${board.counts.no_show} no-show`);
log(board.counts.uncovered >= 1 && board.uncovered.length === board.counts.uncovered, 'a running shift with nobody on it is reported');

const payKeys = JSON.stringify(board).match(/"(pay_rate[^"]*|bill_rate[^"]*|salary[^"]*|tax_id[^"]*)"/g);
log(!payKeys, 'the live board carries no pay data', payKeys?.join(', ') || '');

const dash = await call('/admin/dashboard', { token: supervisor });
log(dash.data?.counts?.offPost >= 1 && dash.data.counts.lateOrOff === dash.data.counts.offPost + dash.data.counts.lateNow,
  'the dashboard counts off-post and not-clocked-in officers', `${dash.data?.counts?.offPost} off, ${dash.data?.counts?.lateNow} late`);

/* ============================================================== track === */
section('GPS track');

const track = await call(`/admin/live/track/${me.user_id}?date=${localDate()}`, { token: supervisor });
log(track.status === 200 && track.data.pings.length === 3 && track.data.entries.length === 1, "today's track has the shift and its three readings");
log(track.data.summary.off_post_events === 1, 'one walk-off in the summary');
log(track.data.summary.minutes_worked >= 0 && track.data.summary.max_distance_m > post.geofence_radius_m, 'the furthest point is outside the fence');
log((await call(`/admin/live/track/${me.user_id}?date=yesterdayish`, { token: supervisor })).status === 422, 'a nonsense date is refused');
log((await call('/admin/live/track/999999', { token: supervisor })).status === 404, 'an unknown person is not found');

/* ============================================================ punches === */
section('punch log');

const today = localDate();
const week = localDate(addDays(new Date(), -6));
log((await call(`/admin/punches?from=${today}&to=${today}`, { token: officer })).status === 403, 'an officer cannot read the punch log');

const punches = await call(`/admin/punches?from=${week}&to=${today}`, { token: supervisor });
log(punches.status === 200 && punches.data.total > 100, 'a week of punches across the company', `${punches.data?.total}`);
const counted = Object.values(punches.data.counts).reduce((a, b) => a + b, 0);
log(counted === punches.data.total, 'per-type counts add up to the total');
const sorted = punches.data.punches.every((p, i, a) => i === 0 || new Date(a[i - 1].at) >= new Date(p.at));
log(sorted, 'newest first');

const hers = await call(`/admin/punches?from=${today}&to=${today}&userId=${me.user_id}`, { token: supervisor });
const herIn = hers.data.punches.find((p) => p.type === 'clock_in');
log(hers.data.punches.every((p) => p.user_id === me.user_id), 'filtering by officer returns only theirs');
log(herIn?.geofence === 'inside' && herIn.latitude != null, 'her clock-in carries its position and verdict');

const onlyOuts = await call(`/admin/punches?from=${week}&to=${today}&type=clock_out`, { token: supervisor });
log(onlyOuts.data.punches.length > 0 && onlyOuts.data.punches.every((p) => p.type === 'clock_out'), 'filtering by punch type works');

const siteFilter = await call(`/admin/punches?from=${week}&to=${today}&siteId=${post.site_id}`, { token: supervisor });
log(siteFilter.data.punches.every((p) => p.site_id === post.site_id), 'filtering by site works');

log((await call(`/admin/punches?from=${week}&to=${today}&userId=abc`, { token: supervisor })).status === 422, 'a malformed officer filter is refused, not written into SQL');
log((await call(`/admin/punches?from=2025-01-01&to=${today}`, { token: supervisor })).status === 422, 'more than three months at once is refused');
log((await call(`/admin/punches?from=${today}&to=${week}`, { token: supervisor })).status === 422, 'a backwards range is refused');

const csvRes = await fetch(`${BASE}/admin/punches/export.csv?from=${today}&to=${today}`, {
  headers: { Authorization: `Bearer ${supervisor}` },
});
const csv = await csvRes.text();
const csvLines = csv.trim().split('\n');
const todayCount = (await call(`/admin/punches?from=${today}&to=${today}&limit=5000`, { token: supervisor })).data.total;
log(csvRes.status === 200 && csvLines[0].startsWith('When (UTC),Punch'), 'the CSV has a header row');
log(csvLines.length === todayCount + 1, 'and one line per punch', `${csvLines.length - 1} vs ${todayCount}`);
log(!/,'-\d/.test(csv), 'negative longitudes stay numbers - only text is guarded against spreadsheet formulas');

/* ============================================================ reports === */
section('reports');

log((await call('/admin/reports', { token: officer })).status === 403, 'an officer cannot open the report centre');
const catalogue = await call('/admin/reports', { token: supervisor });
log(catalogue.data?.reports?.length === 15, 'fifteen reports are offered');

const from = localDate(addDays(new Date(), -13));
const to = localDate();
for (const r of catalogue.data.reports) {
  const res = await call(`/admin/reports/${r.id}?from=${from}&to=${to}`, { token: supervisor });
  const ok =
    res.status === 200 &&
    Array.isArray(res.data.columns) &&
    Array.isArray(res.data.rows) &&
    res.data.rows.every((row) => res.data.columns.every((c) => c.key in row));
  log(ok, `${r.title} runs, and every row has every column`, `${res.data?.rows?.length} rows`);
}
log((await call('/admin/reports/nope', { token: supervisor })).status === 404, 'an unknown report is not found');
log((await call(`/admin/reports/payroll?employmentType=contractor`, { token: supervisor })).status === 422, 'an unknown classification is refused');
log((await call(`/admin/reports/payroll?from=${to}&to=${from}`, { token: supervisor })).status === 422, 'a backwards range is refused');

const byOfficer = (await call(`/admin/reports/hours-by-officer?from=${from}&to=${to}`, { token: supervisor })).data;
const hourSum = byOfficer.rows.reduce((n, r) => n + r.hours, 0);
log(Math.abs(hourSum - byOfficer.totals.hours) < 0.1, 'report totals are the sum of the rows', `${hourSum.toFixed(2)} vs ${byOfficer.totals.hours}`);

const contractors = byOfficer.rows.filter((r) => r.classification === '1099');
log(contractors.length > 0 && contractors.every((r) => r.overtime_hours === 0), '1099 contractors never show overtime');

// Recompute one W-2 officer's pay from raw time entries, week by week: the
// hourly officer with the most overtime in the period whose rate has not
// changed during it, so one rate prices every punch.
const rates = (await call('/admin/pay-rates', { token: supervisor })).data.people;
const steadyRate = (r) => {
  const p = rates.find((x) => x.employee_code === r.employee_code);
  return p && p.pay_type === 'hourly' && !p.exempt && (!p.last_change || p.last_change.effective_on < from);
};
const janelle = byOfficer.rows.filter((r) => r.classification === 'W-2' && r.overtime_hours > 0 && steadyRate(r))
  .sort((a, b) => b.overtime_hours - a.overtime_hours)[0];
log(Boolean(janelle), 'a W-2 officer worked overtime in the period', janelle && `${janelle.employee_code}, ${janelle.overtime_hours} h`);
const janelleRate = rates.find((p) => p.employee_code === janelle.employee_code);
const fromDate = new Date(`${from}T00:00:00`);
const toDate = addDays(new Date(`${to}T00:00:00`), 1);
const raw = await call(
  `/admin/time-entries?userId=${janelle.user_id}&from=${fromDate.toISOString()}&to=${new Date(toDate - 1).toISOString()}`,
  { token: supervisor }
);
const weeks = new Map();
for (const e of raw.data.entries) {
  if (!e.clock_out_at) continue;
  const key = mondayOf(new Date(e.clock_in_at)).getTime();
  weeks.set(key, (weeks.get(key) || 0) + e.minutes_worked - (e.unpaid_break_minutes || 0));
}
let expectedCents = 0;
let expectedOt = 0;
for (const minutes of weeks.values()) {
  const regular = Math.min(minutes, 2400);
  const ot = Math.max(0, minutes - 2400);
  expectedOt += ot;
  expectedCents += Math.round((regular / 60) * janelleRate.pay_rate * 100 + (ot / 60) * janelleRate.pay_rate * 100 * janelleRate.overtime_multiplier);
}
log(expectedOt > 0, 'the W-2 officer checked worked overtime in the period', `${(expectedOt / 60).toFixed(2)} h`);
log(Math.abs(Math.round(janelle.gross_pay * 100) - expectedCents) <= 2,
  'their gross pay matches a week-by-week recalculation from the raw punches',
  `${janelle.gross_pay} vs ${(expectedCents / 100).toFixed(2)}`);
log(Math.abs(janelle.overtime_hours - Math.round((expectedOt / 60) * 100) / 100) < 0.02, 'and so do their overtime hours');

const payroll = (await call(`/admin/reports/payroll?from=${from}&to=${to}`, { token: supervisor })).data;
const payrollGross = payroll.rows.reduce((n, r) => n + (r.gross_pay || 0), 0);
const officerGross = byOfficer.rows.reduce((n, r) => n + (r.gross_pay || 0), 0);
log(Math.abs(payrollGross - officerGross) < 1, 'the payroll register and the officer report agree on gross pay', `${payrollGross.toFixed(2)} vs ${officerGross.toFixed(2)}`);
log(payroll.rows.filter((r) => r.classification === '1099').every((r) => r.w9 && r.tax_id), '1099 lines carry the W-9 status and masked TIN');
log(!JSON.stringify(payroll).match(/\d{3}-\d{2}-\d{4}/), 'no full tax number anywhere in the register');

const only1099 = (await call(`/admin/reports/payroll?from=${from}&to=${to}&employmentType=1099`, { token: supervisor })).data;
log(only1099.rows.length > 0 && only1099.rows.every((r) => r.classification === '1099'), 'the classification filter holds');

const oneSite = (await call(`/admin/reports/hours-by-site?from=${from}&to=${to}&siteId=${post.site_id}`, { token: supervisor })).data;
log(oneSite.rows.length > 0 && oneSite.rows.every((r) => r.site_id === post.site_id), 'the site filter holds');
const siteMargin = oneSite.rows.reduce((n, r) => n + r.billed - r.labor_cost, 0);
log(Math.abs(siteMargin - oneSite.totals.margin) < 0.05, 'site margin is billed less labor, row by row');

const where = (await call(`/admin/reports/officer-site?from=${from}&to=${to}&userId=${janelle.user_id}`, { token: supervisor })).data;
log(where.rows.length > 0 && where.rows.every((r) => r.user_id === janelle.user_id), 'where-officers-worked narrows to one officer');

const daily = (await call(`/admin/reports/daily?from=${from}&to=${to}`, { token: supervisor })).data;
log(daily.rows.length === 14, 'the daily report has one row per day, worked or not', `${daily.rows.length}`);

const attendance = (await call(`/admin/reports/attendance?from=${from}&to=${to}`, { token: supervisor })).data;
log(attendance.totals.no_shows >= 1 && attendance.totals.late >= 1, 'attendance sees the no-shows and late arrivals');

const gps = (await call(`/admin/reports/gps?from=${from}&to=${to}`, { token: supervisor })).data;
log(gps.totals.pings > 1000 && gps.totals.off_post_events >= 1, 'the GPS report sees the trails and the walk-offs', `${gps.totals.pings} points`);

const reportCsv = await fetch(`${BASE}/admin/reports/hours-by-officer/export.csv?from=${from}&to=${to}`, {
  headers: { Authorization: `Bearer ${supervisor}` },
});
const reportLines = (await reportCsv.text()).trim().split('\n');
log(reportLines[0].split(',').length === byOfficer.columns.length && reportLines.at(-1).startsWith('TOTAL'),
  'report CSV has the same columns as the screen and a total line');
log(reportLines.length === byOfficer.rows.length + 2, 'and one line per row', `${reportLines.length - 2}`);

/* ========================================================== pay rates === */
section('pay rates');

log((await call('/admin/pay-rates', { token: officer })).status === 403, 'an officer cannot see pay rates');
const list = await call('/admin/pay-rates', { token: supervisor });
log(list.status === 200 && list.data.people.length >= 40, 'a supervisor can see every rate', `${list.data?.people?.length}`);
log(list.data.summary.w2.people > 0 && list.data.summary.contractor.people > 0, 'summarised by W-2 and 1099');

const marcus = list.data.people.find((p) => p.employee_code === '1003');
log((await call(`/admin/pay-rates/${marcus.id}`, { token: supervisor, method: 'PATCH', body: { payRate: 30, reason: 'Nice try' } })).status === 403,
  'a supervisor cannot change a rate');
log((await call(`/admin/pay-rates/${marcus.id}`, { token: admin, method: 'PATCH', body: { payRate: 23 } })).status === 422,
  'a change needs a reason');

const before = (await call(`/admin/pay-rates/${marcus.id}/history`, { token: admin })).data.history.length;
const raise = await call(`/admin/pay-rates/${marcus.id}`, {
  token: admin,
  method: 'PATCH',
  body: { payRate: 23.25, billRate: 36, effectiveOn: '2026-10-05', reason: 'Promoted to lead officer' },
});
log(raise.status === 200 && raise.data.changed, 'an administrator changes a rate with a reason and effective date');
const after = (await call(`/admin/pay-rates/${marcus.id}/history`, { token: admin })).data.history;
log(after.length === before + 1 && after[0].reason === 'Promoted to lead officer' && after[0].effective_on === '2026-10-05',
  'the change is on the history with its reason and date');
const marcusNow = (await call(`/admin/employees/${marcus.id}`, { token: admin })).data.employee;
log(marcusNow.pay_rate_cents === 2325 && marcusNow.bill_rate_cents === 3600, 'and on the employee record the timesheet reads');

const same = await call(`/admin/pay-rates/${marcus.id}`, {
  token: admin, method: 'PATCH', body: { payRate: 23.25, reason: 'Saved twice' },
});
log(same.data?.changed === false, 'saving the same rate again does not add a history line');

const kevin = list.data.people.find((p) => p.employee_code === kevinCode);
const noW9 = await call(`/admin/pay-rates/${kevin.id}`, {
  token: admin, method: 'PATCH', body: { employmentType: '1099', reason: 'Wants to go contractor' },
});
log(noW9.status === 422, 'an active officer cannot be moved to 1099 without a W-9', noW9.data?.error);

const salaryless = await call(`/admin/pay-rates/${kevin.id}`, {
  token: admin, method: 'PATCH', body: { payType: 'salary', reason: 'Testing' },
});
log(salaryless.status === 422, 'salaried with no salary is refused');

const viaEmployee = await call(`/admin/employees/${kevin.id}`, { token: admin, method: 'PATCH', body: { billRate: 31.5 } });
const kevinHistory = (await call(`/admin/pay-rates/${kevin.id}/history`, { token: admin })).data.history;
log(viaEmployee.status === 200 && kevinHistory[0].bill_rate === 31.5, 'a rate changed on the employee record lands in the history too');

const w2Hourly = list.data.people.filter((p) => p.employment_type === 'w2' && p.pay_type === 'hourly' && p.status !== 'suspended' && p.pay_rate != null);
const preview = await call('/admin/pay-rates/bulk', {
  token: admin, method: 'POST',
  body: { employmentType: 'w2', mode: 'percent', value: 3, reason: 'Cost of living', dryRun: true },
});
const unchanged = (await call('/admin/pay-rates', { token: admin })).data.people.find((p) => p.id === marcus.id);
log(preview.data?.applied === false && preview.data.count === w2Hourly.length && unchanged.pay_rate === 23.25,
  'a bulk preview lists everyone it would touch and changes nothing', `${preview.data?.count}`);
const previewMarcus = preview.data.changes.find((c) => c.id === marcus.id);
log(previewMarcus?.to === Math.round(2325 * 1.03) / 100, 'a 3% raise is worked out in whole cents', `${previewMarcus?.to}`);

log((await call('/admin/pay-rates/bulk', { token: supervisor, method: 'POST', body: { employmentType: 'w2', mode: 'percent', value: 3, reason: 'x y z' } })).status === 403,
  'a supervisor cannot apply a bulk change');
const armedRaise = await call('/admin/pay-rates/bulk', {
  token: admin, method: 'POST',
  body: { employmentType: '1099', armed: 'armed', mode: 'amount', value: 1, reason: 'Armed contract uplift' },
});
const armed1099 = list.data.people.filter((p) => p.employment_type === '1099' && p.armed && p.pay_rate != null && p.pay_type !== 'salary');
const afterBulk = (await call('/admin/pay-rates', { token: admin })).data.people;
log(armedRaise.data?.applied && armedRaise.data.count === armed1099.length &&
  armed1099.every((p) => Math.abs(afterBulk.find((x) => x.id === p.id).pay_rate - (p.pay_rate + 1)) < 0.001),
  'a bulk $1 uplift reaches exactly the armed contractors', `${armedRaise.data?.count}`);
log(afterBulk.filter((p) => p.employment_type === 'w2').every((p) => {
  const was = list.data.people.find((x) => x.id === p.id);
  return p.id === marcus.id || p.id === kevin.id || p.pay_rate === was.pay_rate;
}), 'and nobody else');

// A raise dated in the future must not reprice hours already worked; one
// dated in the past reprices only the hours after it.
const andreRow = (await call(`/admin/reports/hours-by-officer?from=${from}&to=${to}`, { token: admin })).data.rows
  .find((r) => r.employee_code === '1011');
const andre = afterBulk.find((p) => p.employee_code === '1011');
await call(`/admin/pay-rates/${andre.id}`, {
  token: admin, method: 'PATCH',
  body: { payRate: andre.pay_rate + 5, effectiveOn: localDate(addDays(new Date(), 1)), reason: 'Raise from tomorrow' },
});
const andreFuture = (await call(`/admin/reports/hours-by-officer?from=${from}&to=${to}`, { token: admin })).data.rows
  .find((r) => r.employee_code === '1011');
log(andreFuture.gross_pay === andreRow.gross_pay, 'a raise dated tomorrow leaves past pay exactly as it was', `${andreRow.gross_pay}`);
await call(`/admin/pay-rates/${andre.id}`, {
  token: admin, method: 'PATCH',
  body: { payRate: andre.pay_rate + 6, effectiveOn: localDate(addDays(new Date(`${from}T00:00:00`), 7)), reason: 'Back-dated correction' },
});
const andreBack = (await call(`/admin/reports/hours-by-officer?from=${from}&to=${to}`, { token: admin })).data.rows
  .find((r) => r.employee_code === '1011');
log(andreBack.gross_pay > andreRow.gross_pay && andreBack.gross_pay < andreRow.gross_pay + andreRow.hours * 6,
  'a back-dated one reprices the hours after its date and no others', `${andreRow.gross_pay} -> ${andreBack.gross_pay}`);

// Timesheets, reports and invoice cost share one pricing, so after that
// back-dated raise all three must still agree to the cent.
const sheetFrom = new Date(`${from}T00:00:00`).toISOString();
const sheetTo = addDays(new Date(`${to}T00:00:00`), 1).toISOString();
const sheets = (await call(`/admin/timesheets?from=${sheetFrom}&to=${sheetTo}`, { token: admin })).data.rows;
const reportRows = (await call(`/admin/reports/hours-by-officer?from=${from}&to=${to}`, { token: admin })).data.rows;
const disagreements = reportRows.filter((r) => {
  const sheet = sheets.find((x) => x.user_id === r.user_id);
  return !sheet || Math.abs((sheet.estimated_pay ?? 0) - (r.gross_pay ?? 0)) > 0.01 ||
    Math.abs(sheet.overtime_hours - r.overtime_hours) > 0.01 || Math.abs((sheet.estimated_bill ?? 0) - (r.billed ?? 0)) > 0.01;
});
log(reportRows.length > 30 && disagreements.length === 0,
  'Timesheets and the reports agree on pay, overtime and billing for every officer',
  disagreements.map((r) => r.officer).join(', '));
const andreSheet = sheets.find((x) => x.user_id === andreBack.user_id);
log(andreSheet?.estimated_pay === andreBack.gross_pay, 'including the officer whose raise was back-dated', `${andreSheet?.estimated_pay}`);

const harborview = ref.data.posts.find((p) => p.post_code === 'HV-01').site_id;
const invoicePreview = (await call(`/invoices/preview?siteId=${harborview}&periodStart=${from}&periodEnd=${to}`, { token: admin })).data;
const siteReport = (await call(`/admin/reports/hours-by-site?from=${from}&to=${to}&siteId=${harborview}`, { token: admin })).data;
const invoiceCost = invoicePreview.lines.reduce((n, l) => n + l.cost_cents, 0);
log(Math.abs(invoiceCost - Math.round(siteReport.totals.labor_cost * 100)) <= 1,
  'invoice cost for a site matches the report\'s labor cost, back-dated raise included',
  `${(invoiceCost / 100).toFixed(2)} vs ${siteReport.totals.labor_cost}`);

/* ====================================================== differentials === */
section('what a post pays over the officer rate');

const diffs = await call('/admin/pay-rates/posts/differentials', { token: admin });
log(diffs.status === 200 && diffs.data.differentials.length > 0,
  'armed posts carry a differential', `${diffs.data?.differentials?.length} posts`);
log(diffs.data.differentials.every((d) => d.user_id == null),
  'seeded against the post rather than a person, so it survives a roster change');

const armedDiff = diffs.data.differentials[0];
const armedPostId = armedDiff.post_id;

// The differential must beat the officer's own rate, and only at this post.
const anyone = list.data.people.find(
  (p) => p.pay_type === 'hourly' && p.pay_rate != null && p.status === 'active'
);
log(armedDiff.pay_rate > anyone.pay_rate,
  'and it pays more than a standing officer rate',
  `$${armedDiff.pay_rate} vs $${anyone.pay_rate}`);

// An officer-specific differential is more specific and must win over the
// one the post pays everybody.
const specific = await call('/admin/pay-rates/posts/differentials', {
  token: admin,
  method: 'POST',
  body: {
    postId: armedPostId,
    userId: anyone.id,
    payRate: armedDiff.pay_rate + 5,
    // Tomorrow, not a back-date: a differential inside a closed pay period is
    // refused, because it would restate what that period paid. The payroll
    // suite covers that refusal; this one is about precedence.
    effectiveOn: new Date(Date.now() + 86400000).toLocaleDateString('en-CA'),
    reason: 'Negotiated above the post rate',
  },
});
log(specific.status === 201, 'an officer can be given their own rate at one post');

const withSpecific = await call('/admin/pay-rates/posts/differentials', { token: admin });
const myDifferential = withSpecific.data.differentials.find(
  (d) => d.post_id === armedPostId && d.user_id === anyone.id
);
log(Boolean(myDifferential) && myDifferential.officer, 'and it is listed against their name', myDifferential?.officer);

log((await call('/admin/pay-rates/posts/differentials', {
  token: supervisor, method: 'POST',
  body: { postId: armedPostId, payRate: 99, reason: 'Nice try from a supervisor' },
})).status === 403, 'a supervisor cannot set one');

log((await call('/admin/pay-rates/posts/differentials', {
  token: admin, method: 'POST', body: { postId: armedPostId, payRate: 50, reason: 'no' },
})).status === 422, 'and a reason has to say something');

log((await call('/admin/pay-rates/posts/differentials', {
  token: admin, method: 'POST',
  body: { postId: 999999, payRate: 50, reason: 'A post that does not exist' },
})).status === 404, 'a differential cannot be hung on a post that does not exist');

const removed = await call(`/admin/pay-rates/posts/differentials/${myDifferential.id}`, {
  token: admin, method: 'DELETE',
});
log(removed.status === 200, 'and one entered by mistake can be withdrawn');
log(!(await call('/admin/pay-rates/posts/differentials', { token: admin })).data.differentials
  .some((d) => d.id === myDifferential.id), 'after which it is gone');

/* ========================================================= candidates === */
section('who can cover a shift');

const armedPost = ref.data.posts.find((p) => p.post_code === 'PD-02');
const candStart = addDays(new Date(), 3);
candStart.setHours(20, 0, 0, 0);
const candEnd = new Date(candStart.getTime() + 8 * 3600000);
const candQs = `postId=${armedPost.id}&startsAt=${candStart.toISOString()}&endsAt=${candEnd.toISOString()}`;
log((await call(`/admin/shifts/candidates?${candQs}`, { token: officer })).status === 403, 'an officer cannot see who could cover a shift');
const cand = await call(`/admin/shifts/candidates?${candQs}`, { token: supervisor });
log(cand.status === 200 && cand.data.candidates.length >= 40, 'every active officer is judged', `${cand.data?.candidates?.length}`);
const eligibleArmed = cand.data.candidates.filter((c) => c.eligible);
log(eligibleArmed.length > 0 && eligibleArmed.every((c) => /class g/i.test(c.license_type || '')),
  'for an armed post, only Class G holders are eligible', eligibleArmed.map((c) => c.name).join(', '));
log(cand.data.candidates.filter((c) => !/class g/i.test(c.license_type || '')).every((c) => c.reasons.some((r) => r.code === 'no_armed_licence')),
  'and everyone else is told why not');
const firstBlocked = cand.data.candidates.findIndex((c) => !c.eligible);
log(firstBlocked === -1 || cand.data.candidates.slice(firstBlocked).every((c) => !c.eligible), 'eligible officers are listed first');
log(cand.data.candidates.every((c) => Math.abs(c.week_hours_after - c.week_hours_before - 8) < 0.02), "each projection adds the shift's eight hours");
const otCases = cand.data.candidates.filter((c) => c.employment_type === 'w2' && c.week_hours_after > 40);
log(otCases.every((c) => Math.abs(c.overtime_hours - Math.min(8, c.week_hours_after - Math.max(40, c.week_hours_before))) < 0.02),
  'overtime is projected only for the hours past forty', `${otCases.length} W-2 officers would go over`);
log(cand.data.candidates.filter((c) => c.employment_type === '1099').every((c) => c.overtime_hours === 0), 'contractors are never projected overtime');
log((await call(`/admin/shifts/candidates?postId=${armedPost.id}&startsAt=${candEnd.toISOString()}&endsAt=${candStart.toISOString()}`, { token: supervisor })).status === 422,
  'a shift that ends before it starts is refused');

/* ================================================ assignment is gated === */
section('assigning a shift someone cannot work');

const staffList = (await call('/admin/employees', { token: admin })).data.employees;
const classD = staffList.find((e) => e.employee_code === '1042'); // Alexis: Class D, nothing rostered
const armedStart = addDays(new Date(), 50);
armedStart.setHours(20, 0, 0, 0);
const armedBody = {
  userId: classD.id,
  postId: armedPost.id,
  startsAt: armedStart.toISOString(),
  endsAt: new Date(armedStart.getTime() + 8 * 3600000).toISOString(),
};
const refused = await call('/admin/shifts', { token: supervisor, method: 'POST', body: armedBody });
log(refused.status === 409 && refused.data.details?.code === 'ineligible' &&
  refused.data.details.reasons.some((r) => r.code === 'no_armed_licence'),
  'a Class D officer cannot be put on an armed post directly either', refused.data?.error);
const noReason = await call('/admin/shifts', { token: supervisor, method: 'POST', body: { ...armedBody, override: true } });
log(noReason.status === 422, 'overriding needs a written reason');
const overridden = await call('/admin/shifts', {
  token: supervisor, method: 'POST',
  body: { ...armedBody, override: true, overrideReason: 'Class G issued yesterday, card in the post' },
});
log(overridden.status === 201, 'with a reason, a supervisor can assign anyway');
const overrideAudit = (await call('/admin/audit?action=shift.eligibility_overridden', { token: admin })).data.entries;
log(overrideAudit.some((a) => String(a.detail).includes('no_armed_licence') && String(a.detail).includes('Class G issued yesterday')),
  'and the override, the problem and the reason are on the audit log');

const noteOnly = await call(`/admin/shifts/${overridden.data.shift.id}`, {
  token: supervisor, method: 'PATCH', body: { notes: 'Bring the range card.' },
});
log(noteOnly.status === 200, 'editing the notes on that shift is not re-judged');
const movedLater = await call(`/admin/shifts/${overridden.data.shift.id}`, {
  token: supervisor, method: 'PATCH',
  body: { startsAt: new Date(armedStart.getTime() + 3600000).toISOString(), endsAt: new Date(armedStart.getTime() + 9 * 3600000).toISOString() },
});
log(movedLater.status === 409 && movedLater.data.details?.code === 'ineligible', 'moving it is a new assignment and is judged again');
await call(`/admin/shifts/${overridden.data.shift.id}`, { token: admin, method: 'DELETE' });

// Andre has approved leave from day 30 to 36.
const andreId = staffList.find((e) => e.employee_code === '1011').id;
const leaveDay = addDays(new Date(), 32);
leaveDay.setHours(9, 0, 0, 0);
const onLeave = await call('/admin/shifts', {
  token: supervisor, method: 'POST',
  body: { userId: andreId, postId: post.id, startsAt: leaveDay.toISOString(), endsAt: new Date(leaveDay.getTime() + 8 * 3600000).toISOString() },
});
log(onLeave.status === 409 && onLeave.data.details?.reasons?.some((r) => r.code === 'time_off'), 'an officer on approved leave cannot be rostered that day', onLeave.data?.error);

const bulkArmed = await call('/admin/shifts/bulk', {
  token: supervisor, method: 'POST',
  body: {
    userId: classD.id, postId: armedPost.id,
    startDate: localDate(addDays(new Date(), 60)), endDate: localDate(addDays(new Date(), 66)),
    startTime: '20:00', endTime: '04:00', weekdays: [0, 1, 2, 3, 4, 5, 6],
  },
});
log(bulkArmed.status === 201 && bulkArmed.data.created === 0 && bulkArmed.data.skipped.length === 7 &&
  bulkArmed.data.skipped.every((x) => /Class G/.test(x.reason)),
  'a recurring roster skips every day the officer cannot work, and says why');

/* =========================================================== schedule === */
section('copying a week');

const nextWeek = mondayOf(addDays(new Date(), 7));
const farWeek = addDays(nextWeek, 28);
log((await call('/admin/shifts/copy-week', { token: officer, method: 'POST', body: { fromWeekStart: localDate(nextWeek), toWeekStart: localDate(farWeek) } })).status === 403,
  'an officer cannot copy a roster');
const sameWeek = await call('/admin/shifts/copy-week', { token: supervisor, method: 'POST', body: { fromWeekStart: localDate(nextWeek), toWeekStart: localDate(nextWeek) } });
log(sameWeek.status === 422, 'copying a week onto itself is refused');

const sourceShifts = (await call(`/admin/shifts?from=${nextWeek.toISOString()}&to=${addDays(nextWeek, 7).toISOString()}`, { token: supervisor })).data.shifts
  // The list endpoint is inclusive at both ends; a week is not.
  .filter((s) => s.status !== 'cancelled' && new Date(s.starts_at) < addDays(nextWeek, 7));
const copy = await call('/admin/shifts/copy-week', {
  token: supervisor, method: 'POST',
  body: { fromWeekStart: localDate(nextWeek), toWeekStart: localDate(farWeek), keepOfficers: true },
});
log(copy.status === 201 && copy.data.created === sourceShifts.length, 'every shift in the week is copied', `${copy.data?.created} of ${sourceShifts.length}`);
const landed = (await call(`/admin/shifts?from=${farWeek.toISOString()}&to=${addDays(farWeek, 7).toISOString()}`, { token: supervisor })).data.shifts;
const sample = sourceShifts.find((s) => s.user_id);
const twin = landed.find((s) => s.post_id === sample.post_id && s.user_id === sample.user_id &&
  new Date(s.starts_at).getHours() === new Date(sample.starts_at).getHours() &&
  new Date(s.starts_at).getDay() === new Date(sample.starts_at).getDay());
log(Boolean(twin), 'a copied shift keeps its post, officer, weekday and start time');

const again = await call('/admin/shifts/copy-week', {
  token: supervisor, method: 'POST',
  body: { fromWeekStart: localDate(nextWeek), toWeekStart: localDate(farWeek) },
});
log(again.data?.created === 0 && again.data.skipped.length === sourceShifts.length, 'copying again adds nothing: the posts are already covered');

/* ========================================================== retention === */
section('retention & clock-out');

const sweep = await call('/cron/sweep', { method: 'GET' });
const signed = await fetch(`${BASE}/cron/sweep`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET || ''}` } });
const swept = await signed.json().catch(() => ({}));
log(sweep.status === 401 && (!process.env.CRON_SECRET || typeof swept.locationPingsPruned === 'number'),
  'the sweep reports location history pruned past the retention window', `${swept.locationPingsPruned ?? 'n/a'}`);

const clockOut = await call('/timeclock/clock-out', {
  token: alexis, method: 'POST', body: { latitude: post.latitude, longitude: post.longitude, accuracy: 6 },
});
log(clockOut.status === 200, 'the officer clocks out');
const afterOut = await call('/timeclock/location', {
  token: alexis, method: 'POST', body: { latitude: post.latitude, longitude: post.longitude, accuracy: 6 },
});
const trackAfter = await call(`/admin/live/track/${me.user_id}?date=${localDate()}`, { token: supervisor });
log(afterOut.data?.onDuty === false && afterOut.data.recorded === false && trackAfter.data.pings.length === 4,
  'after clock-out only the clock-out itself was added - nothing more is stored', `${trackAfter.data?.pings?.length} readings`);
const offPostAfter = (await call('/admin/flags?type=off_post', { token: supervisor })).data.flags.filter((f) => f.employee_code === '1042');
log(offPostAfter.length === 1, 'clocking out from inside the fence raises no new walk-off');

finish('tracking');
