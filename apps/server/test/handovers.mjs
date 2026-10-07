/**
 * Shift handovers, through the API, on the demo data.
 *
 * The demo holds one officer over for a relief who confirmed and has not
 * come, and another whose relief called out, leaving the post uncovered.
 * Supervisors see both on the board and in the alerts inbox, and chase the
 * late relief; each officer sees their own side of it.
 *
 * Both are set up from whoever is on duty when the seed runs. In the first
 * hours of a payroll week nobody has been on long enough, so those checks are
 * skipped and say so.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const admin = await signIn('1001', '2468');
const client = (await call('/client/login', { method: 'POST', body: { email: 'carla.mendez@harborviewhealth.org', password: 'harborview-portal-04' } })).data?.token;
log(Boolean(supervisor && marcus && admin && client), 'signed in as a supervisor, an officer, an administrator and a client');

// The demo's own officers sign in with a PIN worked out from their code.
const pinFor = (code) => String(((Number(code) * 7919) % 9000) + 1000);

/* ============================================================ the board === */
section('the board');

const board = await call('/handovers', { token: supervisor });
log(board.status === 200 && Array.isArray(board.data.handovers) && board.data.window_minutes === 120,
  'supervisors see the handovers in the next two hours', `${board.data.handovers?.length}`);
log((await call('/handovers', { token: marcus })).status === 403, 'officers do not');
log((await call('/handovers', { token: client })).status === 401, 'nor do clients');
log((await call('/handovers?window=5', { token: supervisor })).status === 422, 'the window is at least half an hour');
const wide = await call('/handovers?window=480', { token: supervisor });
log(wide.status === 200 && wide.data.handovers.length >= board.data.handovers.length, 'and can look further ahead');
const ranks = board.data.handovers.map((h) => ['late', 'open', 'unconfirmed', 'confirmed', 'relieved', 'closes'].indexOf(h.state));
log(ranks.every((r, i) => i === 0 || ranks[i - 1] <= r), 'worst first');

const late = board.data.handovers.find((h) => h.state === 'late');
const open = board.data.handovers.find((h) => h.state === 'open');
const alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
const dash = (await call('/admin/dashboard', { token: supervisor })).data.counts;
log(typeof dash.handoversAtRisk === 'number' && dash.handoversAtRisk === board.data.counts.at_risk, 'the sidebar counts the ones at risk', `${dash.handoversAtRisk}`);

if (!late || !open) {
  console.log('SKIP  nobody on duty at this hour fits the demo holdovers, so they were not seeded');
} else {
  log(late.held_over_minutes >= 20 && late.relief.confirmed && late.relief.minutes_late >= 20 && late.relief.phone,
    `${late.officer} is held over at ${late.post_name}: ${late.relief.officer} confirmed and has not come`, `${late.held_over_minutes} min`);
  log(open.relief && open.relief.user_id === null && open.held_over_minutes > 0, `${open.officer} is held over with nobody assigned after them`);
  log(alerts.some((a) => a.kind === 'handover' && a.key === `handover:${late.shift_id}:late` && a.severity === 'critical'), 'both are in the alerts inbox, as critical');
  log(alerts.some((a) => a.kind === 'handover' && a.key === `handover:${open.shift_id}:open`), 'the uncovered one too');
  log(!(await call('/shifts/open', { token: marcus })).data.shifts.some((s) => s.id === open.relief.shift_id),
    'the uncovered shift has started, so it is not offered as an open shift to claim');

  /* ========================================================== chasing === */
  section('chasing the relief');

  const chase = (shiftId, token = supervisor, body = {}) => call(`/handovers/${shiftId}/chase`, { token, method: 'POST', body });
  log((await chase(late.shift_id, marcus)).status === 403, 'officers cannot chase');
  log((await chase(999999)).status === 404, 'a handover not on the board is not found');
  log((await chase(open.shift_id)).status === 409, 'with nobody assigned, there is nobody to chase: find cover');
  const chased = await chase(late.shift_id, supervisor, { note: 'The post has been waiting since the handover. Where are you?' });
  log(chased.status === 200 && chased.data.handover.relief.chased_at, 'the supervisor chases the late relief');
  const again = await chase(late.shift_id, admin);
  log(again.status === 409 && /chased/.test(again.data.error), 'and nobody chases them again for a few minutes', again.data?.error);
  const after = (await call('/handovers', { token: supervisor })).data.handovers.find((h) => h.shift_id === late.shift_id);
  log(Boolean(after?.relief.chased_at), 'the board shows when they were chased');
  const audit = (await call('/admin/audit?limit=100', { token: admin })).data?.entries || [];
  log(audit.some((e) => e.action === 'handover.chased'), 'and it is audited');

  /* ========================================================= officers === */
  section('the officers');

  const outgoing = await signIn(late.employee_code, pinFor(late.employee_code));
  const relief = await signIn(late.relief.employee_code, pinFor(late.relief.employee_code));
  log(Boolean(outgoing && relief), 'signed in as the held-over officer and the late relief');
  const mineOut = (await call('/handovers/mine', { token: outgoing })).data;
  log(mineOut.outgoing?.state === 'late' && mineOut.outgoing.relief.officer === late.relief.officer && !mineOut.incoming,
    'the held-over officer sees who is coming, and that they are late');
  log(!mineOut.outgoing.phone && !mineOut.outgoing.relief.phone, "without anyone's phone number");
  const mineIn = (await call('/handovers/mine', { token: relief })).data;
  log(mineIn.incoming?.shift_id === late.shift_id && mineIn.incoming.officer === late.officer && !mineIn.outgoing,
    'the relief sees whose post they are taking over');
}

const mine = (await call('/handovers/mine', { token: marcus })).data;
log(mine && 'outgoing' in mine && 'incoming' in mine, 'every officer can ask for theirs');
log((await call('/handovers/mine', { token: client })).status === 401, 'clients cannot');

finish('Shift handovers');
