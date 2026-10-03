/**
 * Expense claims: an officer claims back what they spent, an administrator
 * decides, and the payroll close pays it.
 *
 * Claims are for money already spent, within 60 days, up to $1,000, and need
 * a receipt above $25 (mileage is priced from the miles instead). Only the
 * claimant and staff see a receipt. Supervisors see the queue; only an
 * administrator decides, never on their own claim, and a decline says why.
 * A claim waiting for a decision holds up closing the period it falls in;
 * an approved one is paid by the next close and handed back by a reopen.
 *
 * The payroll part runs on a week of its own, five weeks back, so it neither
 * depends on nor disturbs the periods the payroll suite closes.
 */

import { BASE, call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const alexis = await signIn('1042', '8598');
log(Boolean(admin && supervisor && marcus && alexis), 'signed in as administrator, supervisor and two officers');

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
};
// A tiny valid PNG, as a phone camera would send a receipt photo.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function claim(fields, { token = alexis, receipt = null, type = 'image/png' } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) form.set(k, String(v));
  if (receipt) form.set('receipt', new Blob([receipt], { type }), type === 'image/png' ? 'receipt.png' : 'receipt.txt');
  const res = await fetch(`${BASE}/expenses`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* nothing */
  }
  return { status: res.status, data };
}
const decide = (id, action, body = {}, token = admin) => call(`/expenses/${id}/${action}`, { token, method: 'POST', body });

/* ============================================================== claiming === */
section('making a claim');

const base = { category: 'parking', incurredOn: daysAgo(0), amount: '12.00', description: 'Garage at the hospital while covering a shift.' };
const parking = await claim(base);
log(parking.status === 201 && parking.data.claim.amount === 12 && parking.data.claim.status === 'pending', 'an officer claims $12 of parking, no receipt needed', parking.data?.error);
log((await claim({ ...base, incurredOn: daysAgo(-2) })).status === 422, 'not for a date still to come');
log((await claim({ ...base, incurredOn: daysAgo(90) })).status === 422, 'nor for one more than 60 days ago');
log((await claim({ ...base, amount: '1500' })).status === 422, 'nor for more than $1,000 at once');
log((await claim({ ...base, description: 'hi' })).status === 422, 'and it says what it was for');
const noReceipt = await claim({ ...base, category: 'supplies', amount: '40.00' });
log(noReceipt.status === 422 && noReceipt.data.details?.[0]?.field === 'receipt', 'anything over $25 needs a receipt', noReceipt.data?.error);
log((await claim({ ...base, category: 'supplies', amount: '40.00' }, { receipt: Buffer.from('not a picture'), type: 'text/plain' })).status === 422,
  'and a receipt is a photo or a PDF');
const supplies = await claim({ ...base, category: 'supplies', amount: '40.00', description: 'Rain gear for the gate post.' }, { receipt: PNG });
log(supplies.status === 201 && supplies.data.claim.has_receipt, 'with a photo of the receipt it goes in');
log((await claim({ ...base, category: 'mileage', amount: undefined })).status === 422, 'mileage needs the miles');
const mileage = await claim({ category: 'mileage', incurredOn: daysAgo(1), miles: '20', description: 'Riverfront to Capital Plaza and back.' });
log(mileage.status === 201 && mileage.data.claim.amount === 14 && mileage.data.claim.miles === 20, 'mileage is priced at the IRS rate: 20 miles is $14.00');

const mine = (await call('/expenses/mine', { token: alexis })).data;
log(mine.claims.length >= 3 && mine.summary.pending >= 66 && mine.rules.mileageRateCents === 70, 'the officer sees their claims and what is waiting', `$${mine.summary.pending}`);
log(!(await call('/expenses/mine', { token: marcus })).data.claims.some((c) => c.id === parking.data.claim.id), 'and nobody else\'s');

/* =============================================================== receipts === */
section('the receipt');

const receiptUrl = `${BASE}/expenses/${supplies.data.claim.id}/receipt`;
const get = (token) => fetch(receiptUrl, { headers: { Authorization: `Bearer ${token}` } });
const own = await get(alexis);
log(own.status === 200 && own.headers.get('content-type') === 'image/png', 'the officer can open their receipt');
log(/sandbox/.test(own.headers.get('content-security-policy') || ''), 'served so nothing in it can run');
log((await get(marcus)).status === 404, 'another officer cannot');
log((await get(supervisor)).status === 200, 'a supervisor can');
log((await fetch(`${BASE}/expenses/${parking.data.claim.id}/receipt`, { headers: { Authorization: `Bearer ${alexis}` } })).status === 404, 'a claim without one says so');

/* ============================================================== deciding === */
section('deciding');

const queue = await call('/expenses?status=pending', { token: supervisor });
log(queue.status === 200 && queue.data.claims.some((c) => c.id === parking.data.claim.id), 'supervisors see the claims waiting');
log((await call('/expenses', { token: alexis })).status === 403, 'officers do not');
log((await decide(parking.data.claim.id, 'approve', {}, supervisor)).status === 403, 'only an administrator decides');
const alerts = (await call('/admin/alerts', { token: admin })).data.alerts;
log(alerts.some((a) => a.key === `expense:${parking.data.claim.id}`), 'a new claim is in the alerts inbox');
log((await call('/admin/dashboard', { token: admin })).data.counts.pendingExpenses >= 3, 'and counted on the dashboard');

