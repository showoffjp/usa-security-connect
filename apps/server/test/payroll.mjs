/**
 * Payroll close: pay periods, per-officer approval, closing and the locks
 * that come with it.
 *
 * Adversarial where it matters: overtime is checked against the raw hours
 * rather than the service's own arithmetic, pay is cross-checked against the
 * report centre to the cent, and every way of changing a closed period's pay -
 * correcting a punch, back-dating a rate - is tried and must be refused.
 */

import { BASE, call, log, section, signIn, finish } from './harness.mjs';

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const monday = (() => {
  const x = new Date();
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
})();
const cents = (n) => Math.round((n || 0) * 100);

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const officer = await signIn('1003', '4812');
log(Boolean(admin && supervisor && officer), 'signed in as admin, supervisor and officer');

/* ============================================================== access === */
section('who can see and run payroll');

log((await call('/admin/payroll/periods', { token: officer })).status === 403, 'an officer cannot see payroll');
const list = await call('/admin/payroll/periods', { token: supervisor });
log(list.status === 200 && list.data.periods.length >= 2, 'a supervisor can read the pay periods', `${list.data?.periods?.length}`);

const closedStart = localDate(addDays(monday, -14));
const dueStart = localDate(addDays(monday, -7));
const dueEnd = localDate(addDays(monday, -1));
const seededClosed = list.data.periods.find((p) => p.period_start === closedStart);
const due = list.data.periods.find((p) => p.period_start === dueStart);
log(seededClosed?.status === 'closed' && seededClosed.totals.people > 0, 'the week before last is closed, with people paid in it', `${seededClosed?.totals?.people}`);
log(due?.status === 'open' && due.period_end === dueEnd, 'last week is open and ended');
log(list.data.suggestion?.periodStart === localDate(monday) && list.data.suggestion.days === 7,
  'the next period suggested is this week, the same length as the last', JSON.stringify(list.data.suggestion));

log((await call(`/admin/payroll/periods/${due.id}/approve`, { token: supervisor, method: 'POST', body: {} })).status === 403,
  'a supervisor cannot approve pay');
log((await call(`/admin/payroll/periods/${due.id}/close`, { token: supervisor, method: 'POST' })).status === 403,
  'or close a period');
log((await call(`/admin/payroll/periods/${due.id}/register.csv`, { token: supervisor })).status === 403,
  'or export the payroll register');

const dash = await call('/admin/dashboard', { token: admin });
log(dash.data?.counts?.payrollDue === 1, 'the dashboard shows one pay period waiting to close', `${dash.data?.counts?.payrollDue}`);

/* ========================================================== validation === */
section('what a pay period can be');

const bad = async (periodStart, periodEnd) =>
  call('/admin/payroll/periods', { token: admin, method: 'POST', body: { periodStart, periodEnd } });
log((await bad(localDate(addDays(monday, 1)), localDate(addDays(monday, 7)))).status === 422,
  'a period that starts on a Tuesday is refused');
log((await bad(localDate(addDays(monday, -70)), localDate(addDays(monday, -64 - 1)))).status === 422,
  'one that ends on a Saturday is refused');
log((await bad(localDate(addDays(monday, -70)), localDate(addDays(monday, -36)))).status === 422,
  'five weeks is too long');
log((await bad('next week', 'soon')).status === 422, 'words are not dates');
const overlap = await bad(localDate(addDays(monday, -21)), localDate(addDays(monday, -8)));
log(overlap.status === 409 && overlap.data?.details?.code === 'overlap', 'a period overlapping one already open or closed is refused');

/* ============================================================== review === */
section('reviewing last week');

const review = await call(`/admin/payroll/periods/${due.id}`, { token: supervisor });
const lines = review.data.lines;
log(review.status === 200 && lines.length > 20, 'every officer who worked last week has a line', `${lines.length}`);

const addsUp = lines.every((l) => l.gross_cents === l.regular_pay_cents + l.overtime_pay_cents);
log(addsUp, 'regular pay and overtime pay add up to gross on every line');
log(cents(review.data.totals.gross_pay) === lines.reduce((n, l) => n + l.gross_cents, 0), 'and the lines add up to the total');

