/**
 * Open-shift claiming, swaps and drops - including the eligibility rules that
 * keep an unlicensed officer off an armed post.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const marcus = await signIn('1003', '4812'); // Class D, Riverfront
const dwayne = await signIn('1005', '6174'); // Class G, armed post
const janelle = await signIn('1004', '5930'); // Class D, Palmetto
const admin = await signIn('1001', '2468');

log(Boolean(marcus && dwayne && janelle && admin), 'signed in as four people');

/* ================================================= open shift listing === */
section('open shifts & eligibility');

const openForMarcus = await call('/shifts/open', { token: marcus });
log(
  openForMarcus.status === 200 && openForMarcus.data.shifts.length >= 2,
  'open shifts listed',
  `${openForMarcus.data?.shifts?.length} available`
);

const armedShift = openForMarcus.data.shifts.find((s) => s.armed);
// An unarmed one both Marcus and Janelle can ask for, as they compete for it
// below. The demo also has a shift called off sick a few hours from now,
// which, depending on the hour, may clash with either one's roster.
const openForJanelle = await call('/shifts/open', { token: janelle });
const janelleCan = new Set(openForJanelle.data.shifts.filter((s) => s.canClaim).map((s) => s.id));
const unarmedShift = openForMarcus.data.shifts.find((s) => !s.armed && s.canClaim && janelleCan.has(s.id))
  || openForMarcus.data.shifts.find((s) => !s.armed);
log(!!armedShift && !!unarmedShift, 'both an armed and an unarmed open shift exist');

// The rule that matters: a Class D officer cannot take an armed post.
log(
  armedShift?.canClaim === false &&
    armedShift.eligibility.some((r) => r.code === 'no_armed_licence' || r.code === 'expired_armed_licence'),
  'Class D officer is blocked from the armed post',
  armedShift?.eligibility?.[0]?.message
);
log(unarmedShift?.canClaim === true, 'the same officer can claim the unarmed post');

const openForDwayne = await call('/shifts/open', { token: dwayne });
const armedForDwayne = openForDwayne.data.shifts.find((s) => s.armed);
log(armedForDwayne?.canClaim === true, 'Class G officer can claim the armed post');

/* ============================================================= claim ==== */
section('claiming an open shift');

const blockedClaim = await call(`/shifts/${armedShift.id}/claim`, { token: marcus, method: 'POST' });
log(blockedClaim.status === 409, 'claiming an armed post without Class G is refused', blockedClaim.data?.error);

const claim = await call(`/shifts/${unarmedShift.id}/claim`, {
  token: marcus,
  method: 'POST',
  body: { note: 'Happy to cover this one.' },
});
log(claim.status === 201, 'open shift claimed', `request ${claim.data?.request?.id}`);

const duplicate = await call(`/shifts/${unarmedShift.id}/claim`, { token: marcus, method: 'POST' });
log(duplicate.status === 409, 'the same officer cannot claim twice', duplicate.data?.error);

// A second officer wants the same shift; only one can have it.
const rivalClaim = await call(`/shifts/${unarmedShift.id}/claim`, { token: janelle, method: 'POST' });
log(rivalClaim.status === 201, 'a second officer can also ask for it');

const selfApprove = await call(`/shifts/requests/${claim.data.request.id}`, {
  token: marcus,
  method: 'PATCH',
  body: { status: 'approved' },
});
log(selfApprove.status === 403, 'officers cannot approve their own claim');

