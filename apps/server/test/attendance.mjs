/**
 * Late and no-show alerts, through the API, on the demo data.
 *
 * Vince has texts on to a confirmed number. A supervisor adds their own
 * number, proves it with the code, and from then on gets the texts too. A
 * shift that started 35 minutes ago with nobody clocked in is a no-show: one
 * text, "no-show", not "late" and then "no-show". Given to another officer,
 * it is covered, and everyone told of the no-show hears that too. One ten
 * minutes late is texted only to those who asked to hear of late starts.
 *
 * Officers can say so first: one running late is told to those who asked for
 * late starts, once; one calling off has the shift taken off them and opened,
 * everyone hears at once, and again when it is covered.
 *
 * No text provider is configured in the suites, so every text lands in the
 * outbox as 'skipped' and the verification code comes back on screen.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const vince = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const client = (await call('/client/login', { method: 'POST', body: { email: 'carla.mendez@harborviewhealth.org', password: 'harborview-portal-04' } })).data?.token;
log(Boolean(vince && supervisor && marcus && client), 'signed in as the administrator, a supervisor, an officer and a client');
const MIN = 60000;
const SUITE = new Set(['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008']);

/* ============================================================ the board === */
section('the board');

const board = await call('/attendance', { token: vince });
log(board.status === 200 && Array.isArray(board.data.open) && Array.isArray(board.data.events), 'supervisors and administrators see the board',
  JSON.stringify(board.data.counts));
log((await call('/attendance', { token: marcus })).status === 403, 'officers do not');
log((await call('/attendance', { token: client })).status === 401, 'nor do clients');
log(board.data.rules.lateGraceMinutes === 7 && board.data.rules.noShowMinutes === 30, 'late after 7 minutes, a no-show after 30');
const noShow = board.data.open.find((o) => o.state === 'no_show');
log(Boolean(noShow) && noShow.timeline.map((t) => t.stage).join('>') === 'late>no_show', 'an officer who never turned up is a no-show, after being late',
  noShow && `${noShow.officer} at ${noShow.post_name}`);
const covered = board.data.resolved.find((o) => o.state === 'covered');
log(Boolean(covered?.covered_from) && covered.minutes_late > 0, 'this morning a no-show was covered by another officer', covered && `${covered.officer} for ${covered.covered_from}`);
// Who turned up late depends on the hour the demo is loaded; the covered
// shift's cover, who got there 55 minutes in, is always there.
log(board.data.resolved.some((o) => (o.state === 'arrived' || o.state === 'covered') && o.minutes_late > 7),
  'and who turned up late is listed with how late');
log(board.data.open[0]?.state === 'no_show', 'no-shows first');

const me = board.data.settings;
log(me.sms_enabled && me.phone === '(904) 555-0100' && me.phone_verified && me.on_late && me.on_no_show && me.on_update,
  'Vince has texts on, to a confirmed number, for all three', me.phone);
log(me.provider.configured === false, 'no text provider in the suites');
const toVince = board.data.texts.filter((t) => t.to_name === 'Vince Ortega');
log(toVince.length > 0 && toVince.every((t) => t.to === '•••• 0100' && t.status === 'skipped'), 'Vince\'s texts are in the outbox, number masked, skipped without a provider',
  `${toVince.length} texts`);
log(toVince.some((t) => /^USC NO-SHOW: /.test(t.body)) && toVince.some((t) => /is covered/.test(t.body)), 'including a no-show and a covered');
log(board.data.events.every((e, i, all) => i === 0 || all[i - 1].id > e.id), 'updates newest first');
const lastId = board.data.events[0]?.id || 0;
const since = await call(`/attendance?since=${lastId}`, { token: vince });
log(since.status === 200 && since.data.events.every((e) => e.id > lastId), 'and ?since= gives only the newer ones, for the live feed');

/* =================================================== a supervisor's own phone === */
section("a supervisor's settings");

