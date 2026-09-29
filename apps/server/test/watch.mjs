/**
 * The watchlist, vehicle violations and officer scorecards.
 *
 * The watchlist matters at one moment - the officer signing someone in - so
 * most of this is about that moment: a match stops the sign-in with the
 * instruction to follow, matching is exact (names ignoring case and spacing,
 * aliases, plates ignoring dashes) rather than fuzzy, an expired entry or
 * another site's does not fire, and letting someone in anyway takes a named
 * entry and a reason that stays on the record.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812'); // on duty at Riverfront
const harborview = (await call('/client/login', {
  method: 'POST', body: { email: 'carla.mendez@harborviewhealth.org', password: 'harborview-portal-04' },
})).data?.token;
log(Boolean(admin && supervisor && marcus && harborview), 'signed in as staff and a client contact');

let offDuty = null;
for (const [code, pin] of [['1004', '5930'], ['1006', '7285'], ['1008', '9351'], ['1005', '6174']]) {
  const token = await signIn(code, pin);
  if (!(await call('/post-log', { token })).data.onDuty) {
    offDuty = token;
    break;
  }
}

const visit = (body, token = marcus) => call('/post-log/visitors', { token, method: 'POST', body: { purpose: 'Meeting', ...body } });

/* ============================================================== watchlist === */
section('the watchlist at the desk');

const view = await call('/post-log', { token: marcus });
const names = view.data.watchlist.map((w) => w.full_name);
log(names.includes('Kyle Banner') && names.includes('Todd Reardon'), "the officer sees their site's entries and the company-wide ones", names.join(', '));
log(!names.includes('Leon Price'), 'but not one that has expired');
log(!names.includes('Marcus Hale'), "nor another site's");

const hit = await visit({ fullName: '  kyle   BANNER ' });
log(hit.status === 409 && hit.data.details?.code === 'watchlist_match', 'signing in a listed name is stopped, whatever the case and spacing');
const entry = hit.data.details?.matches?.[0];
log(entry?.action === 'call_police' && entry?.risk === 'high' && /Police report/.test(entry.reason), 'with the instruction and the reason');
log((await visit({ fullName: 'T. Reardon' })).status === 409, 'an alias matches too');
log((await visit({ fullName: 'Pat Delivery', vehiclePlate: 'kbn-4471' })).status === 409, 'and so does a listed plate, ignoring the dash');
log((await visit({ fullName: 'Kyle Bannerman' })).status === 201, 'a similar name is not a match - it is exact on purpose');
log((await visit({ fullName: 'Leon Price' })).status === 201, 'an expired entry does not stop anyone');
log((await visit({ fullName: 'Marcus Hale' })).status === 201, "nor does another site's");

log((await visit({ fullName: 'Kyle Banner', override: { watchlistId: 999999, reason: 'Checked his ID.' } })).status === 409,
  'overriding needs the entry that actually matched');
log((await visit({ fullName: 'Kyle Banner', override: { watchlistId: entry.id, reason: 'ok' } })).status === 422,
  'and a real reason');
const let_in = await visit({ fullName: 'Kyle Banner', override: { watchlistId: entry.id, reason: 'Checked ID - different person, born 1991.' } });
log(let_in.status === 201 && let_in.data.visitor.watchlist_name === 'Kyle Banner' && /born 1991/.test(let_in.data.visitor.notes),
  'an override signs them in, carrying the entry and the reason');

section('supervisors keep the list');

log((await call('/post-log/admin/watchlist', { token: marcus })).status === 403, 'an officer cannot edit the watchlist');
const add = (body) => call('/post-log/admin/watchlist', { token: supervisor, method: 'POST', body });
const riverfront = view.data.post.site_id;
log((await add({ siteId: riverfront, fullName: 'Test Person', reason: 'no' })).status === 422, 'an entry needs a reason officers can act on');
log((await add({ siteId: riverfront, fullName: 'Test Person', reason: 'Barred by the client.', action: 'shoot' })).status === 422,
  'and a known instruction');
const added = await add({ siteId: riverfront, fullName: 'Wendell Tarbox', reason: 'Barred by the client after vandalism.', risk: 'high' });
log(added.status === 201 && added.data.entry.active, 'a supervisor adds someone');
log((await call('/post-log', { token: marcus })).data.watchlist.some((w) => w.id === added.data.entry.id), 'the officer on post sees them straight away');
log((await visit({ fullName: 'Wendell Tarbox' })).status === 409, 'and the desk stops them');
const off = await call(`/post-log/admin/watchlist/${added.data.entry.id}`, { token: supervisor, method: 'PATCH', body: { active: false } });
log(off.status === 200 && off.data.entry.active === false, 'taking them off the list keeps the entry');
log((await visit({ fullName: 'Wendell Tarbox' })).status === 201, 'and the desk lets them in again');
const list = await call('/post-log/admin/watchlist?all=1', { token: supervisor });
log(list.data.entries.some((e) => e.expired) && list.data.entries.some((e) => !e.active), 'the full list shows lapsed and removed entries');
log(list.data.overrides.some((v) => v.id === let_in.data.visitor.id), "and every override, for the supervisor to follow up");

