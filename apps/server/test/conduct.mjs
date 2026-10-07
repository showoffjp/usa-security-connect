/**
 * Coaching and discipline.
 *
 * Supervisors record coaching and verbal or written warnings; final warnings
 * and suspensions are an administrator's. The officer signs each record by
 * typing their name, with their side of it if they want, or a supervisor
 * records that they refused, with a witness. A record counts towards the next
 * step for a year unless rescinded. A suspension keeps the officer off the
 * roster for its dates.
 *
 * Marcus signs the coaching the demo gave him; Janelle is given a verbal
 * warning she refuses to sign, and a one-day suspension that is then
 * rescinded.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const janelle = await signIn('1004', '5930');
const client = (await call('/client/login', { method: 'POST', body: { email: 'carla.mendez@harborviewhealth.org', password: 'harborview-portal-04' } })).data?.token;
log(Boolean(admin && supervisor && marcus && janelle && client), 'signed in as staff, two officers and a client');

const me = async (token) => (await call('/auth/me', { token })).data?.user;
const janelleId = (await me(janelle))?.id;
const supervisorId = (await me(supervisor))?.id;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFromNow = (n) => ymd(new Date(Date.now() + n * 86400000));

/* ============================================================ the board === */
section('the office');

const board = await call('/conduct', { token: supervisor });
log(board.status === 200 && board.data.records.length >= 6, 'supervisors see the records from the last year', `${board.data.records?.length}`);
log((await call('/conduct', { token: marcus })).status === 403, 'officers do not');
log((await call('/conduct', { token: client })).status === 401, 'nor do clients');
const ladder = board.data.officers.find((o) => o.level === 'written_warning');
log(Boolean(ladder) && ladder.next.attendance === 'final_warning', 'after coaching, a verbal and a written warning for attendance, the next step is a final warning', ladder?.name);
const refused = board.data.records.find((r) => r.status === 'refused');
log(Boolean(refused) && refused.refused_witness && refused.refused_by_name, 'a record the officer would not sign says who witnessed it');
const rescinded = board.data.records.find((r) => r.status === 'rescinded');
log(Boolean(rescinded) && rescinded.active === false && rescinded.rescind_reason, 'a rescinded record stays, marked, and no longer counts');
const overdue = board.data.records.find((r) => r.signature_overdue);
log(Boolean(overdue), 'a record left unsigned for days is called out', overdue?.officer);
const alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
log(alerts.some((a) => a.kind === 'conduct' && a.key === `conduct:${overdue.id}`), 'and chased in the alerts inbox');
log((await call('/admin/dashboard', { token: supervisor })).data.counts.conductUnsigned >= 1, 'and counted for the sidebar');

/* ========================================================== the officer === */
section('the officer signs');

const mine = (await call('/conduct/mine', { token: marcus })).data;
const coaching = mine.records.find((r) => r.awaiting_signature);
log(mine.awaiting === 1 && coaching?.level === 'coaching' && coaching.issued_by_name, 'Marcus has a coaching to read and sign, and sees who recorded it');
log(!('issued_by' in coaching) && !('refused_by' in coaching), 'without the internal ids');
const ack = (token, id, body) => call(`/conduct/mine/${id}/acknowledge`, { token, method: 'POST', body });
log((await ack(marcus, coaching.id, { signature: 'M Bell' })).status === 422, 'signing needs his full name');
log((await ack(marcus, overdue.id, { signature: 'Marcus Bell' })).status === 404, "another officer's record is not found");
const statement = 'The bridge was closed for an accident on the way in. I will leave earlier.';
const signed = await ack(marcus, coaching.id, { signature: 'marcus  bell', statement });
log(signed.status === 200 && signed.data.record.status === 'acknowledged' && signed.data.record.officer_statement === statement,
  'he signs it, with his side of it');
log((await ack(marcus, coaching.id, { signature: 'Marcus Bell' })).status === 409, 'and it is signed once');

/* ============================================================== issuing === */
section('recording a step');

const issue = (token, body) => call('/conduct', { token, method: 'POST', body });
const base = {
  userId: janelleId, category: 'uniform', level: 'verbal_warning', occurredOn: daysFromNow(-1),
  summary: 'Arrived for the gatehouse shift without the company jacket or badge, after a reminder last week.',
  expectations: 'Full uniform on every shift, badge visible.',
};
log((await issue(supervisor, { ...base, summary: 'Late.' })).status === 422, 'it says what happened, in detail');
log((await issue(supervisor, { ...base, occurredOn: daysFromNow(2) })).status === 422, 'not something still to come');
log((await issue(supervisor, { ...base, occurredOn: daysFromNow(-90) })).status === 422, 'nor more than 60 days ago');
log((await issue(supervisor, { ...base, userId: supervisorId })).status === 403, 'nobody records a step on their own record');
log((await issue(supervisor, { ...base, level: 'final_warning' })).status === 403, 'a final warning is an administrator\'s');
log((await issue(marcus, base)).status === 403, 'officers record nothing');
log((await issue(supervisor, { ...base, suspensionStartsOn: daysFromNow(3), suspensionEndsOn: daysFromNow(3) })).status === 422, 'only a suspension has days off');

const verbal = await issue(supervisor, base);
log(verbal.status === 201 && verbal.data.record.level === 'verbal_warning' && verbal.data.standing.next.uniform === 'written_warning',
  'a supervisor gives Janelle a verbal warning; the next uniform step would be a written warning');