// One week, so overtime is simply everything past 40 hours - worked out here
// from the hours, not taken from the service.
const hourlyW2 = lines.filter((l) => l.employment_type === 'w2' && l.pay_type === 'hourly');
const otWrong = hourlyW2.filter((l) => Math.abs(l.overtime_minutes - Math.max(0, l.minutes - 2400)) > 0);
log(hourlyW2.length > 10 && otWrong.length === 0, 'hourly W-2 overtime is exactly the minutes past 40 hours',
  otWrong.map((l) => `${l.officer} ${l.hours}/${l.overtime_hours}`).join(', '));
log(lines.some((l) => l.overtime_minutes > 0), 'and someone did work overtime last week');
log(lines.filter((l) => l.employment_type === '1099').every((l) => l.overtime_minutes === 0 && l.overtime_pay_cents === 0),
  'contractors earn no overtime');

const report = await call(`/admin/reports/hours-by-officer?from=${dueStart}&to=${dueEnd}`, { token: admin });
const mismatch = lines.filter((l) => {
  const r = report.data.rows.find((x) => x.user_id === l.user_id);
  return !r || cents(r.gross_pay) !== l.gross_cents || Math.abs(r.overtime_hours - l.overtime_hours) > 0.001;
});
log(report.status === 200 && mismatch.length === 0, 'pay and overtime agree with the report centre to the cent',
  mismatch.map((l) => l.officer).join(', '));

const alicia = lines.find((l) => l.employee_code === '1006');
log(alicia?.approval.state === 'changed' && alicia.issues.some((i) => i.code === 'adjusted'),
  'an officer whose punch was corrected after approval reads as changed, with the correction called out');
log(alicia && alicia.approval.approved_gross < alicia.gross_pay, 'and shows what was approved against what is owed now',
  `${alicia?.approval.approved_gross} -> ${alicia?.gross_pay}`);
const pending = lines.filter((l) => l.approval.state === 'pending');
log(pending.length > 0 && review.data.blockers.some((b) => b.code === 'unapproved'), 'officers not yet approved block the close');

const early = await call(`/admin/payroll/periods/${due.id}/close`, { token: admin, method: 'POST' });
log(early.status === 409 && early.data?.details?.code === 'cannot_close', 'closing with officers unapproved is refused', early.data?.error);

/* ============================================================= approve === */
section('approving');

const one = await call(`/admin/payroll/periods/${due.id}/approve`, { token: admin, method: 'POST', body: { userIds: [alicia.user_id] } });
log(one.status === 200 && one.data.approved.length === 1, 'the changed officer is approved again at the new figure');
const afterOne = (await call(`/admin/payroll/periods/${due.id}`, { token: admin })).data.lines.find((l) => l.user_id === alicia.user_id);
log(afterOne.approval.state === 'approved' && afterOne.approval.approved_gross === afterOne.gross_pay, 'and now reads approved');

const unapprove = await call(`/admin/payroll/periods/${due.id}/approvals/${alicia.user_id}`, { token: admin, method: 'DELETE' });
log(unapprove.status === 200, 'an approval can be taken back while the period is open');
log((await call(`/admin/payroll/periods/${due.id}/approvals/${alicia.user_id}`, { token: admin, method: 'DELETE' })).status === 404,
  'but not twice');

// Everyone not approved right now: the pending, Alicia again, and anyone
// else whose seeded hours happen to have changed since their approval.
const waiting = (await call(`/admin/payroll/periods/${due.id}`, { token: admin })).data.lines.filter((l) => l.approval.state !== 'approved');
const all = await call(`/admin/payroll/periods/${due.id}/approve`, { token: admin, method: 'POST', body: {} });
log(all.status === 200 && waiting.length > pending.length && all.data.approved.length === waiting.length && all.data.skipped.length === 0,
  'approve-all approves everyone still waiting', `${all.data?.approved?.length} approved, ${all.data?.skipped?.length} skipped`);