const approveClaim = await call(`/shifts/requests/${claim.data.request.id}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'approved', note: 'Yours.' },
});
log(approveClaim.status === 200, 'supervisor approves the claim');

const afterClaim = await call('/schedule', { token: marcus });
log(
  afterClaim.data.shifts.some((s) => s.id === unarmedShift.id),
  'the shift now appears on the claiming officer\'s roster'
);

const rivalAfter = await call('/shifts/requests', { token: janelle });
const rivalRequest = rivalAfter.data.requests.find((r) => r.id === rivalClaim.data.request.id);
log(rivalRequest?.status === 'denied', 'the competing claim was closed automatically', rivalRequest?.decision_note);

const stillOpen = await call('/shifts/open', { token: janelle });
log(
  !stillOpen.data.shifts.some((s) => s.id === unarmedShift.id),
  'a claimed shift leaves the open list'
);

/* ============================================================== swap ==== */
section('swapping an assigned shift');

const janelleRoster = await call('/schedule', { token: janelle });
// One Marcus (user 3) could take on himself: no overlap with his own roster,
// and within the rest and fatigue rules, which the eligibility check applies.
let janelleShift = null;
for (const s of janelleRoster.data.shifts.filter((x) => new Date(x.starts_at) > new Date() && x.status === 'scheduled')) {
  const { reasons } = (await call(`/shifts/eligibility/${s.id}/3`, { token: admin })).data;
  if (!reasons.some((r) => !r.advisory || r.supervisorOnly)) { janelleShift = s; break; }
}
log(!!janelleShift, 'found a future shift to swap', janelleShift && janelleShift.post_name);

const notMine = await call(`/shifts/${janelleShift.id}/swap`, {
  token: marcus,
  method: 'POST',
  body: { targetUserId: 4 },
});
log(notMine.status === 403, 'you cannot swap away a shift that is not yours');

const swapToSelf = await call(`/shifts/${janelleShift.id}/swap`, {
  token: janelle,
  method: 'POST',
  body: { targetUserId: 4 },
});
log(swapToSelf.status === 422, 'you cannot swap a shift to yourself');

const swap = await call(`/shifts/${janelleShift.id}/swap`, {
  token: janelle,
  method: 'POST',
  body: { targetUserId: 3, note: 'Dentist that morning.' },
});
log(swap.status === 201, 'swap offered to another officer', swap.status === 201 ? `request ${swap.data?.request?.id}` : swap.data?.error);

const prematureApproval = await call(`/shifts/requests/${swap.data.request.id}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'approved' },
});
log(prematureApproval.status === 409, 'a supervisor cannot approve before the other officer accepts');

const wrongResponder = await call(`/shifts/requests/${swap.data.request.id}/respond`, {
  token: janelle,
  method: 'POST',
  body: { accept: true },
});
log(wrongResponder.status === 403, 'only the officer asked can respond');

const accept = await call(`/shifts/requests/${swap.data.request.id}/respond`, {
  token: marcus,
  method: 'POST',
  body: { accept: true },
});
log(accept.status === 200 && accept.data.status === 'accepted', 'the other officer accepts');

const approveSwap = await call(`/shifts/requests/${swap.data.request.id}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'approved' },
});
log(approveSwap.status === 200, 'supervisor approves the swap');

const marcusAfterSwap = await call('/schedule', { token: marcus });
log(
  marcusAfterSwap.data.shifts.some((s) => s.id === janelleShift.id),
  'the shift moved to the accepting officer'
);

/* ============================================================== drop ==== */
section('dropping a shift');

const noReason = await call(`/shifts/${janelleShift.id}/drop`, { token: marcus, method: 'POST', body: {} });
log(noReason.status === 422, 'a drop needs a reason');

const drop = await call(`/shifts/${janelleShift.id}/drop`, {
  token: marcus,
  method: 'POST',
  body: { reason: 'Called for jury duty that week.' },
});
log(drop.status === 201, 'drop requested');

const approveDrop = await call(`/shifts/requests/${drop.data.request.id}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'approved', note: 'Reopened for cover.' },
});
log(approveDrop.status === 200, 'supervisor approves the drop');

const reopened = await call('/shifts/open', { token: janelle });
log(
  reopened.data.shifts.some((s) => s.id === janelleShift.id),
  'the dropped shift is open again for anyone to claim'
);

/* ======================================================== supervisors === */
section('supervisor queue');

const queue = await call('/shifts/requests?scope=all', { token: admin });
log(queue.status === 200 && queue.data.requests.length >= 4, 'supervisor sees every request', `${queue.data?.requests?.length}`);

const officerScope = await call('/shifts/requests?scope=all', { token: marcus });
log(
  officerScope.data.requests.every((r) => r.requested_by === 3 || r.target_user_id === 3),
  'an officer only ever sees their own requests'
);

const eligibility = await call(`/shifts/eligibility/${armedShift.id}/3`, { token: admin });
log(
  eligibility.status === 200 && eligibility.data.blocked === true,
  'scheduling screen can check eligibility before assigning',
  eligibility.data?.reasons?.[0]?.message
);

finish('shifts');
