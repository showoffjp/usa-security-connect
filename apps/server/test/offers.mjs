/**
 * Shift offers: an open shift sent to several officers at once.
 *
 * The rules that matter: nobody the eligibility rule blocks is asked; only
 * the officers asked can see or answer an offer; on a first-yes offer the
 * first yes gets the shift and nobody else can; on the other kind a yes is
 * a claim for a supervisor; an offer ends however the shift is filled; and
 * an officer who has since taken another shift at the same time is told
 * they cannot say yes. The suite works on shifts of its own three weeks out
 * and removes them at the end.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const pinFor = (code) => String(((Number(code) * 7919) % 9000) + 1000);
const SUITE_PEOPLE = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008'];

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const client = (await call('/client/login', { method: 'POST', body: { email: 'carla.mendez@harborviewhealth.org', password: 'harborview-portal-04' } })).data?.token;
log(Boolean(admin && supervisor && marcus && client), 'signed in as staff and a client contact');

const posts = (await call('/admin/sites', { token: supervisor })).data.posts.filter((p) => p.active && !p.armed && !p.training_required);
const at = (days, hour) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const made = [];
const newShift = async (postId, days, hour, hours = 4) => {
  const r = await call('/admin/shifts', { token: supervisor, method: 'POST', body: { postId, startsAt: at(days, hour), endsAt: at(days, hour + hours) } });
  made.push(r.data.shift.id);
  return r.data.shift;
};
const s1 = await newShift(posts[0].id, 22, 10);
const s4 = await newShift(posts[1].id, 22, 11); // overlaps s1, elsewhere
const s2 = await newShift(posts[0].id, 23, 10);
const s3 = await newShift(posts[0].id, 24, 10);
log(made.length === 4 && made.every(Boolean), 'four open shifts of the suite’s own, three weeks out');

// Officers outside the scripted suites who can take s1 without a single warning.
const cands = (await call(`/admin/shifts/candidates?postId=${s1.post_id}&startsAt=${encodeURIComponent(s1.starts_at)}&endsAt=${encodeURIComponent(s1.ends_at)}&excludeShiftId=${s1.id}`, { token: supervisor })).data.candidates;
const clear = cands.filter((c) => c.eligible && !c.reasons.length && !SUITE_PEOPLE.includes(c.employee_code));
const [A, B, C, D] = clear;
const tok = {};
for (const p of [A, B, C, D].filter(Boolean)) tok[p.user_id] = await signIn(p.employee_code, pinFor(p.employee_code));
log(clear.length >= 4 && Object.values(tok).every(Boolean), 'four officers who can take it cleanly, signed in', clear.slice(0, 4).map((c) => c.name).join(', '));

const send = (body, token = supervisor) => call('/shift-offers', { token, method: 'POST', body });
const answer = (id, user, ans) => call(`/shift-offers/${id}/answer`, { token: tok[user.user_id] ?? user, method: 'POST', body: { answer: ans } });
const mineOf = async (user, id) => (await call('/shift-offers/mine', { token: tok[user.user_id] ?? user })).data?.offers?.find((o) => o.id === id);
const forShift = async (shift) => (await call(`/shift-offers/shift/${shift.id}`, { token: supervisor })).data.offer;

/* ============================================================ sending === */
section('sending an offer');

log((await send({ shiftId: s1.id, userIds: [A.user_id] }, marcus)).status === 403, 'an officer cannot send one');
log((await call('/shift-offers', { token: marcus })).status === 403, 'nor see the supervisors’ list');
log((await call('/shift-offers/mine', { token: client })).status === 401, 'a client session is not let in at all');
log((await call('/shift-offers/mine')).status === 401, 'nor is anyone signed out');
log((await send({ shiftId: s1.id, userIds: [] })).status === 422, 'an offer has to ask somebody');
log((await send({ shiftId: s1.id, userIds: Array.from({ length: 21 }, (_, i) => i + 1) })).status === 422, 'and at most twenty at once');
const adminId = (await call('/auth/me', { token: admin })).data?.user?.id;
log((await send({ shiftId: s1.id, userIds: [A.user_id, adminId] })).status === 422, 'only active officers can be asked');
// Somebody the rules block: D, once on another shift at the same time.
const busy = (await call('/admin/shifts', { token: supervisor, method: 'POST', body: { postId: posts[2].id, userId: D.user_id, startsAt: s1.starts_at, endsAt: s1.ends_at } })).data.shift;
made.push(busy.id);
const refused = await send({ shiftId: s1.id, userIds: [A.user_id, D.user_id] });
log(refused.status === 409 && refused.data?.details?.code === 'ineligible' && refused.data.details.blocked.map((b) => b.user_id).join() === String(D.user_id),
  'anyone the rules block is refused, by name', refused.data?.error);
