/**
 * Holiday pay and holiday billing.
 *
 * The company keeps a holiday calendar. A shift that starts on a holiday
 * pays W-2 officers who earn overtime a premium on top of straight time, and
 * bills the client at the holiday rate, on its own invoice line naming the
 * holiday. Hours that are also overtime get the larger premium, not both.
 * A holiday in a closed pay period cannot be added, changed or removed.
 *
 * The holiday hours are worked here: a floater works a short shift now and an
 * administrator moves it to a recent day in an open pay period, which the
 * suite then makes a holiday - so it does not depend on the calendar.
 */

import { call, log, section, signIn, finish, localDay } from './harness.mjs';
import { holidayPremiumCents, usHolidays } from '../src/shared.js';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const alexis = await signIn('1042', '8598'); // a floater with nothing rostered
log(Boolean(admin && supervisor && marcus && alexis), 'signed in as administrator, supervisor and two officers');

const year = new Date().getFullYear();
const at = (day, hour) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hour, 0, 0, 0).toISOString();
};
const addHoliday = (body, token = admin) => call('/holidays', { token, method: 'POST', body });

/* ============================================================== the rules === */
section('the rules');

const nine = (h, holiday) => ({ paid_minutes: h * 60, pay_rate_cents: 2000, ...(holiday ? { holiday: { pay_multiplier: holiday } } : {}) });
const rule = { thresholdMinutes: 40 * 60, overtimeMultiplier: 1.5 };
log(holidayPremiumCents([nine(8, 1.5)], rule).cents === 8000, 'eight holiday hours at $20 pay $80 on top of straight time');
log(holidayPremiumCents([nine(36), nine(8, 1.5)], rule).cents === 4000,
  'after 36 hours, only the four holiday hours under 40 get it: the four in overtime are already at time and a half');
log(holidayPremiumCents([nine(36), nine(8, 2)], rule).cents === 8000 + 4000,
  'at double time, the four straight hours get the whole extra rate and the four in overtime the half that double time pays beyond it');
log(holidayPremiumCents([nine(8, 1.5), nine(36)], rule).cents === 8000, 'a holiday early in the week is all straight time, so all premium');
const days = usHolidays(2027).filter((h) => h.core).map((h) => h.day).join(' ');
log(days === '2027-01-01 2027-05-31 2027-07-04 2027-09-06 2027-11-25 2027-12-25', 'the core holidays fall on the right days, on the day itself', days);

/* ============================================================ the calendar === */
section('the calendar');

const cal = await call(`/holidays?year=${year}`, { token: supervisor });
log(cal.status === 200 && cal.data.holidays.some((h) => h.name === 'Thanksgiving Day') && cal.data.default_multiplier === 1.5,
  'supervisors read the year: the six core holidays are on it, at time and a half by default', `${cal.data.holidays?.length}`);
log(cal.data.suggestions.every((s) => !cal.data.holidays.some((h) => h.day === s.day)) && cal.data.suggestions.some((s) => s.name === 'Veterans Day'),
  'and the federal holidays not yet on it are offered');
log((await call(`/holidays?year=${year}`, { token: marcus })).status === 403, 'officers do not read the whole calendar');
log((await call('/holidays?year=1850', { token: supervisor })).status === 422, 'a nonsense year is refused');
const upcoming = await call('/holidays/upcoming', { token: marcus });
log(upcoming.status === 200 && Array.isArray(upcoming.data.holidays) && typeof upcoming.data.earns_premium === 'boolean',
  'every officer sees the next few holidays, and whether the premium is theirs');
log((await addHoliday({ day: localDay(40), name: 'Founders Day' }, supervisor)).status === 403, 'only an administrator changes the calendar');
log((await addHoliday({ day: 'soon', name: 'Founders Day' })).status === 422, 'a holiday needs a date');
log((await addHoliday({ day: localDay(40), name: 'X' })).status === 422, 'and a name');
log((await addHoliday({ day: localDay(40), name: 'Founders Day', payMultiplier: 0.5 })).status === 422, 'it cannot pay less than a normal day');
log((await addHoliday({ day: localDay(40), name: 'Founders Day', billMultiplier: 4 })).status === 422, 'nor bill more than three times');
const thanksgiving = cal.data.holidays.find((h) => h.name === 'Thanksgiving Day');
log((await addHoliday({ day: thanksgiving.day, name: 'Second Thanksgiving' })).status === 409, 'one holiday a day');

