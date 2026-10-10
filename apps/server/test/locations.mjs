/**
 * Where sites and posts are, and where officers check in from.
 *
 * The pins: every demo site sits on its geocoded street address and every
 * post was set at the post or is on its site's property; a pin moved 900 m is
 * called wrong and one click puts it back on the address; a pin set from a
 * phone is only taken with a fix good to 25 m. The check-ins: the company
 * interval is set by an administrator and followed by posts that set none;
 * after clocking in the first is due that long after; each answer is judged
 * against the post, one from 450 m away raises a flag and shows in the punch
 * log, and a post set to no check-ins withdraws the one waiting and queues
 * none. The suite puts back everything it moves. The geocoder is off
 * (verify.mjs): the seed's cache is all it has.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const pinFor = (code) => String(((Number(code) * 7919) % 9000) + 1000);
const north = (lat, lng, m) => [Number((lat + m / 111320).toFixed(6)), lng];

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const client = (await call('/client/login', { method: 'POST', body: { email: 'carla.mendez@harborviewhealth.org', password: 'harborview-portal-04' } })).data?.token;
log(Boolean(admin && supervisor && marcus && client), 'signed in as staff and a client contact');

/* ============================================================ the pins === */
section('the location check');

log((await call('/admin/locations', { token: marcus })).status === 403, 'officers cannot see it');
log((await call('/admin/locations', { token: client })).status === 401, 'nor clients');
const check = await call('/admin/locations', { token: supervisor });
log(check.status === 200 && check.data.geocoder === 'off', 'supervisors can, and the test server asks no geocoder');
// The demo's ten sites, placed from their addresses; earlier suites add sites of their own.
const sites = check.data.sites.filter((x) => x.location_source === 'address');
const problemsBefore = check.data.needsAttention;
log(sites.length === 10 && sites.every((s) => s.state === 'ok' && s.match && s.distance_m <= s.tolerance_m),
  'every demo site sits on its street address as geocoded', sites.filter((s) => s.state !== 'ok').map((s) => s.name).join(', '));
log(sites.every((s) => ['building', 'street'].includes(s.match.precision)), 'each matched to the building, or along the street where that is all there is');
const posts = sites.flatMap((s) => s.posts.map((p) => ({ ...p, site: s })));
log(posts.length >= 15 && posts.every((p) => ['surveyed', 'ok'].includes(p.state)), 'every post pin was set at the post or is on its site',
  posts.filter((p) => !['surveyed', 'ok'].includes(p.state)).map((p) => `${p.name}: ${p.state}`).join(', '));
log(sites.flatMap((x) => [x, ...x.posts]).every((x) => !['wrong', 'no_pin', 'check', 'no_match'].includes(x.state)), 'so nothing at them needs fixing');
log(posts.filter((p) => p.state === 'surveyed').every((p) => p.accuracy_m <= 25), 'pins set at the post were all good to 25 m');

const desk = posts.find((p) => p.post_code === 'HV-03');
log(desk?.state === 'surveyed' && desk.match?.precision === 'building', 'the Harborview visitor desk was set at the post, near the hospital building');

section('a pin in the wrong place');
const [farLat, farLng] = north(desk.latitude, desk.longitude, 900);
const moved = await call(`/admin/posts/${desk.id}`, { token: admin, method: 'PATCH', body: { latitude: farLat, longitude: farLng } });
log(moved.status === 200 && moved.data.location?.state === 'wrong' && moved.data.post.location_source === 'map',
  'moving it 900 m on the map is saved, and the answer says the pin is wrong', moved.data?.location ? `${moved.data.location.distance_m} m` : moved.data?.error);
const after = await call('/admin/locations', { token: supervisor });
log(after.data.needsAttention === problemsBefore + 1 && after.data.sites.flatMap((x) => x.posts).some((p) => p.id === desk.id && p.state === 'wrong'),
  'the location check lists it as one more thing to fix');
log((await call(`/admin/locations/post/${desk.id}/use-address`, { token: supervisor, method: 'POST' })).status === 403, 'only an administrator moves it back');
const fixed = await call(`/admin/locations/post/${desk.id}/use-address`, { token: admin, method: 'POST' });
log(fixed.status === 200 && fixed.data.location.state === 'ok' && fixed.data.location.distance_m === 0 && fixed.data.location.location_source === 'address',
  'Use the address puts the pin on the building', fixed.data?.error);
log((await call(`/admin/locations/post/999999/use-address`, { token: admin, method: 'POST' })).status === 404, 'a post that does not exist is not found');
log((await call(`/admin/locations/planet/${desk.id}/use-address`, { token: admin, method: 'POST' })).status === 404, 'nor is a kind of place that does not exist');

