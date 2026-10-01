/**
 * Shift confirmations: an officer says they will be there.
 *
 * Only for the officer's own shift, within a week of it starting, and not once
 * it has started or been cancelled. A confirmation holds only for the officer,
 * post and times it was given for: moving or reassigning the shift drops it.
 * A supervisor can record one taken by phone. Shifts starting within 12 hours
 * and not confirmed are raised as alerts and counted on the dashboard, the
 * sweep reminds the officer once a day ahead, and the client sees which shifts
 * at their property are confirmed.
 *
 * The shifts are created here for a floater with nothing rostered, so the
 * suite does not depend on the demo roster.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const alexis = await signIn('1042', '8598');
log(Boolean(admin && supervisor && marcus && alexis), 'signed in as administrator, supervisor and two officers');
const client = (await call('/client/login', { method: 'POST', body: { email: 'dfaulkner@capitalplazart.com', password: 'capital-portal-06' } })).data?.token;
log(Boolean(client), 'and as the Capital Plaza client contact');

const HOUR = 3600000;
// Whole minutes, so times round-trip exactly.
const at = (ms) => new Date(Math.floor((Date.now() + ms) / 60000) * 60000).toISOString();
const me = (await call('/auth/me', { token: alexis })).data?.user;
const post = (await call('/reference', { token: alexis })).data.posts.find((p) => p.post_code === 'CP-01');
log(Boolean(me?.id && post), 'Alexis and the Capital Plaza front desk', post?.name);

async function makeShift(startIn, hours = 4, userId = me.id) {
  const r = await call('/admin/shifts', {
    token: admin,
    method: 'POST',
    body: { userId, postId: post.id, startsAt: at(startIn), endsAt: at(startIn + hours * HOUR), notes: 'confirmations suite', override: true, overrideReason: 'Test shift for the confirmations suite.' },
  });
  return r.data?.shift;
}
const soon = await makeShift(5 * HOUR);
const urgent = await makeShift(90 * 60000, 2);
const later = await makeShift(3 * 24 * HOUR);
const far = await makeShift(10 * 24 * HOUR);
log(Boolean(soon && urgent && later && far), 'four shifts for Alexis: in 90 minutes, 5 hours, 3 days and 10 days');

const mySchedule = async (token = alexis) => (await call(`/schedule?to=${encodeURIComponent(at(12 * 24 * HOUR))}`, { token })).data.shifts;
const confirm = (id, token = alexis) => call(`/schedule/${id}/confirm`, { token, method: 'POST', body: {} });
const unconfirmed = async (hours) => (await call(`/admin/confirmations${hours ? `?hours=${hours}` : ''}`, { token: supervisor })).data.shifts;

/* ============================================================ schedule === */
section('what the officer sees');

let mine = await mySchedule();
const row = (id) => mine.find((s) => s.id === id);
log(mine.length > 0 && [soon, urgent, later, far].every((s) => row(s.id)), 'the new shifts are on Alexis\'s schedule');
log(row(soon.id).confirmed === false && row(soon.id).confirmable === true, 'not confirmed yet, and can be');
log(row(far.id).confirmable === false, 'a shift more than a week out cannot be confirmed yet');
log(!('confirmed_key' in row(soon.id)) && !('confirm_note' in row(soon.id)), 'the bookkeeping columns stay on the server');

/* =========================================================== reminders === */
section('the reminder');

// Before anything opens the dashboard, which runs the same sweep.
const cron = process.env.CRON_SECRET || 'verify-only-cron-secret';
log((await unconfirmed(48)).find((s) => s.id === soon.id)?.reminded === false, 'no reminder has gone out yet');
const first = await call('/cron/sweep', { token: cron, method: 'POST' });
log(first.status === 200 && first.data.confirmReminders >= 2, 'the sweep reminds officers with an unconfirmed shift in the next day', first.data?.confirmReminders);
let list = await unconfirmed(48);
log(list.find((s) => s.id === soon.id)?.reminded && !list.find((s) => s.id === later.id)?.reminded, 'Alexis is reminded about the shift tonight, not the one in three days');
const second = await call('/cron/sweep', { token: cron, method: 'POST' });
log(second.data.confirmReminders < first.data.confirmReminders, 'and only once', second.data.confirmReminders);

/* ============================================================= alerts === */
section('chasing the unconfirmed');

list = await unconfirmed();
log(list.some((s) => s.id === soon.id && !s.urgent) && list.some((s) => s.id === urgent.id && s.urgent), 'supervisors see both shifts inside 12 hours, the one starting in 90 minutes as urgent');
log(!list.some((s) => s.id === later.id), 'not the one three days away');
log((await unconfirmed(96)).some((s) => s.id === later.id), 'unless they look further ahead');
log((await call('/admin/confirmations', { token: alexis })).status === 403, 'officers cannot see the list');
let alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
const alertFor = (id) => alerts.find((a) => a.kind === 'confirm' && a.key.startsWith(`confirm:${id}:`));
log(alertFor(urgent.id)?.severity === 'critical' && alertFor(soon.id)?.severity === 'warning', 'raised in the alerts inbox, critical inside two hours');
let dash = (await call('/admin/dashboard', { token: supervisor })).data;
log(dash.counts.unconfirmedShifts >= 2 && dash.unconfirmed.some((s) => s.id === soon.id), 'and counted on the dashboard', dash.counts.unconfirmedShifts);