let mine = (await call('/attendance/settings', { token: supervisor })).data.settings;
log(!mine.saved && mine.push_enabled && !mine.sms_enabled && !mine.on_late && mine.on_no_show && mine.on_update,
  'with nothing saved: no-shows and what follows, by push, no texts');
log((await call('/attendance/settings', { token: marcus })).status === 403, 'officers have no alert settings here');
const on = { smsEnabled: true, pushEnabled: true, onLate: false, onNoShow: true, onUpdate: true };
const early = await call('/attendance/settings', { token: supervisor, method: 'PUT', body: on });
log(early.status === 409, 'texts cannot go on before there is a confirmed number', early.data?.error);
log((await call('/attendance/settings/phone', { token: supervisor, method: 'POST', body: { phone: '555-01' } })).status === 422, 'a number that is not a phone number is refused');
const asked = await call('/attendance/settings/phone', { token: supervisor, method: 'POST', body: { phone: '(904) 555-0142' } });
log(asked.status === 201 && /^\d{6}$/.test(asked.data.code || '') && asked.data.settings.pending_phone === '(904) 555-0142',
  'a code is sent to the new number (and shown, with no provider to text it)');
const wrong = asked.data.code === '000000' ? '111111' : '000000';
const outbox = (await call('/attendance', { token: vince })).data.texts.find((t) => t.kind === 'verify_phone' && t.to === '•••• 0142');
log(Boolean(outbox) && !outbox.body.includes(asked.data.code) && /••••••/.test(outbox.body), 'the outbox keeps the text, but never the code in it');
log((await call('/attendance/settings/phone/verify', { token: supervisor, method: 'POST', body: { code: wrong } })).status === 422, 'the wrong code is refused');
const verified = await call('/attendance/settings/phone/verify', { token: supervisor, method: 'POST', body: { code: asked.data.code } });
mine = verified.data.settings;
log(verified.status === 200 && mine.phone === '(904) 555-0142' && mine.phone_verified && mine.sms_enabled, 'the right one confirms the number, and turns texts on');
log((await call('/attendance/settings/phone/verify', { token: supervisor, method: 'POST', body: { code: asked.data.code } })).status === 409, 'a code works once');
const test = await call('/attendance/settings/test', { token: supervisor, method: 'POST' });
log(test.status === 201 && test.data.sent === false && test.data.reason === 'not-configured', 'a test text is recorded, and says why it did not go');
const saved = await call('/attendance/settings', { token: supervisor, method: 'PUT', body: on });
log(saved.status === 200 && saved.data.settings.saved && !saved.data.settings.on_late, 'settings saved: no-shows and updates, not every late start');

/* ============================================= a no-show, then covered === */
section('a shift with nobody there');

// A post with three officers free and clear of every rule for a shift that
// started 35 minutes ago.
const start = new Date(Math.floor((Date.now() - 35 * MIN) / MIN) * MIN);
const end = new Date(start.getTime() + 6 * 60 * MIN);
const posts = (await call('/reference', { token: vince })).data.posts;
let post = null;
let trio = [];
for (const p of posts.slice(0, 40)) {
  const c = await call(`/admin/shifts/candidates?postId=${p.id}&startsAt=${encodeURIComponent(start.toISOString())}&endsAt=${encodeURIComponent(end.toISOString())}`, { token: vince });
  trio = (c.data?.candidates || []).filter((x) => x.eligible && !x.reasons.length && x.role === 'officer' && !SUITE.has(x.employee_code)).slice(0, 3);
  if (trio.length === 3) { post = p; break; }
}
log(Boolean(post), 'a post and three officers free then', post && `${post.name}: ${trio.map((x) => x.name).join(', ')}`);
const [missing, cover, slow] = trio;
const created = await call('/admin/shifts', {
  token: vince, method: 'POST',
  body: { postId: post.id, userId: missing.user_id, startsAt: start.toISOString(), endsAt: end.toISOString(), notes: 'Late and no-show suite.' },
});
log(created.status === 201, 'a shift that started 35 minutes ago, nobody clocked in', created.data?.error);
const shiftId = created.data.shift.id;

