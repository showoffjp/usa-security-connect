/**
 * Correcting where a punch was made.
 *
 * A supervisor or administrator can put a clock-in, clock-out or check-in
 * where it was really made: at the post in one step, or at exact
 * coordinates. Officers and clients cannot; nobody corrects their own; a
 * reason is required; coordinates hundreds of miles off are refused as a
 * typing slip. The punch is judged against its post again: corrected inside
 * the geofence its flag closes, corrected outside it is raised or reopened.
 * The punch log shows each correction with the phone's own reading, and the
 * demo carries one already made. The suite clocks its officer out at the end.
 */

import { call, log, section, signIn, finish, localDay } from './harness.mjs';

const pinFor = (code) => String(((Number(code) * 7919) % 9000) + 1000);
const north = (lat, lng, m) => [Number((lat + m / 111320).toFixed(6)), lng];

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const client = (await call('/client/login', { method: 'POST', body: { email: 'rpike@emeraldcoastlogistics.com', password: 'pensacola-portal-05' } })).data?.token;
log(Boolean(admin && supervisor && marcus && client), 'signed in as staff and a client contact');

const punchLog = async (query = '') =>
  (await call(`/admin/punches?from=${localDay(-6)}&to=${localDay(0)}${query}`, { token: supervisor })).data?.punches || [];
const flagFor = async (type, refId) => {
  const open = (await call(`/admin/flags?type=${type}`, { token: supervisor })).data?.flags || [];
  const closed = (await call(`/admin/flags?type=${type}&resolved=true`, { token: supervisor })).data?.flags || [];
  return [...open, ...closed].find((f) => f.ref_id === refId) || null;
};

/* ====================================================== the demo's one === */
section('the correction already in the demo');

const seeded = (await punchLog('&type=clock_in')).find((p) => p.location_fix);
log(Boolean(seeded), 'the punch log shows a clock-in a supervisor corrected');
log(seeded?.location_fix.by === 'Renata Diaz' && seeded.location_fix.reason.length > 10 && seeded.location_fix.count === 1, 'with who corrected it and why');
log(seeded?.location_fix.original.geofence === 'outside' && seeded.location_fix.original.distance_m > 300 && seeded.location_fix.original.latitude != null,
  "and what the phone first reported, outside the geofence", `${seeded?.location_fix.original.distance_m} m`);
log(seeded?.geofence === 'inside' && seeded.distance_m === 0, 'now at the post');
const seededFlag = seeded ? await flagFor('geofence_violation', seeded.ref_id) : null;
log(Boolean(seededFlag?.resolved_at) && /Location corrected/.test(seededFlag.resolution_note || ''), 'and its flag closed, saying why');

/* ============================================================== who may === */
section('who may correct a location');

const target = `/admin/punches/clock_in/${seeded?.ref_id}/location`;
log((await call(target, { token: marcus })).status === 403, 'officers cannot see the corrections');
log((await call(target, { token: marcus, method: 'POST', body: { atPost: true, reason: 'I was there all along' } })).status === 403, 'nor make one');
log((await call(target, { token: client })).status === 401, 'nor can clients');
const detail = await call(target, { token: supervisor });
log(detail.status === 200 && detail.data.fixes.length === 1 && detail.data.punch.post.latitude != null && detail.data.summary.original.geofence === 'outside',
  'a supervisor sees the punch, its post and its corrections');
log((await call('/admin/punches/break_start/1/location', { token: supervisor })).status === 404, 'a break has no location to correct');
log((await call('/admin/punches/clock_in/999999/location', { token: supervisor })).status === 404, 'nor does a punch that does not exist');

/* ========================================================== a clock-in === */
section('a clock-in the phone put in the wrong place');

const post = ((await call('/admin/sites', { token: admin })).data?.posts || []).find((p) => p.post_code === 'SO-01');
log(post?.latitude != null, 'the Seaside Outlet Mall post has a pin', post?.name);

let officer = null;
let code = null;
for (const c of ['1043', '1042', '1041']) {
  const t = await signIn(c, pinFor(c));
  if (t && !(await call('/timeclock/status', { token: t })).data?.onDuty) { officer = t; code = c; break; }
}
log(Boolean(officer), 'a floating officer, off duty', code);