/* ========================================================== confirming === */
section('confirming');

log((await confirm(soon.id, marcus)).status === 404, 'nobody can confirm someone else\'s shift');
log((await confirm(far.id)).status === 409, 'nor one more than a week away');
log((await confirm(999999)).status === 404, 'nor one that does not exist');
const done = await confirm(soon.id);
log(done.status === 200 && done.data.shift.confirmed && done.data.shift.confirm_method === 'app', 'Alexis confirms the shift tonight from the app');
mine = await mySchedule();
log(row(soon.id).confirmed === true, 'and it shows as confirmed on her schedule');
log(!(await unconfirmed()).some((s) => s.id === soon.id), 'it leaves the supervisor\'s list');
alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
log(!alertFor(soon.id), 'and the alert clears');
const adminShifts = (await call(`/admin/shifts?userId=${me.id}&to=${encodeURIComponent(at(12 * 24 * HOUR))}`, { token: supervisor })).data.shifts;
log(adminShifts.find((s) => s.id === soon.id)?.confirmed === true, 'the schedule board shows it confirmed');
log((await confirm(soon.id)).status === 200, 'confirming twice does no harm');

/* ============================================================ by phone === */
section('confirmed by phone');

const phone = (id, body = {}, token = supervisor) => call(`/admin/shifts/${id}/confirm`, { token, method: 'POST', body });
log((await phone(urgent.id, {}, alexis)).status === 403, 'only a supervisor can record a phone confirmation');
log((await phone(urgent.id, { note: 'x'.repeat(301) })).status === 422, 'with a short note');
const byPhone = await phone(urgent.id, { note: 'Called at 3pm, on her way.' });
log(byPhone.status === 200 && byPhone.data.shift.confirmed && byPhone.data.shift.confirm_method === 'phone', 'a supervisor records that Alexis confirmed by phone');
mine = await mySchedule();
log(row(urgent.id).confirmed === true, 'Alexis sees it confirmed too');
alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
log(!alertFor(urgent.id), 'and its alert clears');

/* ============================================================== client === */
section('what the client sees');

const portal = (await call('/client/schedule?days=7', { token: client })).data;
const forClient = (id) => portal.shifts.find((s) => s.id === id);
log(forClient(soon.id)?.confirmed === true && forClient(later.id)?.confirmed === false, 'Capital Plaza sees which shifts the officer has confirmed');
log(typeof portal.summary.confirmed === 'number' && portal.summary.confirmed >= 2, 'and how many', portal.summary.confirmed);
log(!('confirm_note' in forClient(urgent.id)) && !('confirm_method' in forClient(urgent.id)), 'but not how, or the supervisor\'s note');

/* ======================================================= changes drop it === */
section('a changed shift needs confirming again');

const patch = (id, body) => call(`/admin/shifts/${id}`, { token: admin, method: 'PATCH', body });
const moved = await patch(soon.id, { startsAt: at(6 * HOUR), endsAt: at(10 * HOUR) });
log(moved.status === 200, 'the shift tonight is moved an hour later');
mine = await mySchedule();
log(row(soon.id).confirmed === false, 'so it is no longer confirmed');
list = await unconfirmed();
log(list.find((s) => s.id === soon.id)?.reminded === false, 'and Alexis is due a fresh reminder');
log((await confirm(soon.id)).status === 200, 'she confirms the new time');

await patch(soon.id, { userId: null });
await patch(soon.id, { userId: me.id });
mine = await mySchedule();
log(row(soon.id).confirmed === false, 'handed to nobody and back, it needs confirming again');
log((await phone(soon.id)).status === 200, 'a supervisor can still take it by phone');

const open = await patch(later.id, { userId: null });
log(open.status === 200 && (await phone(later.id)).status === 409, 'a shift with nobody on it cannot be confirmed');
await patch(later.id, { status: 'cancelled', userId: me.id });
log((await confirm(later.id)).status === 409, 'nor can a cancelled one');

/* ======================================================== already here === */
section('once the shift starts');

const now = await makeShift(15 * 60000, 1);
const where = { latitude: post.latitude, longitude: post.longitude, accuracy: 6 };
const inn = await call('/timeclock/clock-in', { token: alexis, method: 'POST', body: { postId: post.id, ...where, method: 'gps' } });
log(inn.status === 201 && inn.data.entry?.shift_id === now.id, 'Alexis clocks in early for a shift starting in 15 minutes');
log((await confirm(now.id)).status === 409, 'a shift already clocked in to cannot be confirmed');
log(!(await unconfirmed()).some((s) => s.id === now.id), 'and is not chased: she is plainly there');
const status = (await call('/timeclock/status', { token: alexis })).data;
log(!status.nextShift || status.nextShift.id !== now.id || status.nextShift.confirmable === false, 'her home screen does not offer to confirm it');
const out = await call('/timeclock/clock-out', { token: alexis, method: 'POST', body: where });
log(out.status === 200, 'and clocks out');

/* ============================================================= tidy up === */
for (const s of [soon, urgent, later, far, now]) await call(`/admin/shifts/${s.id}`, { token: admin, method: 'DELETE' });

finish('Shift confirmations suite');
