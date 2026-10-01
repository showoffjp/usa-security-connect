/**
 * Hiring: the public application form and the office's pipeline.
 *
 * The form is the one write anyone on the internet can make, so it has to
 * validate, drop bot submissions quietly and take one open application per
 * email. The pipeline is staff-only; an applicant only becomes a user - with
 * a code, a PIN and access - when an administrator hires them, after an offer
 * and the required checks, and the starting PIN is shown once.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const officer = await signIn('1003', '4812');
log(Boolean(admin && supervisor && officer), 'signed in as administrator, supervisor and officer');

/* ========================================================= public form === */
section('the public application');

const stamp = Date.now() % 1000000;
const apply = (body) => call('/apply', { method: 'POST', body });
const good = {
  firstName: 'Riley', lastName: 'Chen', email: `riley.chen.${stamp}@example.org`, phone: '(904) 555-0142',
  city: 'Jacksonville', licenceClass: 'D', licenceNumber: 'D3499001', licenceExpiresOn: '2028-06-30',
  experience: 'Three years hotel security.', availability: 'Nights',
};
log((await apply({ ...good, firstName: '' })).status === 422, 'an application needs a name');
log((await apply({ ...good, email: 'not-an-email' })).status === 422, 'a real email address');
log((await apply({ ...good, phone: '555' })).status === 422, 'and a phone number we can call');
log((await apply({ ...good, licenceClass: 'Z' })).status === 422, 'and a licence class that exists');
const sent = await apply(good);
log(sent.status === 201 && sent.data.ok === true, 'anyone can apply without signing in');
log((await apply({ ...good, email: good.email.toUpperCase() })).status === 409, 'one open application per email address, whatever the case');
const botEmail = `bot.${stamp}@example.org`;
const bot = await apply({ ...good, email: botEmail, website: 'http://spam.example' });
log(bot.status === 201, 'a bot filling in the hidden field is thanked');
const outbox = ((await call('/admin/emails?limit=300', { token: admin })).data.emails || []);
log(outbox.some((e) => e.kind === 'application_received' && e.to_email === good.email), 'the applicant is emailed a confirmation');
log(!outbox.some((e) => e.to_email === botEmail), 'the bot is not');

/* ============================================================ pipeline === */
section('the pipeline');

const board = await call('/admin/hiring', { token: supervisor });
const riley = board.data.applicants.find((a) => a.email === good.email);
log(board.status === 200 && riley?.stage === 'applied' && riley.source === 'website', 'the application lands in the pipeline as applied');
log(!board.data.applicants.some((a) => a.email === botEmail), 'and the bot does not');
log(board.data.applicants.every((a) => ['applied', 'screening', 'interview', 'offer'].includes(a.stage)), 'the board shows only applicants in play');
log(board.data.counts.applied >= 1 && Number.isInteger(board.data.counts.rejected), 'with a count for every stage');
log((await call('/admin/hiring', { token: officer })).status === 403, 'officers cannot see applicants');
log((await call('/admin/hiring/abc', { token: supervisor })).status === 422, 'a junk id is refused');
const alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts;
log(alerts.some((a) => a.key === `applicant:${riley.id}` && a.kind === 'applicant'), 'a new applicant is in the alerts inbox');
log((await call('/admin/dashboard', { token: supervisor })).data.counts.newApplicants === board.data.counts.applied, 'and counted on the sidebar');

const stage = (id, body, token = supervisor) => call(`/admin/hiring/${id}/stage`, { token, method: 'PATCH', body });
const check = (id, key, done, token = supervisor) => call(`/admin/hiring/${id}/checks/${key}`, { token, method: 'PUT', body: { done } });
log((await stage(riley.id, { stage: 'hired' })).status === 422, 'hiring is not a stage move');
log((await stage(riley.id, { stage: 'applied' })).status === 409, 'nor is staying put');
log((await stage(riley.id, { stage: 'rejected' })).status === 422, 'turning someone down needs a reason');
const moved = await stage(riley.id, { stage: 'screening' });
log(moved.status === 200 && moved.data.applicant.stage === 'screening' && moved.data.notes.some((n) => /screening/.test(n.body)),
  'a supervisor moves them on, and it is noted');
log(!(await call('/admin/alerts', { token: supervisor })).data.alerts.some((a) => a.key === `applicant:${riley.id}`), 'which takes them off the alerts');
log((await check(riley.id, 'nonsense', true)).status === 404, 'only known checks can be ticked');
const ticked = await check(riley.id, 'licence', true);
log(ticked.data.checks.find((c) => c.key === 'licence')?.done === true && ticked.data.checks.find((c) => c.key === 'licence')?.done_by_name === 'Renata Diaz',
  'a check is ticked, with who did it');