const after = await call(`/attendance?since=${lastId}`, { token: vince });
const here = after.data.open.find((o) => o.shift_id === shiftId);
const stages = after.data.events.filter((e) => e.shift_id === shiftId);
const textsFor = (data, re, name) => data.texts.filter((t) => re.test(t.body) && t.body.includes(name));
log(here?.state === 'no_show' && here.minutes_late >= 35, 'the board has it as a no-show', here && `${here.minutes_late} min`);
log(stages.map((e) => e.stage).sort().join(',') === 'late,no_show', 'both stages are recorded');
log(stages.find((e) => e.stage === 'no_show')?.notified && !stages.find((e) => e.stage === 'late')?.notified, 'only the latest is sent');
const sent = textsFor(after.data, /^USC NO-SHOW: /, missing.name);
log(sent.some((t) => t.to === '•••• 0100') && sent.some((t) => t.to === '•••• 0142'), 'a no-show text to Vince and to the supervisor', sent[0]?.body);
log(sent.length === 2 && textsFor(after.data, /^USC late: /, missing.name).length === 0, 'and no "late" text before it, nor to anyone else');
log((sent[0]?.body || '').includes(post.name) && /Find cover/.test(sent[0]?.body || ''), 'it says where, and to find cover');

const again = await call('/attendance', { token: vince });
log(textsFor(again.data, /^USC (NO-SHOW|late): /, missing.name).length === 2, 'looking again sends nothing more');

const moved = await call(`/admin/shifts/${shiftId}`, { token: vince, method: 'PATCH', body: { userId: cover.user_id } });
log(moved.status === 200, `the shift is given to ${cover.name}`, moved.data?.error);
const cov = await call('/attendance', { token: vince });
const c = cov.data.open.find((o) => o.shift_id === shiftId);
log(c?.state === 'covering' && c.covered_from === missing.name && c.officer === cover.name, 'the board shows cover on the way');
log(!cov.data.events.some((e) => e.shift_id === shiftId && e.user_id === cover.user_id), 'the cover is not counted late from the original start');
const coverTexts = textsFor(cov.data, /is covered/, cover.name);
log(coverTexts.some((t) => t.to === '•••• 0100') && coverTexts.some((t) => t.to === '•••• 0142'), 'and everyone told of the no-show hears it is covered', coverTexts[0]?.body);

section('a shift ten minutes late');
const lateStart = new Date(Math.floor((Date.now() - 10 * MIN) / MIN) * MIN);
const lateShift = await call('/admin/shifts', {
  token: vince, method: 'POST',
  body: { postId: post.id, userId: slow.user_id, startsAt: lateStart.toISOString(), endsAt: new Date(lateStart.getTime() + 4 * 60 * MIN).toISOString(), notes: 'Late and no-show suite.' },
});
// The post already has the no-show's shift on it, so this one is a second officer there.
log(lateShift.status === 201, 'a second officer at the post, due ten minutes ago', lateShift.data?.error);
const lateId = lateShift.data.shift.id;
const l = await call('/attendance', { token: vince });
log(l.data.open.find((o) => o.shift_id === lateId)?.state === 'late', 'is late on the board');
const lateTexts = textsFor(l.data, /^USC late: /, slow.name);
log(lateTexts.length === 1 && lateTexts[0].to === '•••• 0100', 'Vince is texted; the supervisor, who only wants no-shows, is not', lateTexts[0]?.body);
const inbox = (await call('/admin/alerts', { token: supervisor })).data.alerts;
const lateAlert = inbox.find((a) => a.kind === 'late' && a.link === `/admin/attendance?shift=${lateId}`);
log(Boolean(lateAlert), 'it is in the alerts inbox, opening on the board', lateAlert?.title);
log(inbox.some((a) => a.kind === 'flag' && /^No.show/i.test(a.title) && a.link.startsWith('/admin/attendance')), 'and so is a no-show from today');