const ready = (await call(`/admin/payroll/periods/${due.id}`, { token: admin })).data;
log(ready.totals.approved === ready.totals.people && ready.blockers.length === 0, 'with everyone approved, nothing stands in the way');

/* =============================================================== close === */
section('closing');

const closed = await call(`/admin/payroll/periods/${due.id}/close`, { token: admin, method: 'POST' });
log(closed.status === 200 && closed.data.period.status === 'closed' && closed.data.period.closed_by_name === 'Vince Ortega',
  'the period closes, recording who closed it', closed.data?.error);
log(cents(closed.data.totals?.gross_pay) === cents(ready.totals.gross_pay) && closed.data.totals.people === ready.totals.people,
  'with exactly the approved totals', `${closed.data.totals?.gross_pay}`);
const after = (await call(`/admin/payroll/periods/${due.id}`, { token: supervisor })).data;
log(after.lines.every((l) => l.approval.state === 'closed') && after.lines.length === ready.lines.length,
  'every line is frozen as closed');
log((await call('/admin/dashboard', { token: admin })).data.counts.payrollDue === 0, 'and the dashboard has nothing waiting');
log((await call(`/admin/payroll/periods/${due.id}/approve`, { token: admin, method: 'POST', body: {} })).status === 409,
  'approvals cannot change once closed');
log((await call(`/admin/payroll/periods/${due.id}`, { token: admin, method: 'DELETE' })).status === 409,
  'and a closed period cannot be deleted');

/* =============================================================== locks === */
section('a closed period cannot be changed by the back door');

const entries = (await call(
  `/admin/time-entries?userId=${alicia.user_id}&from=${new Date(`${dueStart}T00:00:00`).toISOString()}&to=${new Date(`${localDate(monday)}T00:00:00`).toISOString()}`,
  { token: admin }
)).data.entries.filter((e) => e.clock_out_at);
const entry = entries[0];
const outAt = new Date(entry.clock_out_at);
const punch = await call(`/admin/time-entries/${entry.id}`, {
  token: admin, method: 'PATCH',
  body: { clockOutAt: new Date(outAt.getTime() + 30 * 60000).toISOString(), reason: 'Late relief, extra half hour' },
});
log(punch.status === 409 && punch.data?.details?.code === 'period_closed', 'correcting a punch in a closed period is refused', punch.data?.error);

// A recent entry, after the closed weeks, to move back into them.
const recent = (await call(`/admin/time-entries?from=${new Date(`${localDate(monday)}T00:00:00`).toISOString()}`, { token: admin }))
  .data.entries.find((e) => e.clock_out_at);
if (recent) {
  const into = await call(`/admin/time-entries/${recent.id}`, {
    token: admin, method: 'PATCH',
    body: {
      clockInAt: new Date(`${dueStart}T09:00:00`).toISOString(),
      clockOutAt: new Date(`${dueStart}T17:00:00`).toISOString(),
      reason: 'Entered against the wrong week',
    },
  });
  log(into.status === 409, 'and so is moving an entry into one');
} else {
  log(true, 'no finished entry this week to try moving back (skipped)');
}