const [farLat, farLng] = north(post.latitude, post.longitude, 700);
const clockIn = await call('/timeclock/clock-in', {
  token: officer, method: 'POST',
  body: { postId: post.id, latitude: farLat, longitude: farLng, accuracy: 8, method: 'gps', overrideReason: 'The app says I am across the road but I am at the door' },
});
log(clockIn.status === 201 && clockIn.data.geofence.status === 'outside', 'their phone puts the clock-in 700 m away', clockIn.data?.error);
const entryId = clockIn.data?.entry?.id;
log(Boolean(await flagFor('geofence_violation', entryId)), 'which raises a flag');
const url = `/admin/punches/clock_in/${entryId}/location`;

log((await call(url, { token: officer, method: 'POST', body: { atPost: true, reason: 'I was at the door' } })).status === 403, 'they cannot correct it themselves');
log((await call(url, { token: supervisor, method: 'POST', body: { atPost: true, reason: 'ok' } })).status === 422, 'a reason is required');
log((await call(url, { token: supervisor, method: 'POST', body: { reason: 'Seen at the door on camera' } })).status === 422, 'and a place');
const swapped = await call(url, { token: supervisor, method: 'POST', body: { latitude: post.longitude, longitude: post.latitude, reason: 'Seen at the door on camera' } });
log(swapped.status === 422, 'latitude and longitude swapped are refused as a slip', swapped.data?.error);
const farAway = await call(url, { token: supervisor, method: 'POST', body: { latitude: post.latitude + 3, longitude: post.longitude, reason: 'Seen at the door on camera' } });
log(farAway.status === 422 && /miles from/.test(farAway.data?.error || ''), 'so is a place 200 miles from the post', farAway.data?.error);

const atPost = await call(url, { token: supervisor, method: 'POST', body: { atPost: true, reason: 'Seen at the door on the mall camera at that time' } });
log(atPost.status === 200 && atPost.data.punch.location.geofence === 'inside' && atPost.data.punch.location.distance_m === 0,
  'a supervisor puts it at the post: inside the geofence', atPost.data?.error);
log(atPost.data?.flag?.action === 'closed', 'and its flag closes');
const closedFlag = await flagFor('geofence_violation', entryId);
log(Boolean(closedFlag?.resolved_at) && /Seen at the door/.test(closedFlag.resolution_note || ''), 'saying why');
log((await call(url, { token: supervisor, method: 'POST', body: { atPost: true, reason: 'Seen at the door on the mall camera' } })).status === 409, 'putting it where it already is changes nothing');

const [exLat, exLng] = north(post.latitude, post.longitude, 450);
const exact = await call(url, { token: admin, method: 'POST', body: { latitude: exLat, longitude: exLng, reason: 'Camera shows them in the far car park, not at the door' } });
log(exact.status === 200 && exact.data.punch.location.geofence === 'outside' && Math.abs(exact.data.punch.location.distance_m - 450) <= 5
  && exact.data.punch.location.latitude === exLat, 'an administrator puts it at exact coordinates, 450 m out', exact.data?.error);
log(exact.data?.flag?.action === 'reopened', 'which reopens the flag');
const reopened = await flagFor('geofence_violation', entryId);
log(!reopened?.resolved_at && reopened?.detail?.corrected === true && Math.abs(reopened.detail.distance_m - 450) <= 5, 'with the corrected distance');

const history = await call(url, { token: supervisor });
log(history.data?.fixes?.length === 2 && history.data.fixes[0].fixed_by_name === 'Renata Diaz' && history.data.fixes[1].fixed_by_name === 'Vince Ortega',
  'both corrections are kept, in order, with who made them');
log(Math.abs(history.data?.summary?.original.latitude - farLat) < 1e-6 && history.data.summary.original.accuracy === 8,
  "and the phone's own reading is never lost");
