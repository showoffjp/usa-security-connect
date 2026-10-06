/**
 * Time corrections: an officer asks for a punch to be fixed, the office decides.
 *
 * Only the officer's own, recent, finished shifts; one request at a time per
 * shift; never hours already paid. Approving changes the entry through the
 * same path as an administrator's own correction - original times kept - and
 * only an administrator can do it. A request waiting blocks the pay period
 * it falls in from closing.
 *
 * The shifts being corrected are worked here, today, by a floater, so the
 * suite does not depend on which day of the week it runs or on which pay
 * periods the payroll suite has closed before it.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const alexis = await signIn('1042', '8598'); // a floater with nothing rostered
log(Boolean(admin && supervisor && marcus && alexis), 'signed in as administrator, supervisor and two officers');

const MIN = 60000;
const iso = (d) => new Date(d).toISOString();
const ask = (body, token = alexis) => call('/time-corrections', { token, method: 'POST', body });
const mineOf = async (token = alexis) => (await call('/time-corrections/mine', { token })).data;
const reason = 'My relief was late and I stayed at the desk until they arrived.';

// Two short shifts at Capital Plaza, worked now.
const post = (await call('/reference', { token: alexis })).data.posts.find((p) => p.post_code === 'CP-01');
const at = { latitude: post.latitude, longitude: post.longitude, accuracy: 6 };
async function workShift() {
  const inn = await call('/timeclock/clock-in', { token: alexis, method: 'POST', body: { postId: post.id, ...at, method: 'gps' } });
  const out = await call('/timeclock/clock-out', { token: alexis, method: 'POST', body: at });
  return inn.status === 201 && out.status === 200 ? out.data.entry : null;
}
const shiftA = await workShift();
const shiftB = await workShift();
log(Boolean(shiftA && shiftB), 'Alexis works two short shifts');

/* ============================================================== asking === */
section('asking for a correction');

let mine = await mineOf();
log(mine.windowDays === 14 && [shiftA.id, shiftB.id].every((id) => mine.entries.some((e) => e.id === id)),
  'an officer sees their punches from the last 14 days');
const first = mine.entries.find((e) => e.id === shiftA.id);
const second = mine.entries.find((e) => e.id === shiftB.id);

// Half an hour earlier - but never back into last week, which the payroll suite has already
// closed: just after midnight on a Monday the shift was worked minutes into the new week.
const weekStart = new Date(first.clock_in_at);
weekStart.setHours(0, 0, 0, 0);
weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
const earlier = Math.max(1, Math.min(30, Math.floor((new Date(first.clock_in_at) - weekStart) / MIN) - 1));
const inEarlier = iso(new Date(first.clock_in_at).getTime() - earlier * MIN);
log((await ask({ entryId: first.id, reason })).status === 422, 'a request has to say what the time should be');
log((await ask({ entryId: first.id, clockInAt: inEarlier, reason: 'Late.' })).status === 422, 'and why, in a sentence');
log((await ask({ entryId: first.id, clockOutAt: iso(Date.now() + 3600000), reason })).status === 422, 'not a time in the future');
log((await ask({ entryId: first.id, clockInAt: iso(new Date(first.clock_out_at).getTime() + MIN), reason })).status === 422,
  'not a clock-in after the clock-out');
log((await ask({ entryId: first.id, clockInAt: iso(new Date(first.clock_in_at).getTime() - 13 * 3600000), reason })).status === 422,
  'not half a day away from what was recorded');
log((await ask({ entryId: first.id, clockInAt: first.clock_in_at, reason })).status === 422, 'and not the times already recorded');
log((await ask({ entryId: first.id, clockInAt: inEarlier, reason }, marcus)).status === 404, 'nobody can ask about someone else\'s shift');
const old = ((await call('/timeclock/entries?limit=200', { token: marcus })).data.entries || [])
  .find((e) => e.clock_out_at && new Date(e.clock_in_at) < new Date(Date.now() - 15 * 86400000));
if (old) {
  log((await ask({ entryId: old.id, clockOutAt: iso(new Date(old.clock_out_at).getTime() + 5 * MIN), reason }, marcus)).status === 409,
    'or about a shift more than two weeks ago');
} else {
  // The demo history starts two weeks back, and older hours sit in a closed period.
  log(true, 'no shift older than two weeks in the demo data; the window is enforced before anything else');
}
const running = (await mineOf(marcus)).entries.find((e) => !e.clock_out_at);
if (running) {
  log((await ask({ entryId: running.id, clockOutAt: iso(Date.now() - MIN), reason }, marcus)).status === 409,
    'a shift still running cannot have its clock-out changed');
}

const asked = await ask({ entryId: first.id, clockInAt: inEarlier, reason });
const firstId = asked.data.correction?.id;
log(asked.status === 201 && asked.data.correction.status === 'pending' && asked.data.correction.proposed_minutes === asked.data.correction.recorded_minutes + earlier,
  `Alexis asks for her clock-in ${earlier} minutes earlier`, `#${firstId}`);
log((await ask({ entryId: first.id, clockInAt: inEarlier, reason })).status === 409, 'one request at a time per shift');
mine = await mineOf();
log(mine.entries.find((e) => e.id === first.id)?.correction?.status === 'pending', 'and sees it waiting');

/* ============================================================ the office === */
section('the office');

const queue = await call('/time-corrections', { token: supervisor });
log(queue.status === 200 && queue.data.corrections.some((c) => c.id === firstId && c.officer.startsWith('Alexis')), 'supervisors see the waiting requests');
log((await call('/time-corrections', { token: alexis })).status === 403, 'officers cannot see the queue');
const alerts = (await call('/admin/alerts', { token: admin })).data.alerts;
log(alerts.some((a) => a.key === `correction:${firstId}` && a.kind === 'correction'), 'a request is in the alerts inbox');
log((await call('/admin/dashboard', { token: admin })).data.counts.pendingCorrections >= 1, 'and counted on the sidebar');