/* =============================================================== vehicles === */
section('vehicle violations');

const plate = `ZZ-${Date.now() % 10000}`;
const tag = plate.replace(/[^A-Z0-9]/g, '');
const cite = (body, token = marcus) => call('/post-log/vehicles', { token, method: 'POST', body: { violation: 'fire_lane', ...body } });
log((await cite({ plate: '' })).status === 422, 'a violation needs a plate');
log((await cite({ plate, violation: 'speeding-ish' })).status === 422, 'and a known kind');
log((await cite({ plate }, offDuty)).status === 409, 'an officer off duty cannot log one');

await visit({ fullName: 'Plate Owner', vehiclePlate: plate.toLowerCase() });
const first = await cite({ plate: plate.toLowerCase(), action: 'warning', locationText: 'East door' });
log(first.status === 201 && first.data.violation.plate === tag && first.data.violation.plate_count === 1,
  'the plate is stored tidy, and it is a first offence', `${first.data.violation?.plate} x${first.data.violation?.plate_count}`);
const second = await cite({ plate: tag.slice(0, 2) + ' ' + tag.slice(2), action: 'tagged' });
log(second.data.violation.plate_count === 2, 'the same plate written differently counts as a second');

const look = await call(`/post-log/vehicles/lookup?plate=${encodeURIComponent(plate)}`, { token: marcus });
log(look.status === 200 && look.data.recentCount === 2 && look.data.repeatOffender, 'looking the plate up shows a repeat offender');
log(look.data.visits.some((v) => v.full_name === 'Plate Owner'), 'along with the visit it came in on');
log((await call(`/post-log/vehicles/lookup?plate=${tag}`, { token: offDuty })).status === 409, 'an officer off duty cannot look plates up');
log((await call(`/post-log/vehicles/lookup?plate=${tag}`, { token: supervisor })).status === 200, 'a supervisor can, from anywhere');
log((await call('/post-log/vehicles/lookup?plate=A', { token: marcus })).status === 422, 'one character is not a lookup');

const all = await call('/post-log/admin/vehicles', { token: supervisor });
log(all.status === 200 && all.data.repeatOffenders.some((r) => r.plate === tag && r.n === 2), 'supervisors see it among repeat offenders');
log((await call('/post-log/admin/vehicles', { token: marcus })).status === 403, 'officers do not see every site');
const dar = await call(`/reports/dar?siteId=${riverfront}`, { token: supervisor });
log(dar.data.summary.vehicleViolations >= 2 && dar.data.vehicles.some((v) => v.plate === tag), 'the daily report lists the violations');
const otherDar = await call('/client/dar', { token: harborview });
log(otherDar.status === 200 && Array.isArray(otherDar.data.vehicles) && !otherDar.data.vehicles.some((v) => v.plate === tag),
  "another client's report does not include them");
log(otherDar.data.vehicles.every((v) => !('logged_by' in v) && !('notes' in v)), 'and client reports carry no officer or internal notes');

/* ============================================================= scorecards === */
section('officer scorecards');

log((await call('/admin/scorecards', { token: marcus })).status === 403, 'an officer cannot see scorecards');
const cards = await call('/admin/scorecards?days=30', { token: supervisor });
log(cards.status === 200 && cards.data.cards.length > 10, 'a supervisor sees a scorecard for each officer who worked', `${cards.data.cards?.length}`);
log(cards.data.cards.every((c) => c.score === null || (c.score >= 0 && c.score <= 100)), 'every score is between 0 and 100');
const scores = cards.data.cards.map((c) => c.score ?? -1);
log(scores.every((s, i) => i === 0 || scores[i - 1] >= s), 'ranked best first');
log(cards.data.cards.every((c) => c.shifts.worked + c.shifts.missed === c.shifts.due && c.shifts.onTime <= c.shifts.worked),
  'shifts worked and missed add up, and on time is never more than worked');
const bell = cards.data.cards.find((c) => c.employee_code === '1003');
log(bell && bell.hours > 0 && bell.checkIns.answeredPct !== null, 'Marcus Bell has hours and check-ins counted');
const missed = cards.data.cards.find((c) => c.shifts.missed > 0 && c.shifts.worked === 0);
log(!missed || missed.score < 50, 'someone who missed every shift scores low', missed ? `${missed.name} ${missed.score}` : 'none');
log((await call('/admin/scorecards?days=1', { token: supervisor })).data.days === 7, 'the period is at least a week');
log(!JSON.stringify(cards.data).match(/pay_rate|pin_hash|phone/), 'and no pay, PIN or contact details');

finish('Watchlist, vehicles and scorecards');