const row = (await punchLog(`&type=clock_in&userId=${clockIn.data.entry.user_id}`)).find((p) => p.ref_id === entryId);
log(row?.location_fix?.count === 2 && row.location_fix.by === 'Vince Ortega' && row.geofence === 'outside', 'the punch log shows the latest');

/* ========================================================= a check-in === */
section('a check-in');

const first = await call('/timeclock/check-in', { token: officer });
const checkId = first.data?.checkIn?.id;
const awayCheck = await call('/timeclock/check-in', { token: officer, method: 'POST', body: { checkId, latitude: farLat, longitude: farLng, accuracy: 9 } });
log(awayCheck.data?.location?.geofence === 'outside', 'a check-in answered with a reading 700 m away');
log(Boolean(await flagFor('check_in_away', checkId)), 'flags them away from the post');
const checkUrl = `/admin/punches/check_in/${checkId}/location`;
const checkFixed = await call(checkUrl, { token: supervisor, method: 'POST', body: { atPost: true, reason: 'Radioed in from the door at the time' } });
log(checkFixed.status === 200 && checkFixed.data.punch.location.geofence === 'inside' && checkFixed.data.flag?.action === 'closed',
  'put at the post, it is inside and its flag closes', checkFixed.data?.error);
const checkRow = (await punchLog(`&type=check_in&userId=${clockIn.data.entry.user_id}`)).find((p) => p.ref_id === checkId);
log(checkRow?.geofence === 'inside' && checkRow.location_fix?.original.geofence === 'outside', 'and the punch log shows it corrected');
const pending = (await call('/timeclock/check-in', { token: officer })).data?.checkIn;
log((await call(`/admin/punches/check_in/${pending?.id}/location`, { token: supervisor })).status === 409, 'a check-in not answered yet has no location to correct');

/* ======================================================== a clock-out === */
section('a clock-out');

log((await call(`/admin/punches/clock_out/${entryId}/location`, { token: supervisor })).status === 409, 'a shift still running has no clock-out to correct');
const [outLat, outLng] = north(post.latitude, post.longitude, 380);
const out = await call('/timeclock/clock-out', { token: officer, method: 'POST', body: { latitude: outLat, longitude: outLng, accuracy: 7 } });
log(out.status === 200, 'they clock out 380 m away', out.data?.error);
const outRow = (await punchLog(`&type=clock_out&userId=${clockIn.data.entry.user_id}`)).find((p) => p.ref_id === entryId);
log(outRow?.geofence === 'outside' && Math.abs(outRow.distance_m - 380) <= 5, 'the punch log has how far from the post they clocked out', `${outRow?.distance_m}`);
const outFixed = await call(`/admin/punches/clock_out/${entryId}/location`, { token: supervisor, method: 'POST', body: { atPost: true, reason: 'Handed the keys over at the desk' } });
log(outFixed.status === 200 && outFixed.data.punch.location.geofence === 'inside' && outFixed.data.flag === null, 'corrected to the post, with no flag of its own');

/* ================================================== nobody does their own === */
section('nobody corrects their own');

const own = await call('/timeclock/clock-in', {
  token: supervisor, method: 'POST',
  body: { postId: post.id, latitude: farLat, longitude: farLng, accuracy: 8, method: 'gps', overrideReason: 'Covering the door for ten minutes' },
});
log(own.status === 201, 'a supervisor clocks in at a post themselves', own.data?.error);
const ownFix = await call(`/admin/punches/clock_in/${own.data?.entry?.id}/location`, { token: supervisor, method: 'POST', body: { atPost: true, reason: 'I was at the door' } });
log(ownFix.status === 403 && /your own/.test(ownFix.data?.error || ''), 'and cannot correct their own clock-in', ownFix.data?.error);
log((await call(`/admin/punches/clock_in/${own.data?.entry?.id}/location`, { token: admin, method: 'POST', body: { atPost: true, reason: 'Saw Renata at the door' } })).status === 200,
  'an administrator can');
log((await call('/timeclock/clock-out', { token: supervisor, method: 'POST', body: { latitude: post.latitude, longitude: post.longitude, accuracy: 5 } })).status === 200, 'and they clock out');

finish('Punch locations');