const janelleMine = (await call('/conduct/mine', { token: janelle })).data;
log(janelleMine.awaiting === 1, 'Janelle has it to sign');

log((await call(`/conduct/${verbal.data.record.id}/refused`, { token: supervisor, method: 'POST', body: { witness: 'x' } })).status === 422, 'a refusal names a witness');
const ref = await call(`/conduct/${verbal.data.record.id}/refused`, { token: supervisor, method: 'POST', body: { witness: 'Renata Diaz and the site manager' } });
log(ref.status === 200 && ref.data.record.status === 'refused', 'she will not sign, and the supervisor records it');
log((await ack(janelle, verbal.data.record.id, { signature: 'Janelle Carter' })).status === 409, 'after which there is nothing to sign');

/* ========================================================== suspension === */
section('a suspension');

const open = (await call('/shifts/open', { token: janelle })).data.shifts;
const target = open.find((s) => s.canClaim);
log(Boolean(target), 'an open shift Janelle could claim', target?.post_name);
const shiftDay = ymd(new Date(target.starts_at));
const susp = { ...base, category: 'post_conduct', level: 'suspension', summary: 'Left the gatehouse unattended for forty minutes during the night shift without telling anyone.',
  expectations: 'Stay on post until relieved. Call the supervisor line if you must leave.' };
log((await issue(admin, susp)).status === 422, 'a suspension needs its days');
log((await issue(admin, { ...susp, suspensionStartsOn: daysFromNow(2), suspensionEndsOn: daysFromNow(40) })).status === 422, 'of at most 30 days');
const suspended = await issue(admin, { ...susp, suspensionStartsOn: shiftDay, suspensionEndsOn: shiftDay });
log(suspended.status === 201 && suspended.data.record.suspension_starts_on === shiftDay, 'an administrator suspends Janelle for that day');
const nowOpen = (await call('/shifts/open', { token: janelle })).data.shifts.find((s) => s.id === target.id);
log(nowOpen && nowOpen.canClaim === false && nowOpen.eligibility.some((r) => r.code === 'suspended'), 'and she cannot claim the shift on it');
const cand = await call(`/admin/shifts/candidates?postId=${target.post_id}&startsAt=${encodeURIComponent(target.starts_at)}&endsAt=${encodeURIComponent(target.ends_at)}`, { token: supervisor });
const her = cand.data.candidates.find((c) => c.user_id === janelleId);
log(her && her.eligible === false && her.reasons.some((r) => r.code === 'suspended'), 'nor is she offered for it');

log((await call(`/conduct/${suspended.data.record.id}/rescind`, { token: supervisor, method: 'POST', body: { reason: 'Wrong officer.' } })).status === 403,
  'only an administrator rescinds');
const back = await call(`/conduct/${suspended.data.record.id}/rescind`, { token: admin, method: 'POST', body: { reason: 'The gate log shows the relief officer was there.' } });
log(back.status === 200 && back.data.record.status === 'rescinded' && back.data.record.active === false, 'an administrator rescinds it');
log((await call(`/conduct/${suspended.data.record.id}/rescind`, { token: admin, method: 'POST', body: { reason: 'Again, twice.' } })).status === 409, 'once');
const freed = (await call('/shifts/open', { token: janelle })).data.shifts.find((s) => s.id === target.id);
log(freed && !freed.eligibility.some((r) => r.code === 'suspended'), 'and she can take the shift again');

log((await call(`/conduct/officers/${supervisorId}`, { token: supervisor })).status === 403, "a supervisor's own record is for administrators");
log((await call(`/conduct/officers/${supervisorId}`, { token: admin })).status === 200, 'who can read it');
const record = await call(`/conduct/officers/${janelleId}`, { token: supervisor });
log(record.status === 200 && record.data.records.length >= 2 && record.data.standing.level === 'verbal_warning',
  "her record shows both, and the rescinded suspension does not count towards where she stands");

// A supervisor's record is an administrator's to write and to read.
const otherSup = ((await call('/admin/employees', { token: admin })).data?.employees || [])
  .find((e) => e.role === 'supervisor' && e.status === 'active' && e.id !== supervisorId);
log(Boolean(otherSup), 'there is another supervisor', otherSup && `${otherSup.first_name} ${otherSup.last_name}`);
if (otherSup) {
  const forSup = { ...base, userId: otherSup.id, category: 'procedure', level: 'coaching',
    summary: 'Closed the field visit report for the marina without the gate check filled in.' };
  log((await issue(supervisor, forSup)).status === 403, 'a supervisor cannot record a step for another supervisor');
  log((await issue(admin, forSup)).status === 201, 'an administrator can');
  log(!(await call('/conduct', { token: supervisor })).data.records.some((r) => r.user_id === otherSup.id), 'and supervisors do not see it on the board');
  log((await call('/conduct', { token: admin })).data.records.some((r) => r.user_id === otherSup.id), 'while administrators do');
}

const audit = (await call('/admin/audit?limit=300', { token: admin })).data?.entries || [];
const actions = new Set(audit.map((e) => e.action));
log(['conduct.issued', 'conduct.acknowledged', 'conduct.refused', 'conduct.rescinded'].every((a) => actions.has(a)), 'every step is audited');

finish('Coaching and discipline');
