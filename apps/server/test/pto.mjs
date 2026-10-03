/**
 * Paid time off: earned by the hour, spent on time off, paid with payroll.
 *
 * W-2 employees paid by the hour earn an hour for every 30 worked, credited
 * when a week's payroll closes, up to 80. A time-off request can be paid from
 * the balance: never more than is left, never for unpaid leave, never more
 * than 12 hours a day. Approving it spends the hours, and only if they are
 * still there; deleting it gives them back, unless it has been paid. The
 * close after it starts pays it at the officer's rate, beside the gross pay,
 * and a reopen hands it back and takes back what the close credited. The
 * office can adjust a balance, with a reason, within the cap.
 *
 * The payroll part runs on a week of its own, seven weeks back, so it neither
 * depends on nor disturbs the periods the other suites close.
 */

import { BASE, call, log, section, signIn, finish } from './harness.mjs';
import { PTO_CAP_HOURS, ptoAccrued } from '../src/shared.js';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
log(Boolean(admin && supervisor && marcus), 'signed in as administrator, supervisor and an officer');

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const mine = async () => (await call('/time-off/pto', { token: marcus })).data;
const ask = (body) => call('/time-off', { token: marcus, method: 'POST', body });
const decide = (id, status, token = supervisor) => call(`/time-off/${id}`, { token, method: 'PATCH', body: { status } });

/* ============================================================== balance === */
section('the balance');

const start = await mine();
log(start.eligible && start.balance > 0 && start.rules.accrualWorkedHours === 30 && start.rules.capHours === PTO_CAP_HOURS,
  'an hourly W-2 officer has a balance and the rules', `${start.balance} h`);
log(start.history.some((h) => h.kind === 'accrual' && h.period) && start.history.some((h) => h.kind === 'adjustment'),
  'the statement shows the carry-over and what the closed week earned');
log(start.available === Math.round((start.balance - start.pending) * 100) / 100, 'what is left to ask for takes off what is already asked for',
  `${start.balance} - ${start.pending}`);
log(ptoAccrued(30 * 60) === 1 && ptoAccrued(45 * 60) === 1.5, 'an hour is earned for every 30 worked');

const period1 = (await call('/admin/payroll/periods/1', { token: admin })).data;
const contractor = period1.lines.find((l) => l.employment_type === '1099');
const hourly = period1.lines.find((l) => l.employment_type === 'w2' && l.pay_type === 'hourly' && l.minutes > 0);
log(period1.pto.accrued > 0 && hourly.pto_accrues > 0 && contractor.pto_accrues === 0, 'the closed week credited hourly W-2 staff, and no contractor',
  `${period1.pto.accrued} h`);
const theirs = await call(`/time-off/pto/${contractor.user_id}`, { token: supervisor });
log(theirs.status === 200 && theirs.data.eligible === false && theirs.data.balance === 0, 'a 1099 contractor has no paid time off');
log((await call(`/time-off/pto/${hourly.user_id}`, { token: marcus })).status === 403, 'an officer cannot look at someone else\'s balance');

/* ============================================================= requests === */
section('asking for it');

const tooMuch = await ask({ type: 'vacation', startsOn: inDays(60), endsOn: inDays(66), ptoHours: start.available + 1 });
log(tooMuch.status === 422 && tooMuch.data.details?.[0]?.field === 'ptoHours', 'not more than is left', tooMuch.data?.error);
log((await ask({ type: 'unpaid', startsOn: inDays(60), endsOn: inDays(60), ptoHours: 4 })).status === 422, 'not for unpaid leave');
log((await ask({ type: 'vacation', startsOn: inDays(60), endsOn: inDays(60), ptoHours: 13 })).status === 422, 'not more than 12 hours a day');
const day = await ask({ type: 'vacation', startsOn: inDays(60), endsOn: inDays(60), reason: 'Suite: a day from the balance.', ptoHours: 4 });
log(day.status === 201 && day.data.request.pto_hours === 4, 'four hours from the balance for a day off', day.data?.error);
const after = await mine();
log(after.available === Math.round((start.available - 4) * 100) / 100 && after.balance === start.balance, 'asked for, it is promised but not yet spent');
const theirsNow = await call(`/time-off/pto/${contractor.user_id}`, { token: admin });
log((await call(`/time-off/pto/${contractor.user_id}/adjust`, { token: admin, method: 'POST', body: { hours: 8, note: 'Suite: a contractor has none.' } })).status === 409 && theirsNow.data.balance === 0,
  'and a contractor cannot be given any');

/* ============================================================= deciding === */
section('approving it');

const listed = (await call('/time-off?scope=all&status=pending', { token: supervisor })).data.requests.find((r) => r.id === day.data.request.id);
log(listed && listed.pto_hours === 4 && listed.pto_balance === after.balance, 'the approver sees the hours asked for and the balance beside them');
log((await decide(day.data.request.id, 'approved')).status === 200, 'a supervisor approves it');
const spent = await mine();
log(spent.balance === Math.round((start.balance - 4) * 100) / 100 && spent.history[0].kind === 'used' && spent.history[0].hours === -4,
  'approving it spends the hours', `${spent.balance} h`);