section('setting a pin from where you stand');
const rough = await call(`/admin/locations/post/${desk.id}/survey`, { token: supervisor, method: 'POST', body: { latitude: desk.latitude, longitude: desk.longitude, accuracy: 60 } });
log(rough.status === 422 && /60 m/.test(rough.data?.error || ''), 'a fix good only to 60 m is refused, saying so', rough.data?.error);
log((await call(`/admin/locations/post/${desk.id}/survey`, { token: supervisor, method: 'POST', body: { latitude: desk.latitude, longitude: desk.longitude } })).status === 422,
  'so is one that does not say how accurate it is');
log((await call(`/admin/locations/post/${desk.id}/survey`, { token: marcus, method: 'POST', body: { latitude: desk.latitude, longitude: desk.longitude, accuracy: 5 } })).status === 403,
  'officers cannot set pins');
const viaDialog = await call(`/admin/posts/${desk.id}`, { token: admin, method: 'PATCH', body: { latitude: desk.latitude, longitude: desk.longitude, locationSource: 'survey', locationAccuracyM: 40 } });
log(viaDialog.status === 422, 'nor can the post dialog claim a rough fix was taken at the post');
const surveyed = await call(`/admin/locations/post/${desk.id}/survey`, { token: supervisor, method: 'POST', body: { latitude: desk.latitude, longitude: desk.longitude, accuracy: desk.accuracy_m } });
log(surveyed.status === 200 && surveyed.data.location.state === 'surveyed' && surveyed.data.location.location_accuracy_m === desk.accuracy_m,
  'a supervisor standing there with a good fix sets it, and it is trusted over the address');

section('a site moved, and its address changed');
const riverfront = sites.find((s) => s.name === 'Riverfront Commerce Center');
const [rLat, rLng] = north(riverfront.latitude, riverfront.longitude, 400);
const siteMoved = await call(`/admin/sites/${riverfront.id}`, { token: admin, method: 'PATCH', body: { latitude: rLat, longitude: rLng } });
log(siteMoved.status === 200 && siteMoved.data.location.state === 'wrong', 'a site pin 400 m off its building is wrong too', siteMoved.data?.location?.state);
const siteBack = await call(`/admin/locations/site/${riverfront.id}/use-address`, { token: admin, method: 'POST' });
log(siteBack.status === 200 && siteBack.data.location.state === 'ok', 'and goes back onto its address');
const renamed = await call(`/admin/sites/${riverfront.id}`, { token: admin, method: 'PATCH', body: { address: '1 Nowhere Lane' } });
log(renamed.status === 200 && renamed.data.location.state === 'unchecked', 'an address never looked up cannot be judged while the geocoder is off');
await call(`/admin/sites/${riverfront.id}`, { token: admin, method: 'PATCH', body: { address: riverfront.address } });
log((await call(`/admin/sites/${riverfront.id}`, { token: supervisor, method: 'PATCH', body: { address: 'x' } })).status === 403, 'only administrators edit sites');
const geo = await call('/reports/geocode?q=1200%20Riverside%20Ave', { token: admin });
log(geo.status === 200 && geo.data.provider === 'off' && geo.data.results.length === 0, 'with the geocoder off the address search finds nothing, quietly');

/* ========================================================= check-ins === */
section('the company check-in interval');

const settings = await call('/admin/settings/check-ins', { token: supervisor });
log(settings.status === 200 && settings.data.everyMin === 60 && settings.data.label === 'Every hour' && settings.data.postsFollowing > 0,
  'check-ins are hourly unless a post says otherwise', `${settings.data?.postsFollowing} posts follow it`);
log((await call('/admin/settings/check-ins', { token: supervisor, method: 'PUT', body: { everyMin: 30 } })).status === 403, 'only an administrator changes it');
log((await call('/admin/settings/check-ins', { token: admin, method: 'PUT', body: { everyMin: 7 } })).status === 422, 'to one of the listed intervals');
const set30 = await call('/admin/settings/check-ins', { token: admin, method: 'PUT', body: { everyMin: 30 } });
log(set30.status === 200 && set30.data.everyMin === 30 && set30.data.label === 'Every 30 min', 'an administrator sets every 30 minutes');

