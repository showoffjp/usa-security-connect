/**
 * Site training: who is cleared to work a post alone.
 *
 * A post can need site training. An officer who is not trained there - never
 * signed off, lapsed after months away, or withdrawn - cannot claim or swap
 * into a shift at it. A supervisor can still roster them (a training shift),
 * with a warning, and the alerts inbox flags it until they are signed off.
 *
 * Marcus is put on a training shift at Harborview's Emergency Department
 * Entrance here, signed off, and then has it withdrawn again. The demo's
 * waiting, lapsed and withdrawn officers are signed off along the way.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
log(Boolean(admin && supervisor && marcus), 'signed in as an administrator, a supervisor and an officer');

const me = async (token) => (await call('/auth/me', { token })).data?.user;
const marcusId = (await me(marcus))?.id;
const supervisorId = (await me(supervisor))?.id;
const alertsFor = async () => (await call('/admin/alerts', { token: supervisor })).data.alerts.filter((a) => a.kind === 'training');

/* ============================================================ the board === */
section('the board');

const board = await call('/site-training', { token: supervisor });
log(board.status === 200 && board.data.posts.length >= 5, 'supervisors see every post that needs site training', `${board.data.posts?.length} posts`);
log((await call('/site-training', { token: marcus })).status === 403, 'officers do not');
const post = (name) => board.data.posts.find((p) => p.name === name);
const ed = post('Emergency Department Entrance');
const garage = post('Garage & Loading Dock - Armed');
const lab = post('Lab Building Access Control');
const warehouse = post('Warehouse Interior - Armed');
log(Boolean(ed && garage && lab && warehouse), 'the armed posts, the ED entrance and the lab desk need it');
log(ed.trained.length >= 2 && ed.trained.every((q) => q.state === 'trained' && q.signed_off_by_name),
  'each lists who is trained there and who signed them off', `${ed.trained.length} at the ED`);
const darnell = garage.ready[0];
log(Boolean(darnell) && darnell.shifts >= 1, 'an officer who has worked a post but is not signed off is waiting for it', darnell && `${darnell.officer}, ${darnell.shifts} shifts`);
log(garage.rostered.some((r) => r.user_id === darnell.user_id), 'and is flagged on the roster there meanwhile');
const trainee = ed.rostered[0];
log(Boolean(trainee) && trainee.state === 'untrained', 'a training shift on the roster shows', trainee?.officer);
const alexis = lab.lapsed[0];
log(Boolean(alexis) && alexis.state === 'lapsed', 'training not used in six months needs a refresher', alexis?.officer);
const raymond = warehouse.revoked[0];
log(Boolean(raymond) && raymond.revoke_reason, 'withdrawn training says why', raymond?.revoke_reason?.slice(0, 40));
log(board.data.counts.thin >= 1, 'posts with fewer than two trained officers are counted', `${board.data.counts.thin}`);

/* ============================================================== the rule === */
section('what an officer can take');

const open = (await call('/shifts/open', { token: marcus })).data.shifts;
const edOpen = open.find((s) => s.post_id === ed.id && !s.eligibility.some((r) => r.code === 'conflict'));
log(Boolean(edOpen) && edOpen.canClaim === false && edOpen.eligibility.some((r) => r.code === 'not_trained'),
  'an open shift at a post Marcus is not trained at cannot be claimed');
const plain = open.find((s) => !s.armed && ![ed.id, lab.id].includes(s.post_id) && s.canClaim);
log(Boolean(plain), 'a post that needs no training still can', plain?.post_name);
const refused = await call(`/shifts/${edOpen.id}/claim`, { token: marcus, method: 'POST' });
log(refused.status === 409 && /site training/i.test(refused.data.error), 'claiming it is refused, saying what to do', refused.data.error);

/* ==================================================== rostering anyway === */
section('a supervisor rosters a training shift');