const approved = await decide(parking.data.claim.id, 'approve');
log(approved.status === 200 && approved.data.claim.status === 'approved' && approved.data.claim.decided_by === 'Vince Ortega', 'an administrator approves the parking');
log((await decide(parking.data.claim.id, 'approve')).status === 409, 'once');
log((await decide(supplies.data.claim.id, 'decline', {})).status === 422, 'a decline says why');
const declined = await decide(supplies.data.claim.id, 'decline', { note: 'The site issues rain gear; ask your supervisor.' });
log(declined.status === 200 && declined.data.claim.decision_note.includes('rain gear'), 'and the officer reads the reason');
log((await call(`/expenses/${mileage.data.claim.id}/withdraw`, { token: marcus, method: 'POST' })).status === 404, 'nobody else can withdraw a claim');
log((await call(`/expenses/${mileage.data.claim.id}/withdraw`, { token: alexis, method: 'POST' })).data.claim.status === 'withdrawn', 'the officer withdraws the mileage');
log((await call(`/expenses/${parking.data.claim.id}/withdraw`, { token: alexis, method: 'POST' })).status === 409, 'but not a claim already decided');

const selfClaim = await claim({ ...base, description: 'Parking at head office for the audit.' }, { token: admin });
log(selfClaim.status === 201 && (await decide(selfClaim.data.claim.id, 'approve')).status === 403, 'an administrator cannot approve their own claim');
await decide(selfClaim.data.claim.id, 'decline', { note: 'Test claim, declined by the suite.' }, admin).catch(() => {});

/* =============================================================== payroll === */
section('paid with the payroll');

// A week of its own, five weeks back: Monday to Sunday.
const monday = new Date();
monday.setHours(12, 0, 0, 0);
monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 35);
const sunday = new Date(monday);
sunday.setDate(sunday.getDate() + 6);
const week = await call('/admin/payroll/periods', { token: admin, method: 'POST', body: { periodStart: ymd(monday), periodEnd: ymd(sunday) } });
log(week.status === 201, 'a pay period for a quiet week five weeks back', week.data?.error);
const periodId = week.data.period.id;
const inWeek = ymd(new Date(monday.getTime() + 2 * 86400000));

const waiting = await claim({ category: 'tolls', incurredOn: inWeek, amount: '8.50', description: 'Turnpike to the Pensacola relief shift.' });
let period = (await call(`/admin/payroll/periods/${periodId}`, { token: admin })).data;
log(period.blockers.some((b) => b.code === 'expenses'), 'a claim waiting for a decision holds up closing the week it falls in');
log((await call(`/admin/payroll/periods/${periodId}/close`, { token: admin, method: 'POST' })).status === 409, 'the close is refused');
await decide(waiting.data.claim.id, 'approve');
period = (await call(`/admin/payroll/periods/${periodId}`, { token: admin })).data;
log(!period.blockers.some((b) => b.code === 'expenses') && period.expenses.claims.some((c) => c.id === waiting.data.claim.id),
  'approved, it is listed to be paid by that close');
log(period.totals.reimbursements >= 8.5 && period.totals.gross_cents >= 0, 'as a reimbursement, apart from the gross pay', `$${period.totals.reimbursements}`);

const closed = await call(`/admin/payroll/periods/${periodId}/close`, { token: admin, method: 'POST' });
log(closed.status === 200, 'the week closes', closed.data?.error);
const paid = (await call('/expenses/mine', { token: alexis })).data.claims.find((c) => c.id === waiting.data.claim.id);
log(paid.status === 'paid' && paid.paid_in === `${ymd(monday)} to ${ymd(sunday)}`, 'and the claim is paid with it', paid.paid_in);
log((await call('/expenses/mine', { token: alexis })).data.claims.find((c) => c.id === parking.data.claim.id).status === 'approved',
  'a claim from after the week waits for a later close');
const csv = await (await fetch(`${BASE}/admin/payroll/periods/${periodId}/register.csv`, { headers: { Authorization: `Bearer ${admin}` } })).text();
log(csv.split('\n')[0].includes('Reimbursements') && csv.includes('8.5'), 'the payroll register carries the reimbursement');

const reopened = await call(`/admin/payroll/periods/${periodId}/reopen`, { token: admin, method: 'POST', body: { reason: 'Suite check: reopen hands claims back.' } });
const back = (await call('/expenses/mine', { token: alexis })).data.claims.find((c) => c.id === waiting.data.claim.id);
log(reopened.status === 200 && back.status === 'approved' && !back.paid_in, 'reopening the week hands the claim back to waiting');
await call(`/admin/payroll/periods/${periodId}/close`, { token: admin, method: 'POST' });

/* ================================================================= audit === */
const actions = (await call('/admin/audit?action=expense.', { token: admin })).data.entries.map((e) => e.action);
log(['expense.claimed', 'expense.approved', 'expense.declined', 'expense.withdrawn'].every((a) => actions.includes(a)), 'every claim and decision is audited');

finish('Expense claims suite');