log((await forShift(s1)) === null, 'and then nobody at all is asked');
await call(`/admin/shifts/${busy.id}`, { token: supervisor, method: 'DELETE' });

const sent = await send({ shiftId: s1.id, userIds: [A.user_id, B.user_id, C.user_id], note: 'Suite test shift.' });
const o1 = sent.data?.offer;
log(sent.status === 201 && sent.data.asked === 3 && o1.state === 'open' && o1.first_yes === true && o1.counts.waiting === 3,
  'three officers asked, the first yes to take it', JSON.stringify(o1?.counts));
log((await send({ shiftId: s1.id, userIds: [A.user_id] })).status === 409, 'asking the same officer twice is refused');
log((await send({ shiftId: s4.id, userIds: [B.user_id] })).status === 201, 'the same officer can be asked about another shift at the same time');

/* =========================================================== answering === */
section('answering');

const seen = await mineOf(A, o1.id);
log(seen?.state === 'open' && seen.answer === null && seen.can_say_yes === true && seen.asked === 3 && !('recipients' in seen),
  'each officer asked sees it, and how many were asked but never who');
log(!(await mineOf(marcus, o1.id)), 'an officer not asked does not see it');
log((await answer(o1.id, marcus, 'yes')).status === 404, 'and cannot answer it');
log((await answer(o1.id, A, 'maybe')).status === 422, 'an answer is yes or no');

const no = await answer(o1.id, A, 'no');
log(no.status === 200 && no.data.result === 'declined' && no.data.offer.answer === 'no', 'a no is recorded');
log((await forShift(s1)).counts.no === 1, 'and the supervisor sees it');

const yes = await answer(o1.id, B, 'yes');
log(yes.status === 200 && yes.data.result === 'assigned' && yes.data.offer.mine === true && yes.data.offer.state === 'filled',
  'the first yes is given the shift', yes.data?.error);
const after = await forShift(s1);
log(after.state === 'filled' && after.filled_by === B.user_id && after.taken_by === B.name && after.counts.yes === 1,
  'the offer says who took it', `${after.state} ${after.taken_by}`);
const bSchedule = (await call(`/schedule?from=${s1.starts_at.slice(0, 10)}&to=${s3.ends_at.slice(0, 10)}`, { token: tok[B.user_id] })).data.shifts;
const theirs = bSchedule.find((s) => s.id === s1.id);
log(theirs && theirs.confirmed === true, 'it is on their schedule, already confirmed: saying yes was the confirmation');

const late = await answer(o1.id, C, 'yes');
log(late.status === 409 && /taken/i.test(late.data?.error || ''), 'a later yes is told somebody else took it', late.data?.error);
log((await answer(o1.id, A, 'yes')).status === 409, 'and a no cannot be turned into a yes once it has gone');
log((await answer(o1.id, B, 'no')).status === 409, 'nor can the yes be taken back');

const clash = await mineOf(B, (await forShift(s4)).id);
log(clash && clash.can_say_yes === false && /already have a shift at that time/i.test(clash.refusal || ''),
  'an offer they can no longer take says why, in their words', clash?.refusal);
const clashYes = await answer(clash.id, B, 'yes');
log(clashYes.status === 409 && /You cannot take this shift/.test(clashYes.data?.error || ''), 'and a yes to it is refused');

const inbox = (await call('/admin/alerts', { token: supervisor })).data.alerts;
const takenAlert = inbox.find((a) => a.key === `offer-taken:${o1.id}`);
log(takenAlert?.severity === 'info' && takenAlert.title.includes(B.name) && takenAlert.link.includes(`shift=${s1.id}`),
  'the alerts inbox says who took it, and opens the shift', takenAlert?.title);

/* ====================================================== supervisor picks === */
section('when the supervisor picks');