// A slot in the next few days when Marcus is free.
let slot = null;
for (let day = 2; day <= 6 && !slot; day++) {
  for (const hour of [1, 9, 13, 17]) {
    const start = new Date();
    start.setDate(start.getDate() + day);
    start.setHours(hour, 0, 0, 0);
    const end = new Date(start.getTime() + 4 * 3600000);
    const c = await call(`/admin/shifts/candidates?postId=${ed.id}&startsAt=${encodeURIComponent(start.toISOString())}&endsAt=${encodeURIComponent(end.toISOString())}`, { token: supervisor });
    const m = c.data?.candidates?.find((x) => x.user_id === marcusId);
    if (m && m.reasons.every((r) => r.code === 'not_trained')) { slot = { start, end, list: c.data.candidates, m }; break; }
  }
}
log(Boolean(slot), 'found a time Marcus is free');
log(slot.m.eligible && slot.m.training === 'untrained' && slot.m.reasons[0].advisory,
  'he is offered for the shift, marked not trained there - a warning, not a block');
const firstTrained = slot.list.findIndex((x) => x.training === 'trained' && x.eligible);
const marcusAt = slot.list.findIndex((x) => x.user_id === marcusId);
log(firstTrained >= 0 && firstTrained < marcusAt, 'and officers trained there are suggested ahead of him');

const created = await call('/admin/shifts', {
  token: supervisor,
  method: 'POST',
  body: { userId: marcusId, postId: ed.id, startsAt: slot.start.toISOString(), endsAt: slot.end.toISOString(), notes: 'Training shift' },
});
log(created.status === 201 && created.data.warnings.some((w) => w.code === 'not_trained'), 'the shift is made, with the warning');
const shiftId = created.data.shift?.id;
log((await alertsFor()).some((a) => a.key === `training:${shiftId}:${marcusId}`), 'and it is in the alerts inbox');
log((await call('/admin/dashboard', { token: supervisor })).data.counts.untrainedRostered >= 1, 'and counted for the sidebar');
const mine = (await call('/site-training/mine', { token: marcus })).data;
log(mine.training_shifts.some((s) => s.shift_id === shiftId), 'Marcus sees it is a training shift');

/* ========================================================== signing off === */
section('signing off');

const signOff = (body, token = supervisor) => call('/site-training', { token, method: 'POST', body });
log((await signOff({ postId: ed.id, userId: marcusId, method: 'shadow_shift' })).status === 422, 'a shadow shift says who they shadowed');
log((await signOff({ postId: ed.id, userId: supervisorId, method: 'walkthrough' })).status === 403, 'nobody signs off their own training');
log((await signOff({ postId: ed.id, userId: marcusId, method: 'walkthrough' }, marcus)).status === 403, 'officers cannot sign anyone off');
const signed = await signOff({ postId: ed.id, userId: marcusId, method: 'shadow_shift', note: `Shadowed ${ed.trained[0].officer} on nights.` });
log(signed.status === 201 && signed.data.qualification.state === 'trained' && signed.data.qualification.method === 'shadow_shift',
  'a supervisor signs Marcus off at the ED');
log((await signOff({ postId: ed.id, userId: marcusId, method: 'walkthrough' })).status === 409, 'signing him off again changes nothing');
log(!(await alertsFor()).some((a) => a.key === `training:${shiftId}:${marcusId}`), 'the alert goes');
const openNow = (await call('/shifts/open', { token: marcus })).data.shifts.find((s) => s.id === edOpen.id);
log(openNow && !openNow.eligibility.some((r) => r.code === 'not_trained'), 'and he could claim a shift there now');
const cleared = (await call('/site-training/mine', { token: marcus })).data.posts.find((p) => p.post_id === ed.id);
log(cleared?.state === 'trained' && cleared.signed_off_by_name, 'his profile lists the post, and who signed him off');