for (const id of [shiftId, lateId]) {
  log((await call(`/admin/shifts/${id}`, { token: vince, method: 'DELETE' })).status === 200, `shift ${id} is taken off again`);
}
const gone = (await call('/attendance', { token: vince })).data;
log(!gone.open.some((o) => o.shift_id === shiftId || o.shift_id === lateId), 'and both are gone from the board');

/* ====================================== the officer says so before it happens === */
section('running late, and calling off');
const pinFor = (code) => String(((Number(code) * 7919) % 9000) + 1000);
// Officers free for a window, signed in as themselves.
async function officersFor(from, to, count, skip = []) {
  for (const p of posts.slice(0, 40)) {
    const c = await call(`/admin/shifts/candidates?postId=${p.id}&startsAt=${encodeURIComponent(from.toISOString())}&endsAt=${encodeURIComponent(to.toISOString())}`, { token: vince });
    const found = [];
    for (const x of (c.data?.candidates || []).filter((x) => x.eligible && !x.reasons.length && x.role === 'officer' && !SUITE.has(x.employee_code) && !skip.includes(x.user_id))) {
      const token = await signIn(x.employee_code, pinFor(x.employee_code));
      if (token) found.push({ ...x, token });
      if (found.length === count) return { post: p, people: found };
    }
  }
  return { post: null, people: [] };
}
const soon = new Date(Math.ceil((Date.now() + 30 * MIN) / MIN) * MIN);
const r = await officersFor(soon, new Date(soon.getTime() + 6 * 60 * MIN), 1);
const rita = r.people[0];
log(Boolean(rita), 'an officer with a shift starting in half an hour', rita?.name);
const ritaShift = (await call('/admin/shifts', {
  token: vince, method: 'POST',
  body: { postId: r.post.id, userId: rita.user_id, startsAt: soon.toISOString(), endsAt: new Date(soon.getTime() + 6 * 60 * MIN).toISOString(), notes: 'Late and no-show suite.' },
})).data.shift.id;
const offered = await call('/heads-up', { token: rita.token });
log(offered.status === 200 && offered.data.shift?.id === ritaShift && offered.data.reasons.length === 4, 'their home screen offers it, with the reasons to call off');
log((await call('/heads-up', { token: client })).status === 401, 'clients have nothing to say here');
log((await call(`/heads-up/${ritaShift}/running-late`, { token: rita.token, method: 'POST', body: { etaMinutes: 10 } })).status === 422, 'arriving before the start is not late');
log((await call(`/heads-up/${ritaShift}/running-late`, { token: marcus, method: 'POST', body: { etaMinutes: 50 } })).status === 409, "nor can anyone else say it for them");
const ran = await call(`/heads-up/${ritaShift}/running-late`, { token: rita.token, method: 'POST', body: { etaMinutes: 45, note: 'Bridge is up' } });
log(ran.status === 201 && ran.data.notice.minutes_late === 15, 'they say they will be fifteen minutes late', ran.data?.error);
log((await call(`/heads-up/${ritaShift}/running-late`, { token: rita.token, method: 'POST', body: { etaMinutes: 60 } })).status === 409, 'once; if it changes again, they call');
const heard = await call('/attendance', { token: vince });
const ritaTexts = textsFor(heard.data, /^USC heads-up: /, rita.name);
log(ritaTexts.length === 1 && ritaTexts[0].to === '•••• 0100' && /Bridge is up/.test(ritaTexts[0].body), 'Vince, who asked for late starts, is told now; the supervisor is not', ritaTexts[0]?.body);
const ritaRow = heard.data.open.find((o) => o.shift_id === ritaShift);
log(ritaRow?.state === 'running_late' && ritaRow.notice?.note === 'Bridge is up', 'the board shows them running late before the shift starts');
log((await call('/heads-up', { token: rita.token })).data.notice?.kind === 'running_late', 'and their home screen shows what they said');