section('checking in between clock-in and clock-out');
const lobby = posts.find((p) => p.post_code === 'CP-01');
log(lobby.check_in_interval_min == null, 'the Capital Plaza lobby follows the company setting');
let officer = null;
let code = null;
for (const c of ['1043', '1042', '1041']) {
  const t = await signIn(c, pinFor(c));
  if (t && !(await call('/timeclock/status', { token: t })).data?.onDuty) { officer = t; code = c; break; }
}
log(Boolean(officer), 'a floating officer, off duty', code);
const inAt = Date.now();
const clockIn = await call('/timeclock/clock-in', { token: officer, method: 'POST', body: { postId: lobby.id, latitude: lobby.latitude, longitude: lobby.longitude, accuracy: 6, method: 'gps' } });
log(clockIn.status === 201 && clockIn.data.geofence.status === 'inside', 'they clock in at the desk', clockIn.data?.error);
const first = await call('/timeclock/check-in', { token: officer });
const dueIn = (new Date(first.data.checkIn?.due_at) - inAt) / 60000;
log(first.status === 200 && dueIn > 29 && dueIn < 31.5 && first.data.checkIns.every_min === 30 && first.data.checkIns.label === 'Every 30 min',
  'the first check-in is due 30 minutes after clocking in', `${dueIn.toFixed(1)} min`);
const status = await call('/timeclock/status', { token: officer });
log(status.data.checkIns?.every_min === 30 && status.data.checkIns.last === null && status.data.checkIn?.id === first.data.checkIn.id,
  'their home screen has the plan and the next one, with none answered yet');

const [awayLat, awayLng] = north(lobby.latitude, lobby.longitude, 450);
const away = await call('/timeclock/check-in', { token: officer, method: 'POST', body: { checkId: first.data.checkIn.id, latitude: awayLat, longitude: awayLng, accuracy: 8 } });
log(away.status === 200 && away.data.location.geofence === 'outside' && Math.abs(away.data.location.distance_m - 450) <= 5,
  'one answered from 450 m away counts, and says how far from the post', away.data?.location ? `${away.data.location.distance_m} m` : away.data?.error);
log(away.data.checkIns.last.geofence === 'outside' && away.data.checkIns.answered === 1, 'their plan shows the last one was away from the post');
const flags = (await call(`/admin/flags?type=check_in_away&userId=${clockIn.data.entry?.user_id ?? status.data.entry.user_id}`, { token: supervisor })).data?.flags || [];
log(flags.length === 1 && flags[0].detail?.distance_m >= 445, 'and raises one flag with the distance', `${flags.length}`);
const userId = status.data.entry.user_id;
const punches = (await call(`/admin/punches?type=check_in&userId=${userId}`, { token: supervisor })).data?.punches || [];
log(punches.some((p) => p.geofence === 'outside' && p.distance_m >= 445), 'the punch log shows where the check-in came from');

const second = away.data.next;
log(second && (new Date(second.due_at) - new Date(first.data.checkIn.due_at)) / 60000 === 30, 'the next is queued 30 minutes after the last was due');
const inside = await call('/timeclock/check-in', { token: officer, method: 'POST', body: { checkId: second.id, latitude: lobby.latitude, longitude: lobby.longitude, accuracy: 5 } });
log(inside.data?.location?.geofence === 'inside', 'one answered at the desk is inside, with no flag');
const third = inside.data.next;
const roughFix = await call('/timeclock/check-in', { token: officer, method: 'POST', body: { checkId: third.id, latitude: awayLat, longitude: awayLng, accuracy: 400 } });
log(roughFix.data?.location?.geofence === 'unverified', 'a fix good only to 400 m cannot be judged, and is not held against them');
const flagsAfter = (await call(`/admin/flags?type=check_in_away&userId=${userId}`, { token: supervisor })).data?.flags || [];
log(flagsAfter.length === 1, 'so there is still only the one flag');

section('a post with check-ins off');
log((await call(`/admin/posts/${lobby.id}`, { token: admin, method: 'PATCH', body: { checkInIntervalMin: 0 } })).status === 200, 'an administrator turns check-ins off at the post');
const fourth = roughFix.data.next;
const withdrawn = await call('/timeclock/check-in', { token: officer, method: 'POST', body: { checkId: fourth.id, latitude: lobby.latitude, longitude: lobby.longitude, accuracy: 5 } });
log(withdrawn.status === 409, 'the one that was waiting is withdrawn, so it can be neither answered nor missed');
const offNow = await call('/timeclock/check-in', { token: officer });
log(offNow.data?.checkIn === null && offNow.data?.checkIns?.every_min === 0 && offNow.data.checkIns.label === 'Off', 'and no more are queued');
await call(`/admin/posts/${lobby.id}`, { token: admin, method: 'PATCH', body: { checkInIntervalMin: null } });
const out = await call('/timeclock/clock-out', { token: officer, method: 'POST', body: { latitude: lobby.latitude, longitude: lobby.longitude, accuracy: 5 } });
log(out.status === 200, 'they clock out', out.data?.error);
const reset = await call('/admin/settings/check-ins', { token: admin, method: 'PUT', body: { everyMin: 60 } });
log(reset.data?.everyMin === 60, 'and check-ins go back to hourly');

finish('Locations and check-ins');