const d = await signOff({ postId: garage.id, userId: darnell.user_id, method: 'prior_experience' });
log(d.status === 201, `${darnell.officer} is signed off at the garage after his shifts there`);
const after = (await call('/site-training', { token: supervisor })).data.posts.find((p) => p.id === garage.id);
log(!after.ready.length && !after.rostered.some((r) => r.user_id === darnell.user_id), 'and leaves the waiting list and the roster flags');
const a = await signOff({ postId: lab.id, userId: alexis.user_id, method: 'walkthrough', note: 'Refresher with the site lead.' });
log(a.status === 200 && a.data.qualification.state === 'trained', 'a refresher signs a lapsed officer off again');
const r = await signOff({ postId: warehouse.id, userId: raymond.user_id, method: 'shadow_shift', note: 'Shadow shift with Victor.' });
log(r.status === 200 && r.data.qualification.state === 'trained' && !r.data.qualification.revoke_reason, 'and withdrawn training can be given back');

/* ========================================================= withdrawing === */
section('withdrawing it');

const qid = signed.data.qualification.id;
log((await call(`/site-training/${qid}/revoke`, { token: supervisor, method: 'POST', body: { reason: 'No' } })).status === 422, 'withdrawing it needs a reason');
const reason = 'Left the ambulance bay doors propped open on a night shift.';
const revoked = await call(`/site-training/${qid}/revoke`, { token: supervisor, method: 'POST', body: { reason } });
log(revoked.status === 200 && revoked.data.qualification.state === 'revoked', 'a supervisor withdraws Marcus\'s training');
log(revoked.data.upcoming.some((s) => s.id === shiftId), 'and is told which of his shifts there it affects');
log((await call(`/site-training/${qid}/revoke`, { token: supervisor, method: 'POST', body: { reason } })).status === 409, 'it cannot be withdrawn twice');
log((await call(`/shifts/${edOpen.id}/claim`, { token: marcus, method: 'POST' })).status === 409, 'he cannot claim shifts there again');
const own = (await call('/site-training/mine', { token: marcus })).data.posts.find((p) => p.post_id === ed.id);
log(own?.state === 'revoked' && own.revoke_reason === reason, 'and his profile says it was withdrawn, and why');
log((await alertsFor()).some((a) => a.key === `training:${shiftId}:${marcusId}`), 'his shift there is flagged again');

/* ======================================================= the post itself === */
section('which posts need it');

log((await call(`/admin/posts/${ed.id}`, { token: supervisor, method: 'PATCH', body: { trainingRequired: false } })).status === 403,
  'only an administrator changes whether a post needs it');
const off = await call(`/admin/posts/${ed.id}`, { token: admin, method: 'PATCH', body: { trainingRequired: false } });
log(off.status === 200 && off.data.post.training_required === false, 'an administrator can turn it off');
const freed = (await call('/shifts/open', { token: marcus })).data.shifts.find((s) => s.id === edOpen.id);
log(freed && !freed.eligibility.some((r) => r.code === 'not_trained'), 'and then anyone can take shifts there');
const on = await call(`/admin/posts/${ed.id}`, { token: admin, method: 'PATCH', body: { trainingRequired: true } });
log(on.status === 200 && on.data.post.training_required === true, 'and turn it back on');

const people = await call(`/site-training/posts/${ed.id}`, { token: supervisor });
log(people.status === 200 && people.data.people.some((p) => p.user_id === marcusId && p.state === 'revoked') &&
  people.data.people[0].shifts_here >= people.data.people[people.data.people.length - 1].shifts_here,
  "one post's page lists everyone, those who know it best first");

log((await call(`/admin/shifts/${shiftId}`, { token: supervisor, method: 'DELETE' })).status === 200, 'the training shift is taken off the roster again');

const audit = (await call('/admin/audit?limit=300', { token: admin })).data?.entries || [];
const actions = new Set(audit.map((e) => e.action));
log(['training.signed_off', 'training.revoked'].every((x) => actions.has(x)), 'sign-offs and withdrawals are audited');

finish('Site training');
