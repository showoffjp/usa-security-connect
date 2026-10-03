/**
 * Commendations: thanks for an officer from a client contact or a supervisor.
 *
 * A client contact commends only officers who worked one of their properties
 * lately, at that property, and sees nothing about them beyond the name. A
 * supervisor commends anyone but themselves; an officer cannot commend. The
 * officer reads every one and marks the new ones seen. Client thanks reach the
 * alerts inbox; the scorecards count them without moving the score. Only an
 * administrator removes one, on the audit log.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
log(Boolean(admin && supervisor && marcus), 'signed in as administrator, supervisor and an officer');

// Contacts of their own, set up the way the office sets anyone up, so this
// suite does not spend the shared demo logins' sign-in allowance.
const sites = (await call('/reference', { token: admin })).data.sites;
const stamp = Date.now();
async function newContact(siteName, name) {
  const created = await call('/admin/clients', {
    token: admin,
    method: 'POST',
    body: { email: `${name.toLowerCase().replace(/ /g, '.')}.${stamp}@example.com`, name, siteIds: [sites.find((x) => x.name === siteName).id] },
  });
  const token = new URL(created.data.link, 'http://localhost').searchParams.get('token');
  const set = await call('/client/set-password', { method: 'POST', body: { token, password: 'suite-portal-password', confirmPassword: 'suite-portal-password' } });
  return set.data?.token;
}
const riverfront = await newContact('Riverfront Commerce Center', 'Gail Ferris');
const capital = await newContact('Capital Plaza Office Tower', 'Owen Pratt');
log(Boolean(riverfront && capital), 'two client contacts, one at Riverfront and one at Capital Plaza');

const meId = (await call('/auth/me', { token: marcus })).data.user.id;

/* =============================================================== client === */
section('a client commends an officer');

const portal = (await call('/client/commendations', { token: riverfront })).data;
const marcusThere = portal.officers.find((o) => o.id === meId);
log(portal.officers.length > 0 && marcusThere && marcusThere.site_name === 'Riverfront Commerce Center',
  'the client sees the officers who worked their property lately', `${portal.officers.length} officers`);
log(portal.officers.every((o) => Object.keys(o).sort().join() === 'id,last_seen,name,site_id,site_name'), 'and nothing about them but the name and where');
log(portal.categories.length >= 5 && portal.windowDays === 60, 'with what they can be commended for');

const commend = (token, body) => call('/client/commendations', { token, method: 'POST', body });
const base = { officerId: meId, siteId: marcusThere.site_id, category: 'customer_service', message: 'Suite: helped a lost courier find the right dock and signed for it.' };
log((await commend(riverfront, { ...base, message: 'Thanks!' })).status === 422, 'a commendation says what they did');
log((await commend(riverfront, { ...base, category: 'cake' })).status === 422, 'and what it was for');
const capitalSite = (await call('/client/commendations', { token: capital })).data.officers[0]?.site_id;
log((await commend(riverfront, { ...base, siteId: capitalSite || 999999 })).status === 404, 'not at someone else\'s property');
const stranger = (await call('/client/commendations', { token: capital })).data.officers.find((o) => !portal.officers.some((p) => p.id === o.id));
if (stranger) log((await commend(riverfront, { ...base, officerId: stranger.id })).status === 404, 'nor for an officer who never worked theirs');
const made = await commend(riverfront, base);
log(made.status === 201 && made.data.commendation.officer === 'Marcus Bell' && !('employee_code' in made.data.commendation), 'the client commends Marcus', made.data?.error);
log((await call('/client/commendations', { token: riverfront })).data.commendations.some((c) => c.id === made.data.commendation.id), 'and sees it among theirs');
log(!(await call('/client/commendations', { token: capital })).data.commendations.some((c) => c.id === made.data.commendation.id), 'another client does not');

/* ============================================================== officer === */
section('the officer reads it');

let mine = (await call('/commendations/mine', { token: marcus })).data;
const fromClient = mine.commendations.find((c) => c.id === made.data.commendation.id);
log(fromClient && fromClient.source === 'client' && /Gail Ferris/.test(fromClient.from) && !fromClient.seen && mine.unseen >= 1,
  'the officer sees it, who it is from, and that it is new', fromClient?.from);
log((await call('/commendations/mine/seen', { token: marcus, method: 'POST' })).status === 200 && (await call('/commendations/mine', { token: marcus })).data.unseen === 0,
  'and marks it read');
log((await call('/commendations', { token: marcus })).status === 403, 'an officer cannot read everyone\'s');
log((await call('/commendations', { token: marcus, method: 'POST', body: { userId: meId, category: 'teamwork', message: 'Suite: I am great.' } })).status === 403,
  'nor commend anyone');

/* ================================================================ staff === */
section('a supervisor commends, an administrator moderates');

const supId = (await call('/commendations?limit=300', { token: supervisor })).data.commendations.find((c) => c.source === 'staff')?.id;
log(Boolean(supId), 'staff see every commendation');
const byStaff = await call('/commendations', { token: supervisor, method: 'POST', body: { userId: meId, category: 'teamwork', message: 'Suite: covered the gate while the relief was late, without being asked.' } });
log(byStaff.status === 201 && byStaff.data.commendation.source === 'staff' && byStaff.data.commendation.from === 'Renata Diaz', 'a supervisor commends an officer', byStaff.data?.error);
const supUserId = (await call('/auth/me', { token: supervisor })).data.user.id;
log((await call('/commendations', { token: supervisor, method: 'POST', body: { userId: supUserId, category: 'teamwork', message: 'Suite: commending myself.' } })).status === 403,
  'but never themselves');
log((await call(`/commendations?userId=${meId}`, { token: supervisor })).data.commendations.every((c) => c.user_id === meId), 'and can read one officer\'s');

const alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
log(alerts.some((a) => a.key === `commendation:${made.data.commendation.id}` && a.kind === 'commendation'), 'a client\'s thanks reaches the alerts inbox');
log(!alerts.some((a) => a.key === `commendation:${byStaff.data.commendation.id}`), 'a supervisor\'s own does not');

const cards = (await call('/admin/scorecards?days=30', { token: supervisor })).data;
const card = cards.cards.find((c) => c.id === meId);
log(card && card.commendations.total >= 3 && card.commendations.fromClients >= 2, 'the scorecard counts them', card && JSON.stringify(card.commendations));

log((await call(`/commendations/${byStaff.data.commendation.id}`, { token: supervisor, method: 'DELETE' })).status === 403, 'only an administrator removes one');
log((await call(`/commendations/${byStaff.data.commendation.id}`, { token: admin, method: 'DELETE' })).status === 200 &&
  !(await call('/commendations/mine', { token: marcus })).data.commendations.some((c) => c.id === byStaff.data.commendation.id),
  'and then the officer no longer has it');

const actions = (await call('/admin/audit?action=commendation.', { token: admin })).data.entries.map((e) => e.action);
log(['commendation.created', 'commendation.removed'].every((a) => actions.includes(a)), 'staff commendations and removals are audited');

finish('Commendations suite');