const rateBack = await call(`/admin/pay-rates/${alicia.user_id}`, {
  token: admin, method: 'PATCH',
  body: { payRate: 25, effectiveOn: dueStart, reason: 'Back-dated raise' },
});
log(rateBack.status === 409 && rateBack.data?.details?.code === 'period_closed', 'back-dating a pay rate into it is refused', rateBack.data?.error);
const rateBefore = await call(`/admin/pay-rates/${alicia.user_id}`, {
  token: admin, method: 'PATCH',
  body: { payRate: 25, effectiveOn: localDate(addDays(monday, -30)), reason: 'Back-dated further still' },
});
log(rateBefore.status === 409, 'as is one dated before it, which would reprice it just the same');
const bulkBack = await call('/admin/pay-rates/bulk', {
  token: admin, method: 'POST',
  body: { employmentType: 'w2', armed: 'all', mode: 'amount', value: 1, effectiveOn: dueStart, reason: 'Back-dated uplift', dryRun: true },
});
log(bulkBack.status === 409, 'a back-dated bulk raise is refused too, even as a preview');
const billOnly = await call(`/admin/pay-rates/${alicia.user_id}`, {
  token: admin, method: 'PATCH',
  body: { billRate: 40, effectiveOn: dueStart, reason: 'Client re-rate' },
});
log(billOnly.status === 200, 'a bill rate change, which does not touch pay, is not held back', billOnly.data?.error);
const tomorrow = await call(`/admin/pay-rates/${alicia.user_id}`, {
  token: admin, method: 'PATCH',
  body: { payRate: afterOne.gross_pay > 0 ? 21 : 20, effectiveOn: localDate(addDays(new Date(), 1)), reason: 'Raise from tomorrow' },
});
log(tomorrow.status === 200, 'a raise dated after the closed periods goes through', tomorrow.data?.error);
// A post differential is a rate change wearing a different hat: it decides what
// hours at that post cost, so back-dating one into a closed period would restate
// what was paid just as surely as raising the officer would.
const anyPost = (await call('/reference', { token: admin })).data.posts[0];
const diffBack = await call('/admin/pay-rates/posts/differentials', {
  token: admin, method: 'POST',
  body: { postId: anyPost.id, payRate: 44, effectiveOn: dueStart, reason: 'Back-dated post differential' },
});
log(diffBack.status === 409 && diffBack.data?.details?.code === 'period_closed',
  'back-dating a post differential into it is refused too', diffBack.data?.error);

const diffAhead = await call('/admin/pay-rates/posts/differentials', {
  token: admin, method: 'POST',
  body: {
    postId: anyPost.id, payRate: 44,
    effectiveOn: localDate(addDays(new Date(), 1)),
    reason: 'Differential from tomorrow',
  },
});
log(diffAhead.status === 201, 'while one dated after the closed periods goes through', diffAhead.data?.error);

const frozen = (await call(`/admin/payroll/periods/${due.id}`, { token: admin })).data;
log(cents(frozen.totals.gross_pay) === cents(ready.totals.gross_pay), 'and the closed period reads exactly as it did');

/* ============================================================== reopen === */
section('reopening');

log((await call(`/admin/payroll/periods/${due.id}/reopen`, { token: admin, method: 'POST', body: { reason: 'no' } })).status === 422,
  'reopening needs a real reason');
const reopened = await call(`/admin/payroll/periods/${due.id}/reopen`, {
  token: admin, method: 'POST', body: { reason: 'Alicia stayed late on relief - missed from the timesheet' },
});
log(reopened.status === 200 && reopened.data.period.status === 'open' && reopened.data.period.reopen_reason.startsWith('Alicia'),
  'a period reopens, with the reason on record');
const stillApproved = (await call(`/admin/payroll/periods/${due.id}`, { token: admin })).data;
log(stillApproved.totals.approved === stillApproved.totals.people, 'approvals survive a reopen while nothing has changed');

const fix = await call(`/admin/time-entries/${entry.id}`, {
  token: admin, method: 'PATCH',
  body: { clockOutAt: new Date(outAt.getTime() + 30 * 60000).toISOString(), reason: 'Late relief, extra half hour' },
});
log(fix.status === 200, 'once open, the punch can be corrected', fix.data?.error);
const redo = (await call(`/admin/payroll/periods/${due.id}`, { token: admin })).data;
const aliciaNow = redo.lines.find((l) => l.user_id === alicia.user_id);
log(aliciaNow.approval.state === 'changed' && redo.totals.changed === 1, 'which puts exactly that officer back to changed');
log(aliciaNow.minutes === afterOne.minutes + 30, 'with the extra half hour counted', `${afterOne.minutes} -> ${aliciaNow.minutes}`);
log((await call(`/admin/payroll/periods/${due.id}/close`, { token: admin, method: 'POST' })).status === 409,
  'and the period cannot close again until they are re-approved');