// Everything left is asked for and approved, leaving exactly the hours the
// week's vacation already waiting needs. Two hours taken off by the office,
// and that vacation can no longer be approved.
const meId = day.data.request.user_id;
const rest = await ask({ type: 'vacation', startsOn: inDays(70), endsOn: inDays(70), reason: 'Suite: the rest of it.', ptoHours: spent.available });
log(rest.status === 201 && (await decide(rest.data.request.id, 'approved')).status === 200, 'the rest of the balance asked for and approved', rest.data?.error);
const left = (await mine()).balance;
const shave = await call(`/time-off/pto/${meId}/adjust`, { token: admin, method: 'POST', body: { hours: -2, note: 'Suite: corrected an over-credit.' } });
log(shave.status === 201 && shave.data.balance === Math.round((left - 2) * 100) / 100, 'an administrator takes two hours off, with a reason');
const vacation = (await call('/time-off?status=pending', { token: marcus })).data.requests.find((r) => r.pto_hours >= 40);
const refused = await decide(vacation.id, 'approved');
log(refused.status === 409 && /left/.test(refused.data.error), 'a request for more than is left cannot be approved', refused.data?.error);
log((await call('/time-off', { token: marcus })).data.requests.find((r) => r.id === vacation.id).status === 'pending', 'and stays waiting');
await call(`/time-off/${rest.data.request.id}`, { token: admin, method: 'DELETE' });
await call(`/time-off/pto/${meId}/adjust`, { token: admin, method: 'POST', body: { hours: 2, note: 'Suite: put the two hours back.' } });

log((await call(`/time-off/pto/${meId}/adjust`, { token: supervisor, method: 'POST', body: { hours: 2, note: 'Supervisor try.' } })).status === 403,
  'only an administrator adjusts a balance');
log((await call(`/time-off/pto/${meId}/adjust`, { token: admin, method: 'POST', body: { hours: 2, note: 'x' } })).status === 422, 'and says why');
log((await call(`/time-off/pto/${meId}/adjust`, { token: admin, method: 'POST', body: { hours: PTO_CAP_HOURS, note: 'Suite: over the cap.' } })).status === 422,
  `and never past ${PTO_CAP_HOURS} hours`);
log((await call(`/time-off/pto/${meId}/adjust`, { token: admin, method: 'POST', body: { hours: -1000, note: 'Suite: below nothing.' } })).status === 422,
  'nor below nothing');

const before = (await mine()).balance;
log((await call(`/time-off/${day.data.request.id}`, { token: admin, method: 'DELETE' })).status === 200 &&
  (await mine()).balance === Math.round((before + 4) * 100) / 100, 'deleting an approved request gives the hours back');

/* ============================================================== payroll === */
section('paid with payroll');

const monday = new Date();
monday.setHours(12, 0, 0, 0);
monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 49);
const sunday = new Date(monday);
sunday.setDate(sunday.getDate() + 6);
const week = await call('/admin/payroll/periods', { token: admin, method: 'POST', body: { periodStart: ymd(monday), periodEnd: ymd(sunday) } });
log(week.status === 201, 'a pay period for a quiet week seven weeks back', week.data?.error);
const periodId = week.data.period.id;
const inWeek = ymd(new Date(monday.getTime() + 2 * 86400000));

await call(`/time-off/pto/${meId}/adjust`, { token: admin, method: 'POST', body: { hours: 8, note: 'Suite: hours for a sick day.' } });
const sick = await ask({ type: 'sick', startsOn: inWeek, endsOn: inWeek, reason: 'Suite: a sick day, paid.', ptoHours: 8 });
log(sick.status === 201, 'a sick day in that week, from the balance', sick.data?.error);
let period = (await call(`/admin/payroll/periods/${periodId}`, { token: admin })).data;
log(period.blockers.some((b) => b.code === 'pto'), 'undecided, it holds up closing that week');
log((await call(`/admin/payroll/periods/${periodId}/close`, { token: admin, method: 'POST' })).status === 409, 'the close is refused');
await decide(sick.data.request.id, 'approved');
period = (await call(`/admin/payroll/periods/${periodId}`, { token: admin })).data;
const item = period.pto.items.find((i) => i.request_id === sick.data.request.id);
log(!period.blockers.some((b) => b.code === 'pto') && item && item.hours === 8 && item.pay === Math.round(8 * item.rate * 100) / 100,
  'approved, it is paid by that close at the officer\'s rate', item && `$${item.pay} at $${item.rate}`);
log(period.totals.pto_pay >= item.pay && period.totals.gross_cents >= 0, 'as paid time off, apart from the pay for hours worked');

const closed = await call(`/admin/payroll/periods/${periodId}/close`, { token: admin, method: 'POST' });
log(closed.status === 200, 'the week closes', closed.data?.error);
const paid = (await call('/time-off', { token: marcus })).data.requests.find((r) => r.id === sick.data.request.id);
log(paid.pto_paid_in === `${ymd(monday)} to ${ymd(sunday)}` && paid.pto_pay === item.pay, 'and the request says which payroll paid it', paid.pto_paid_in);
const csv = await (await fetch(`${BASE}/admin/payroll/periods/${periodId}/register.csv`, { headers: { Authorization: `Bearer ${admin}` } })).text();
log(csv.split('\n')[0].includes('PTO hours') && csv.includes('Paid time off to officers with no hours') && csv.includes('Marcus Bell'),
  'the register carries it, for an officer with no hours that week too');
log((await call(`/time-off/${sick.data.request.id}`, { token: admin, method: 'DELETE' })).status === 409, 'paid, it can no longer be deleted');

const reopened = await call(`/admin/payroll/periods/${periodId}/reopen`, { token: admin, method: 'POST', body: { reason: 'Suite check: reopen hands paid time off back.' } });
const back = (await call('/time-off', { token: marcus })).data.requests.find((r) => r.id === sick.data.request.id);
log(reopened.status === 200 && !back.pto_paid_in && back.pto_pay == null, 'reopening the week hands it back to be paid again');
await call(`/admin/payroll/periods/${periodId}/close`, { token: admin, method: 'POST' });

/* ================================================================ audit === */
const actions = (await call('/admin/audit?action=pto.', { token: admin })).data.entries.map((e) => e.action);
log(actions.includes('pto.adjusted'), 'balance adjustments are audited');

finish('Paid time off suite');