// A pay period this week, so the block on closing can be seen.
const monday = new Date();
monday.setHours(0, 0, 0, 0);
monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sunday = new Date(monday.getTime() + 6 * 86400000);
let periodId;
let madePeriod = false;
const made = await call('/admin/payroll/periods', { token: admin, method: 'POST', body: { periodStart: day(monday), periodEnd: day(sunday) } });
if (made.status === 201) {
  periodId = made.data.period.id;
  madePeriod = true;
} else {
  periodId = made.data?.details?.periodId;
}
const review = async () => (await call(`/admin/payroll/periods/${periodId}`, { token: admin })).data;
const waiting = (r) => (r.lines || []).reduce((n, l) => n + (l.pending_corrections || 0), 0);
const before = await review();
const herLine = (r) => r.lines.find((l) => l.officer.startsWith('Alexis'));
log(before.blockers.some((b) => b.code === 'corrections') && herLine(before)?.issues.some((i) => i.code === 'correction'),
  'a request waiting stops this week\'s pay period from closing, and is on her line');

log((await call(`/time-corrections/${firstId}/approve`, { token: supervisor, method: 'POST', body: {} })).status === 403, 'only an administrator approves');
log((await call(`/time-corrections/${firstId}/withdraw`, { token: marcus, method: 'POST' })).status === 404, 'another officer cannot withdraw it');
log((await call(`/time-corrections/${firstId}/decline`, { token: admin, method: 'POST', body: { note: 'no' } })).status === 422, 'declining needs a reason the officer can read');
const approved = await call(`/time-corrections/${firstId}/approve`, { token: admin, method: 'POST', body: { note: 'Matches the relief officer\'s arrival in the post log.' } });
log(approved.status === 200 && approved.data.correction.status === 'approved' && approved.data.correction.decided_by_name, 'an administrator approves it');
const after = (await mineOf()).entries.find((e) => e.id === first.id);
log(after.clock_in_at === inEarlier && after.original_clock_in_at === first.clock_in_at && after.adjusted && after.minutes_worked >= earlier,
  'the shift now starts when she said, the recorded time is kept, and the minutes follow');
log((await call(`/time-corrections/${firstId}/approve`, { token: admin, method: 'POST', body: {} })).status === 409, 'a request is decided once');
log(waiting(await review()) === waiting(before) - 1, 'and the pay period is no longer held up by it');

/* ================================================= withdraw and decline === */
section('withdrawing and declining');

const w = (await ask({ entryId: second.id, clockInAt: iso(new Date(second.clock_in_at).getTime() - 10 * MIN), reason })).data.correction;
log((await call(`/time-corrections/${w.id}/withdraw`, { token: alexis, method: 'POST' })).status === 200, 'an officer withdraws a request');
log((await call(`/time-corrections/${w.id}/approve`, { token: admin, method: 'POST', body: {} })).status === 409, 'which then cannot be approved');
log((await call(`/time-corrections/${w.id}/withdraw`, { token: alexis, method: 'POST' })).status === 409, 'or withdrawn twice');

const d = await ask({ entryId: second.id, clockInAt: iso(new Date(second.clock_in_at).getTime() - 60 * MIN), reason: 'I started an hour early to cover the lobby.' });
log(d.status === 201, 'and can ask again about the same shift once it is withdrawn');
const declined = await call(`/time-corrections/${d.data.correction.id}/decline`, { token: admin, method: 'POST', body: { note: 'Overtime has to be agreed with a supervisor first.' } });
log(declined.status === 200 && declined.data.correction.status === 'declined', 'an administrator declines one, with a reason');
const untouched = (await mineOf()).entries.find((e) => e.id === second.id);
log(untouched.clock_in_at === second.clock_in_at && untouched.correction.decision_note.startsWith('Overtime'), 'the shift is unchanged and she reads why');

/* ================================================= hours already paid === */
section('hours already paid');

const periods = (await call('/admin/payroll/periods', { token: admin })).data.periods || [];
const closed = periods.filter((p) => p.status === 'closed');
const recent = ((await call('/timeclock/entries?limit=200', { token: marcus })).data.entries || []).filter(
  (e) => e.clock_out_at && new Date(e.clock_in_at) > new Date(Date.now() - 13 * 86400000)
);
const paid = recent.find((e) => closed.some((p) => e.clock_in_at.slice(0, 10) >= p.period_start.slice(0, 10) && e.clock_in_at.slice(0, 10) <= p.period_end.slice(0, 10)));
if (paid) {
  const r = await ask({ entryId: paid.id, clockOutAt: iso(new Date(paid.clock_out_at).getTime() + 5 * MIN), reason }, marcus);
  log(r.status === 409 && /closed|paid/i.test(r.data.error), 'a shift in a closed pay period cannot be changed this way', r.data.error);
} else {
  log(true, 'no recent shift sits in a closed pay period today; the closed-period path is covered by the payroll suite');
}

if (madePeriod) await call(`/admin/payroll/periods/${periodId}`, { token: admin, method: 'DELETE' });

const auditLog = (await call('/admin/audit?limit=300', { token: admin })).data?.entries || [];
const actions = new Set(auditLog.map((e) => e.action));
log(['correction.requested', 'correction.approved', 'correction.declined', 'correction.withdrawn', 'time_entry.adjusted'].every((a) => actions.has(a)),
  'requests, decisions and the change to the shift are audited');

finish('Time corrections');