await call(`/admin/payroll/periods/${due.id}/approve`, { token: admin, method: 'POST', body: { userIds: [alicia.user_id] } });
const reclosed = await call(`/admin/payroll/periods/${due.id}/close`, { token: admin, method: 'POST' });
log(reclosed.status === 200 && cents(reclosed.data.totals.gross_pay) === cents(redo.totals.gross_pay),
  'after re-approval it closes at the corrected total', `${ready.totals.gross_pay} -> ${reclosed.data.totals?.gross_pay}`);

/* ========================================================= other weeks === */
section('this week, and an empty week');

const thisWeek = await call('/admin/payroll/periods', {
  token: admin, method: 'POST', body: { periodStart: localDate(monday), periodEnd: localDate(addDays(monday, 6)) },
});
log(thisWeek.status === 201, 'this week can be opened to review as it goes', thisWeek.data?.error);
const tw = await call(`/admin/payroll/periods/${thisWeek.data.period.id}`, { token: admin });
log(tw.data.blockers.some((b) => b.code === 'not_ended'), 'but cannot close before it ends');
const onDuty = tw.data.lines.filter((l) => l.open_entries > 0);
log(onDuty.length > 0 && onDuty.every((l) => l.blocked), 'officers still on the clock cannot be paid yet', `${onDuty.length}`);
const approveWeek = await call(`/admin/payroll/periods/${thisWeek.data.period.id}/approve`, { token: admin, method: 'POST', body: {} });
log(approveWeek.data.skipped.length === onDuty.length && approveWeek.data.skipped.every((s) => /clocked in/.test(s.reason)),
  'approve-all skips them and says why');
log((await call(`/admin/payroll/periods/${thisWeek.data.period.id}`, { token: admin, method: 'DELETE' })).status === 409,
  'a period with approvals in it cannot just be deleted');

const emptyStart = addDays(monday, -70);
const empty = await call('/admin/payroll/periods', {
  token: admin, method: 'POST', body: { periodStart: localDate(emptyStart), periodEnd: localDate(addDays(emptyStart, 13)) },
});
log(empty.status === 201, 'a two-week period can be opened');
const emptyClose = await call(`/admin/payroll/periods/${empty.data.period.id}/close`, { token: admin, method: 'POST' });
log(emptyClose.status === 200 && emptyClose.data.totals.people === 0, 'a week nobody worked closes with nothing owed');
const other = await call('/admin/payroll/periods', {
  token: admin, method: 'POST', body: { periodStart: localDate(addDays(monday, -56)), periodEnd: localDate(addDays(monday, -50)) },
});
log(other.status === 201, 'another open period');
log((await call(`/admin/payroll/periods/${other.data.period.id}`, { token: admin, method: 'DELETE' })).status === 200,
  'an untouched open period can be deleted');

/* ============================================================= register === */
section('the payroll register');

const res = await fetch(`${BASE}/admin/payroll/periods/${due.id}/register.csv`, { headers: { Authorization: `Bearer ${admin}` } });
const csv = await res.text();
const rows = csv.split('\n');
log(res.status === 200 && /text\/csv/.test(res.headers.get('content-type')), 'the register downloads as CSV');
log(rows[0].startsWith('Classification,Employee code,Name'), 'with a header row');
const people = rows.filter((r) => /^(W-2|1099),/.test(r));
log(people.length === reclosed.data.totals.people, 'one row per officer paid', `${people.length}`);
const firstContractor = people.findIndex((r) => r.startsWith('1099'));
log(firstContractor === -1 || people.slice(firstContractor).every((r) => r.startsWith('1099')), 'W-2 employees first, then 1099 contractors');
const totalRow = rows.find((r) => r.startsWith('Total,'));
log(totalRow && cents(Number(totalRow.split(',').at(-1))) === cents(reclosed.data.totals.gross_pay), 'ending in a total that matches the close');

const auditLog = await call('/admin/audit?limit=200', { token: admin });
const actions = (auditLog.data?.entries || auditLog.data?.rows || []).map((a) => a.action);
log(['pay_period.closed', 'pay_period.reopened', 'pay_period.approved', 'pay_period.exported'].every((a) => actions.includes(a)),
  'approving, closing, reopening and exporting are all on the audit log');

finish('Payroll');