log((await check(riley.id, 'licence', false)).data.checks.find((c) => c.key === 'licence')?.done === false, 'and can be unticked');
const noted = await call(`/admin/hiring/${riley.id}/notes`, { token: supervisor, method: 'POST', body: { body: 'Phone screen went well.' } });
log(noted.status === 201 && noted.data.notes[0].body === 'Phone screen went well.', 'notes are kept, newest first');

const hire = (id, body = { payRate: 18.5 }, token = admin) => call(`/admin/hiring/${id}/hire`, { token, method: 'POST', body });
log((await hire(riley.id)).status === 409, 'nobody is hired before an offer');
await stage(riley.id, { stage: 'interview' });
await stage(riley.id, { stage: 'offer' });
const early = await hire(riley.id);
log(early.status === 409 && /required checks/.test(early.data.error), 'or before the required checks');
for (const key of ['licence', 'background', 'right_to_work']) await check(riley.id, key, true);
log((await hire(riley.id, { payRate: 18.5 }, supervisor)).status === 403, 'only an administrator hires');
log((await hire(riley.id, { payRate: 18.5, employmentType: '1099' })).status === 422, 'a contractor needs a W-9 first');
log((await hire(riley.id, { payRate: 18.5, defaultSiteId: 999999 })).status === 422, 'and the usual site has to exist');
const hired = await hire(riley.id, { payRate: 18.5 });
log(hired.status === 201 && hired.data.applicant.stage === 'hired' && /^\d{4}$/.test(hired.data.credentials.employeeCode) && /^\d{4}$/.test(hired.data.credentials.pin),
  'an administrator hires them, and gets a code and a starting PIN once', hired.data.credentials?.employeeCode);
log(hired.data.employee.first_name === 'Riley' && hired.data.employee.license_number === 'D3499001' && hired.data.employee.license_type === 'Class D',
  'the employee record carries what they applied with');
log(!('pin_hash' in hired.data.employee), 'without the PIN hash');
const firstLogin = await call('/auth/login', { method: 'POST', body: { employeeCode: hired.data.credentials.employeeCode, pin: hired.data.credentials.pin } });
log(firstLogin.status === 200 && firstLogin.data.mustChangePin === true, 'the new officer can sign in, and must choose their own PIN');
log((await hire(riley.id)).status === 409, 'nobody is hired twice');
log((await stage(riley.id, { stage: 'screening' })).status === 409, 'and a hire is managed under Employees from then on');
log((await call('/admin/hiring/' + riley.id, { token: supervisor })).data.applicant.hired_code === hired.data.credentials.employeeCode,
  'the application points to the employee');

/* ======================================================= office entries === */
section('applicants the office adds');

const walkIn = await call('/admin/hiring', {
  token: supervisor, method: 'POST',
  body: { firstName: 'Sam', lastName: 'Ortiz', email: `sam.ortiz.${stamp}@example.org`, phone: '(904) 555-0177', source: 'referral', referredBy: 'Marcus Bell' },
});
log(walkIn.status === 201 && walkIn.data.applicant.source === 'referral' && walkIn.data.applicant.referred_by === 'Marcus Bell', 'a supervisor adds a referral');
log((await call('/admin/hiring', { token: officer, method: 'POST', body: { ...good, email: 'x@example.org' } })).status === 403, 'officers cannot');
const turned = await stage(walkIn.data.applicant.id, { stage: 'rejected', reason: 'Not available for the shifts we have.' });
log(turned.status === 200 && turned.data.applicant.stage === 'rejected' && turned.data.applicant.rejected_reason.startsWith('Not available'),
  'and turns one down with a reason');
log((await call('/admin/hiring?stage=rejected', { token: supervisor })).data.applicants.some((a) => a.id === walkIn.data.applicant.id), 'listed under not taken on');
const again = await apply({ ...good, firstName: 'Sam', lastName: 'Ortiz', email: `sam.ortiz.${stamp}@example.org` });
log(again.status === 201, 'someone turned down can apply again later');
const reopened = await stage(walkIn.data.applicant.id, { stage: 'applied', reason: 'Availability changed.' });
log(reopened.status === 200 && reopened.data.applicant.rejected_reason === null, 'and an application can be reopened');

const auditLog = await call('/admin/audit?limit=200', { token: admin });
const actions = new Set((auditLog.data?.entries || []).map((e) => e.action));
log(actions.has('applicant.stage') && actions.has('applicant.hired') && actions.has('applicant.added'), 'moves, hires and additions are audited');

finish('Hiring');