const later = new Date(Math.ceil((Date.now() + 3 * 60 * MIN) / MIN) * MIN);
const k = await officersFor(later, new Date(later.getTime() + 6 * 60 * MIN), 2, [rita.user_id]);
const [nick, sub] = k.people;
log(Boolean(nick && sub), 'an officer due on in three hours, and another free then', nick && `${nick.name}, ${sub?.name}`);
const nickShift = (await call('/admin/shifts', {
  token: vince, method: 'POST',
  body: { postId: k.post.id, userId: nick.user_id, startsAt: later.toISOString(), endsAt: new Date(later.getTime() + 6 * 60 * MIN).toISOString(), notes: 'Late and no-show suite.' },
})).data.shift.id;
log((await call(`/heads-up/${nickShift}/call-off`, { token: nick.token, method: 'POST', body: { reason: 'other' } })).status === 422, "'something else' needs a few words");
const off = await call(`/heads-up/${nickShift}/call-off`, { token: nick.token, method: 'POST', body: { reason: 'family', note: 'My daughter is in the ER' } });
log(off.status === 201 && off.data.notice.reason_label === 'Family emergency', 'they call off: a family emergency', off.data?.error);
log((await call('/heads-up', { token: nick.token })).data.shift?.id !== nickShift, 'the shift is no longer theirs');
log((await call('/shifts/open', { token: marcus })).data.shifts.some((x) => x.id === nickShift), 'it is open for other officers to claim');
const told = await call('/attendance', { token: vince });
const offTexts = textsFor(told.data, /^USC CALL-OFF: /, nick.name);
log(offTexts.some((t) => t.to === '•••• 0100') && offTexts.some((t) => t.to === '•••• 0142'), 'Vince and the supervisor are texted at once', offTexts[0]?.body);
log(told.data.open.find((o) => o.shift_id === nickShift)?.state === 'called_off', 'the board has it as called off, needing cover');
const callOffAlert = (await call('/admin/alerts', { token: supervisor })).data.alerts.find((a) => a.link === `/admin/attendance?shift=${nickShift}`);
log(callOffAlert?.severity === 'critical' && /called off/.test(callOffAlert.title), 'and it is a critical alert until it is covered', callOffAlert?.title);
log((await call('/admin/dashboard', { token: supervisor })).data.counts.calledOff >= 1, 'counted on the dashboard');
const given = await call(`/admin/shifts/${nickShift}`, { token: vince, method: 'PATCH', body: { userId: sub.user_id } });
log(given.status === 200, `a supervisor gives it to ${sub.name}`, given.data?.error);
const afterCover = await call('/attendance', { token: vince });
const coverText = textsFor(afterCover.data, /is covered/, sub.name);
log(coverText.some((t) => t.to === '•••• 0100') && coverText.some((t) => t.to === '•••• 0142'), 'and both hear it is covered', coverText[0]?.body);
log(afterCover.data.open.find((o) => o.shift_id === nickShift)?.state === 'covering', 'the board shows the cover');
for (const id of [ritaShift, nickShift]) await call(`/admin/shifts/${id}`, { token: vince, method: 'DELETE' });

/* ===================================================== removing the number === */
section('removing the number');
const removed = await call('/attendance/settings/phone', { token: supervisor, method: 'DELETE' });
log(removed.status === 200 && !removed.data.settings.phone && !removed.data.settings.sms_enabled, 'the supervisor takes their number off, and texts stop');
log((await call('/attendance/settings/test', { token: supervisor, method: 'POST' })).status === 409, 'so there is nothing to test');

finish('Late and no-show alerts');