const o2 = (await send({ shiftId: s2.id, userIds: [A.user_id, C.user_id], firstYes: false })).data.offer;
log(o2?.first_yes === false, 'an offer can leave the choice to a supervisor');
const aYes = await answer(o2.id, A, 'yes');
const cYes = await answer(o2.id, C, 'yes');
log(aYes.data?.result === 'claimed' && cYes.data?.result === 'claimed', 'each yes is a claim for a supervisor to approve');
const stillOpen = (await call(`/admin/shifts?from=${encodeURIComponent(s2.starts_at)}&to=${encodeURIComponent(s2.ends_at)}`, { token: supervisor })).data.shifts.find((s) => s.id === s2.id);
log(stillOpen && !stillOpen.user_id, 'and nobody is given the shift until then');
const pending = (await call('/shifts/requests?scope=all&status=pending', { token: supervisor })).data.requests.filter((r) => r.shift_id === s2.id);
log(pending.length === 2 && pending.every((r) => r.kind === 'claim' && r.note === 'Said yes to a shift offer.'), 'both are in the request queue, saying where they came from');
const aClaim = pending.find((r) => r.requested_by === A.user_id);
log((await call(`/shifts/requests/${aClaim.id}`, { token: supervisor, method: 'PATCH', body: { status: 'approved' } })).status === 200, 'the supervisor approves one');
const o2After = await forShift(s2);
log(o2After.state === 'filled' && o2After.filled_by === A.user_id, 'the offer closes, taken by the one approved');
const cClaim = (await call('/shifts/requests?scope=all', { token: supervisor })).data.requests.find((r) => r.id === pending.find((p) => p.requested_by === C.user_id).id);
log(cClaim?.status === 'denied', 'and the other yes is turned down');
const cView = await mineOf(C, o2.id);
log(cView && cView.state === 'filled' && cView.mine === false && cView.answer === 'yes', 'who said yes and did not get it sees how it went');

/* ========================================================= ending early === */
section('asking more, nobody saying yes, withdrawing');

const o3 = (await send({ shiftId: s3.id, userIds: [A.user_id] })).data.offer;
await answer(o3.id, A, 'no');
let stuck = (await call('/admin/alerts', { token: supervisor })).data.alerts.find((a) => a.key === `offer-stuck:${o3.id}:all-no`);
log(stuck && stuck.severity === 'warning' && /Everyone asked said no/.test(stuck.title), 'when everyone asked says no, the alerts inbox says so', stuck?.title);
const more = await send({ shiftId: s3.id, userIds: [A.user_id, C.user_id] });
log(more.status === 201 && more.data.offer.id === o3.id && more.data.asked === 1 && more.data.offer.counts.asked === 2,
  'asking more adds to the same offer, and only the new officer is asked');
stuck = (await call('/admin/alerts', { token: supervisor })).data.alerts.find((a) => a.key.startsWith(`offer-stuck:${o3.id}:`));
log(!stuck, 'with someone yet to answer three weeks out, it is not raised');
const w = await call(`/shift-offers/${o3.id}/withdraw`, { token: supervisor, method: 'POST' });
log(w.status === 200 && w.data.offer.state === 'withdrawn', 'a supervisor can withdraw it');
log((await call(`/shift-offers/${o3.id}/withdraw`, { token: supervisor, method: 'POST' })).status === 409, 'once');
const cLate = await answer(o3.id, C, 'yes');
log(cLate.status === 409 && /withdrawn/.test(cLate.data?.error || ''), 'an answer after that is told it was withdrawn');
log(!(await mineOf(C, o3.id)), 'and it drops off the list of who did not say yes');
const o3b = (await send({ shiftId: s3.id, userIds: [C.user_id, D.user_id] })).data.offer;
log(o3b && o3b.id !== o3.id && o3b.state === 'open', 'a fresh offer can go out after one is withdrawn');
const assigned = await call(`/admin/shifts/${s3.id}`, { token: supervisor, method: 'PATCH', body: { userId: D.user_id } });
log(assigned.status === 200, 'the supervisor gives the shift to somebody directly');
const o3bAfter = await forShift(s3);
log(o3bAfter.state === 'covered' && o3bAfter.taken_by === D.name, 'the offer closes as covered another way');
log((await answer(o3b.id, C, 'yes')).status === 409, 'and a yes after that is refused');
log((await send({ shiftId: s3.id, userIds: [C.user_id] })).status === 409, 'a shift with an officer on it cannot be offered');

/* ============================================================== tidy up === */
for (const id of made) await call(`/admin/shifts/${id}`, { token: supervisor, method: 'DELETE' });
const left = (await call('/shift-offers', { token: supervisor })).data.offers.filter((o) => made.includes(o.shift_id));
log(left.length === 0, 'removing the suite’s shifts removes their offers');

finish('Shift offers');