const later = year + 2;
const std = await call('/holidays/standard', { token: admin, method: 'POST', body: { year: later } });
log(std.status === 201 && std.data.added.length === 6 && std.data.added.some((h) => h.day === `${later}-12-25`),
  `the six core holidays for ${later} go on in one step`);
const again = await call('/holidays/standard', { token: admin, method: 'POST', body: { year: later } });
log(again.status === 200 && again.data.added.length === 0, 'and doing it twice adds nothing');

/* ================================================================ the lock === */
section('closed pay periods');

const periods = (await call('/admin/payroll/periods', { token: admin })).data.periods;
const closed = periods.find((p) => p.status === 'closed');
if (closed) {
  const r = await addHoliday({ day: closed.period_start, name: 'Retroactive Day' });
  log(r.status === 409 && r.data?.details?.code === 'period_closed', 'a holiday cannot be added to a pay period already paid', r.data?.error);
} else {
  log(true, 'no closed period in the data to test against');
}

/* ======================================================== holiday hours === */
section('holiday hours: pay');

// The most recent day before today that sits in an open pay period and is not already a holiday.
const taken = new Set((await call(`/holidays?year=${year}`, { token: supervisor })).data.holidays.map((h) => h.day));
// When that day's week has no pay period yet, the suite opens one and removes it at the end. On a
// Monday every day of last week is in a closed period (the payroll suite has just closed it, and the
// seed closed the week before), so the search goes back four weeks, to a week with no period at all.
let day = null;
let period = null;
let openedPeriod = null;
const mondayOf = (d) => {
  const [y, m, dd] = d.split('-').map(Number);
  const x = new Date(y, m - 1, dd);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
for (let back = 1; back <= 27 && !day; back++) {
  const d = localDay(-back);
  if (taken.has(d)) continue;
  let p = periods.find((x) => x.period_start <= d && x.period_end >= d);
  if (!p) {
    const monday = mondayOf(d);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const made = await call('/admin/payroll/periods', { token: admin, method: 'POST', body: { periodStart: ymd(monday), periodEnd: ymd(sunday) } });
    if (made.status !== 201) continue;
    p = made.data.period;
    openedPeriod = p;
  }
  if (p.status === 'open') {
    day = d;
    period = p;
  }
}
log(Boolean(day), 'a recent day in an open pay period to make a holiday', day || 'none');

const post = (await call('/reference', { token: alexis })).data.posts.find((p) => p.post_code === 'CP-01');
const where = { latitude: post.latitude, longitude: post.longitude, accuracy: 6 };
const inn = await call('/timeclock/clock-in', { token: alexis, method: 'POST', body: { postId: post.id, ...where, method: 'gps' } });
const out = await call('/timeclock/clock-out', { token: alexis, method: 'POST', body: where });
const moved = out.data?.entry
  ? await call(`/admin/time-entries/${out.data.entry.id}`, {
      token: admin,
      method: 'PATCH',
      body: { clockInAt: at(day, 8), clockOutAt: at(day, 16), reason: 'Suite: a day shift worked on what becomes a holiday.' },
    })
  : { status: 0 };
log(inn.status === 201 && moved.status === 200, 'Alexis worked eight hours at Capital Plaza that day', moved.data?.error);

const lineOf = async () => (await call(`/admin/payroll/periods/${period.id}`, { token: admin })).data.lines.find((l) => l.employee_code === '1042');
const preview = async () => (await call(`/invoices/preview?siteId=${post.site_id}&periodStart=${day}&periodEnd=${day}`, { token: admin })).data;
const before = await lineOf();
const billBefore = await preview();
log(before && before.holiday_hours === 0 && before.holiday_pay === 0, 'before it is a holiday, nothing extra');

const created = await addHoliday({ day, name: 'Suite Holiday', payMultiplier: 1.5, billMultiplier: 2 });
const holiday = created.data.holiday;
log(created.status === 201 && holiday.day === day && holiday.bill_multiplier === 2, 'the day becomes a holiday: time and a half to pay, double to bill');

const after = await lineOf();
const me = (await call('/admin/employees', { token: admin })).data;
const alexisRecord = (me.employees || me).find((e) => e.employee_code === '1042');
const rate = alexisRecord?.pay_rate ?? (alexisRecord?.pay_rate_cents != null ? alexisRecord.pay_rate_cents / 100 : null);
log(after.holiday_hours >= 8, 'her eight hours count as holiday hours', `${after.holiday_hours}h`);
log(Math.abs(after.gross_pay - before.gross_pay - after.holiday_pay) < 0.01 && after.holiday_pay > 0,
  'her gross goes up by exactly the holiday premium', `+$${after.holiday_pay}`);
if (after.overtime_hours === 0 && rate) {
  log(Math.abs(after.holiday_pay - (after.holiday_hours * rate * 0.5)) < 0.02, 'which is half her rate on each holiday hour, with no overtime that week', `$${rate}/h`);
} else {
  log(after.holiday_pay <= after.holiday_hours * (rate || 100) * 0.5 + 0.01, 'and never more than half her rate per hour, since overtime hours take the larger premium only');
}
log(after.issues.some((i) => i.code === 'holiday' && i.message.includes('Suite Holiday')), 'the register says which holiday');
log(before.approval.state !== 'approved' || after.approval.state === 'changed', 'an approval given before the holiday no longer stands');

const csv = await fetch(`${process.env.USC_TEST_BASE || 'http://localhost:4000/api'}/admin/payroll/periods/${period.id}/register.csv`, {
  headers: { Authorization: `Bearer ${admin}` },
}).then((r) => r.text());
log(csv.split('\n')[0].includes('Holiday premium'), 'the register export has the holiday hours and premium');

/* ======================================================== holiday billing === */
section('holiday hours: billing');

const billAfter = await preview();
const holidayLines = billAfter.lines.filter((l) => l.description.includes('Suite Holiday'));
log(holidayLines.length > 0 && holidayLines.length === billAfter.lines.length, 'every hour at the site that day is on a holiday line', `${holidayLines.length} lines`);
log(holidayLines.every((l) => l.description.includes('holiday rate') && l.description.includes('2x')), 'named for the holiday, with the multiplier');
const pairs = holidayLines.map((h) => [h, billBefore.lines.find((b) => b.post_id === h.post_id)]);
log(pairs.every(([h, b]) => b && h.rate_cents === Math.round(b.rate_cents * 2) && h.minutes === b.minutes),
  'at twice the usual rate, for the same hours');
const sum = (lines, k) => lines.reduce((n, l) => n + l[k], 0);
log(sum(billAfter.lines, 'cost_cents') > sum(billBefore.lines, 'cost_cents'), 'and the premium those hours pay is in their cost');

const changed = await call(`/holidays/${holiday.id}`, { token: admin, method: 'PATCH', body: { billMultiplier: 1.5 } });
const billChanged = await preview();
log(changed.status === 200 && billChanged.lines.every((l) => l.description.includes('1.5x')), 'changing the bill multiplier reprices the day');
log((await call(`/holidays/${holiday.id}`, { token: supervisor, method: 'PATCH', body: { name: 'Nope' } })).status === 403, 'only an administrator changes it');

/* ================================================== who sees it ahead === */
section('who sees it ahead');

const roster = (await call('/schedule', { token: marcus })).data.shifts;
const ahead = roster.find((s) => new Date(s.starts_at) > new Date() && !taken.has(localDayOf(s.starts_at)));
function localDayOf(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
if (ahead) {
  const aheadDay = localDayOf(ahead.starts_at);
  const h = (await addHoliday({ day: aheadDay, name: 'Suite Future Holiday' })).data.holiday;
  const mine = (await call('/schedule', { token: marcus })).data.shifts.find((s) => s.id === ahead.id);
  log(mine?.holiday?.name === 'Suite Future Holiday' && mine.holiday.pay_multiplier === 1.5, 'an officer\'s shift on a holiday says so on the roster');
  log((await call('/holidays/upcoming', { token: marcus })).data.holidays.some((x) => x.day === aheadDay), 'and it is among their upcoming holidays');
  const board = (await call(`/admin/shifts?from=${at(aheadDay, 0)}&to=${at(aheadDay, 23)}`, { token: supervisor })).data;
  log(board.holidays.some((x) => x.day === aheadDay), 'the schedule marks the day for supervisors');

  // The staffing outlook, with a shift nobody is booked on yet.
  const before = (await call('/holidays/outlook', { token: supervisor })).data.holidays.find((x) => x.day === aheadDay);
  const gap = await call('/admin/shifts', {
    token: admin,
    method: 'POST',
    body: { postId: post.id, startsAt: at(aheadDay, 10), endsAt: at(aheadDay, 14), notes: 'Suite: holiday cover nobody has taken yet.' },
  });
  const outlook = await call('/holidays/outlook', { token: supervisor });
  const day = outlook.data.holidays.find((x) => x.day === aheadDay);
  log(outlook.status === 200 && day && day.shifts === before.shifts + 1 && day.open === before.open + 1 && day.assigned === before.assigned,
    'the outlook counts the day\'s shifts, and the one still open', day && `${day.assigned} of ${day.shifts} booked`);
  log(day && day.hours >= 4 && day.estimated_premium > 0 && day.estimated_bill_uplift > 0,
    'with the hours, and what the day adds in premium and in billing', day && `$${day.estimated_premium} / $${day.estimated_bill_uplift}`);
  log((await call('/holidays/outlook', { token: marcus })).status === 403, 'officers do not see the outlook');
  if (day && day.days_away <= outlook.data.alert_days) {
    const alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
    const raised = alerts.find((a) => a.key === `holiday-open:${aheadDay}`);
    log(raised && raised.kind === 'holiday' && raised.title.includes('Suite Future Holiday'), 'an open shift on a holiday this close is in the alerts inbox', raised?.title);
    const counts = (await call('/admin/dashboard', { token: supervisor })).data.counts;
    log(counts.holidayGaps >= 1, 'and counted in the sidebar', `${counts.holidayGaps}`);
  } else {
    log(true, 'the holiday is too far off to raise an alert');
  }
  if (gap.data?.shift?.id) await call(`/admin/shifts/${gap.data.shift.id}`, { token: admin, method: 'DELETE' });
  await call(`/holidays/${h.id}`, { token: admin, method: 'DELETE' });
  log(!(await call('/admin/alerts', { token: supervisor })).data.alerts.some((a) => a.key === `holiday-open:${aheadDay}`),
    'and once it is no longer a holiday, the alert goes');
} else {
  log(true, 'Marcus has no shift ahead to mark');
}

// A portal contact of the suite's own, so it does not spend the demo logins' sign-in allowance.
const sites = (await call('/reference', { token: admin })).data.sites;
const invited = await call('/admin/clients', {
  token: admin,
  method: 'POST',
  body: { email: `holiday.suite.${Date.now()}@example.com`, name: 'Hal Idaye', siteIds: [sites.find((x) => x.name === 'Riverfront Commerce Center').id] },
});
const inviteToken = new URL(invited.data.link, 'http://localhost').searchParams.get('token');
const dana = (await call('/client/set-password', {
  method: 'POST',
  body: { token: inviteToken, password: 'suite-portal-password', confirmPassword: 'suite-portal-password' },
})).data?.token;
const theirs = await call('/client/holidays', { token: dana });
log(theirs.status === 200 && theirs.data.holidays.length > 0 && theirs.data.holidays.every((h) => h.bill_multiplier && !('pay_multiplier' in h)),
  'clients see the holidays ahead and what they bill at, never what officers are paid for them');
log((await call('/holidays/upcoming', { token: dana })).status === 401, 'and a client token does not reach the staff calendar');

/* ================================================================ removal === */
section('removing a holiday');

const removed = await call(`/holidays/${holiday.id}`, { token: admin, method: 'DELETE' });
const gone = await lineOf();
log(removed.status === 200 && gone.holiday_hours === 0 && Math.abs(gone.gross_pay - before.gross_pay) < 0.01, 'removing it takes the premium back out');
log((await preview()).lines.every((l) => !l.description.includes('holiday')), 'and the invoice back to the usual rate');
for (const h of (await call(`/holidays?year=${later}`, { token: supervisor })).data.holidays) {
  await call(`/holidays/${h.id}`, { token: admin, method: 'DELETE' });
}
log((await call(`/holidays?year=${later}`, { token: supervisor })).data.holidays.length === 0, `the ${later} calendar is cleared again`);
if (openedPeriod) await call(`/admin/payroll/periods/${openedPeriod.id}`, { token: admin, method: 'DELETE' });

finish('Holiday pay suite');
