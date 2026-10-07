/**
 * Rest and fatigue, through the API, on the demo data.
 *
 * The demo has an officer put on a late event six hours before their next
 * shift, and another working seven days in a row. Supervisors see both on
 * the board. An open shift that would leave Marcus four hours off cannot be
 * claimed by him, but a supervisor can still give it to him, with a warning,
 * and Marcus then sees the short rest on his schedule.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const supervisor = await signIn('1002', '3571');
const admin = await signIn('1001', '2468');
const marcus = await signIn('1003', '4812');
const client = (await call('/client/login', { method: 'POST', body: { email: 'carla.mendez@harborviewhealth.org', password: 'harborview-portal-04' } })).data?.token;
log(Boolean(supervisor && admin && marcus && client), 'signed in as a supervisor, an administrator, an officer and a client');
const marcusId = (await call('/auth/me', { token: marcus })).data?.user?.id;
const H = 3600000;

/* ============================================================ the board === */
section('the board');

const board = await call('/admin/fatigue', { token: supervisor });
log(board.status === 200 && Array.isArray(board.data.shifts) && board.data.days === 7, 'supervisors see the week ahead', `${board.data.shifts?.length} shifts`);
log((await call('/admin/fatigue', { token: marcus })).status === 403, 'officers do not');
log((await call('/admin/fatigue', { token: client })).status === 401, 'nor do clients');
log((await call('/admin/fatigue?days=40', { token: supervisor })).status === 422, 'four weeks ahead at most');
const shortRest = board.data.shifts.find((s) => s.issues.some((i) => i.code === 'short_rest') && s.employee_code !== '1003');
log(Boolean(shortRest) && /6 h off/.test(shortRest.issues.find((i) => i.code === 'short_rest').message),
  'the officer back on six hours after a late event is short of rest', shortRest && `${shortRest.officer}, ${shortRest.post_name}`);
const sevenDays = board.data.shifts.find((s) => s.issues.some((i) => i.code === 'too_many_days'));
log(Boolean(sevenDays), 'and one is working seven days in a row', sevenDays?.officer);
log(board.data.shifts.every((s, i, all) => i === 0 || all[i - 1].starts_at <= s.starts_at), 'soonest first');
const dash = (await call('/admin/dashboard', { token: supervisor })).data.counts;
log(dash.fatigueRisks === board.data.counts.total, 'the sidebar counts them', `${dash.fatigueRisks}`);

/* ================================================= claiming and rostering === */
section('a shift four hours after another');

// One of Marcus's shifts with nothing after it for a day, and an open shift
// at his post starting four hours after it ends.
const mine = (await call('/schedule', { token: marcus })).data.shifts.filter((s) => s.status === 'scheduled' && new Date(s.starts_at) > new Date(Date.now() + 24 * H));
const base = mine.find((s) => !mine.some((o) => o.id !== s.id && new Date(o.starts_at) >= new Date(s.starts_at) && new Date(o.starts_at) - new Date(s.ends_at) < 24 * H));
log(Boolean(base), 'Marcus has a shift with a free day after it', base && base.starts_at);
const start = new Date(new Date(base.ends_at).getTime() + 4 * H);
const created = await call('/admin/shifts', {
  token: supervisor, method: 'POST',
  body: { postId: base.post_id, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 6 * H).toISOString(), notes: 'Fatigue suite: evening cover.' },
});
log(created.status === 201, 'a supervisor posts an open shift four hours after it ends');
const openId = created.data.shift.id;

const open = (await call('/shifts/open', { token: marcus })).data.shifts.find((s) => s.id === openId);
const rest = open?.eligibility.find((r) => r.code === 'short_rest');
log(open && open.canClaim === false && rest && rest.advisory && rest.supervisorOnly, 'Marcus cannot claim it: four hours off is short of rest');
const claim = await call(`/shifts/${openId}/claim`, { token: marcus, method: 'POST' });
log(claim.status === 409 && /4 h off/.test(claim.data.error), 'claiming it anyway is refused, and says why', claim.data?.error);

const elig = await call(`/shifts/eligibility/${openId}/${marcusId}`, { token: supervisor });
log(elig.data.blocked === false && elig.data.reasons.some((r) => r.code === 'short_rest'), 'a supervisor is warned, not stopped');
const cands = await call(`/admin/shifts/candidates?postId=${base.post_id}&startsAt=${encodeURIComponent(start.toISOString())}&endsAt=${encodeURIComponent(new Date(start.getTime() + 6 * H).toISOString())}&excludeShiftId=${openId}`, { token: supervisor });
const him = cands.data.candidates.find((c) => c.user_id === marcusId);
log(him && him.eligible && him.reasons.some((r) => r.code === 'short_rest'), 'the candidate list shows the short rest against his name');

const given = await call(`/admin/shifts/${openId}`, { token: supervisor, method: 'PATCH', body: { userId: marcusId } });
log(given.status === 200 && given.data.warnings.some((w) => w.code === 'short_rest'), 'the supervisor gives it to him anyway, with the warning in front of them');
const after = (await call('/schedule', { token: marcus })).data.shifts.find((s) => s.id === openId);
log(after?.fatigue?.some((f) => f.code === 'short_rest' && /4 h off/.test(f.note)), 'Marcus sees the short rest on his schedule', after?.fatigue?.[0]?.note);
const nowBoard = (await call('/admin/fatigue?days=28', { token: supervisor })).data.shifts.find((s) => s.shift_id === openId);
log(nowBoard?.previous?.shift_id === base.id, 'and it is on the board, after the shift before it');

log((await call(`/admin/shifts/${openId}`, { token: admin, method: 'DELETE' })).status === 200, 'the shift is taken off again');

finish('Rest and fatigue');
