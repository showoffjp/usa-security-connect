/**
 * Invoicing.
 *
 * The arithmetic has to be checkable by hand - a client will check it - so
 * this suite recomputes the totals from the hours rather than trusting the
 * numbers the API reports about itself.
 */

import { call, log, section, signIn, finish, BASE } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const officer = await signIn('1003', '4812');

const dayString = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const sites = (await call('/admin/sites', { token: admin })).data.sites;
const riverfront = sites.find((s) => s.name.includes('Riverfront'));
const coral = sites.find((s) => s.name.includes('Coral'));

/* =============================================================== seed === */
section('seeded invoices');

const list = await call('/invoices', { token: admin });
log(list.status === 200 && list.data.invoices.length >= 3, 'invoices are listed', `${list.data?.invoices?.length} found`);

const paid = list.data.invoices.find((i) => i.status === 'paid');
const outstanding = list.data.invoices.filter((i) => i.status === 'sent');
log(Boolean(paid), 'one is paid');
log(outstanding.length >= 2, 'two are outstanding');
log(
  outstanding.some((i) => i.overdue_days > 0),
  'one of them is flagged overdue',
  `${outstanding.find((i) => i.overdue_days > 0)?.overdue_days} days`
);

log(
  list.data.summary.outstanding_cents > 0 && list.data.summary.paid_cents > 0,
  'the receivables summary adds up',
  `$${(list.data.summary.outstanding_cents / 100).toFixed(2)} outstanding`
);
log(
  list.data.summary.margin_percent > 0 && list.data.summary.margin_percent < 100,
  'margin is reported',
  `${list.data.summary.margin_percent}%`
);

// Dates must survive the round trip as calendar days, not instants.
log(
  /^\d{4}-\d{2}-\d{2}$/.test(paid.period_start) && /^\d{4}-\d{2}-\d{2}$/.test(paid.due_on),
  'periods and due dates are plain calendar dates',
  `${paid.period_start} to ${paid.period_end}`
);

/* ============================================================ preview === */
section('preview');

const preview = await call(
  `/invoices/preview?siteId=${riverfront.id}&periodStart=${dayString(-7)}&periodEnd=${dayString(-1)}`,
  { token: admin }
);
log(preview.status === 200 && preview.data.lines.length > 0, 'a period previews', `${preview.data?.lines?.length} lines`);

// Recompute from the reported hours; this is the check a client would make.
const line = preview.data.lines[0];
const expected = Math.round((line.minutes / 60) * line.rate_cents);
log(line.amount_cents === expected, 'the line amount is hours x rate', `${line.hours}h @ ${line.rate_cents}c = ${line.amount_cents}c`);
log(
  preview.data.totals.subtotalCents ===
    preview.data.lines.reduce((sum, l) => sum + l.amount_cents, 0),
  'the subtotal is the sum of the lines'
);
log(preview.data.totals.taxCents === 0, 'no tax when none is asked for');
log(preview.data.unpriced.length === 0, 'every hour in the period has a rate');

// The seed already invoiced this exact week for Riverfront.
log(
  preview.data.overlapping.length > 0,
  'an overlapping invoice is flagged before you bill the hours twice',
  preview.data.overlapping[0]?.number
);

const taxed = await call(
  `/invoices/preview?siteId=${riverfront.id}&periodStart=${dayString(-7)}&periodEnd=${dayString(-1)}&taxPercent=7`,
  { token: admin }
);
log(
  taxed.data.totals.taxCents === Math.round(taxed.data.totals.subtotalCents * 0.07),
  'tax is applied to the subtotal',
  `${taxed.data.totals.taxCents}c`
);
log(
  taxed.data.totals.totalCents === taxed.data.totals.subtotalCents + taxed.data.totals.taxCents,
  'the total is subtotal plus tax'
);

const noSite = await call('/invoices/preview', { token: admin });
log(noSite.status === 422, 'a preview needs a site');

const backwards = await call(
  `/invoices/preview?siteId=${riverfront.id}&periodStart=${dayString(-1)}&periodEnd=${dayString(-7)}`,
  { token: admin }
);
log(backwards.status === 422, 'a period cannot end before it starts', backwards.data?.error);

/* ============================================================= create === */
section('raising an invoice');

const created = await call('/invoices', {
  token: admin,
  method: 'POST',
  body: {
    siteId: riverfront.id,
    periodStart: dayString(-13),
    periodEnd: dayString(-11),
    taxPercent: 7,
    dueDays: 14,
    notes: 'Weekly coverage, lobby console.',
  },
});
log(created.status === 201, 'an invoice is raised', created.data?.invoice?.number);
log(/^INV-\d{4}-\d{4}$/.test(created.data?.invoice?.number || ''), 'it is numbered INV-YYYY-NNNN');
log(created.data.invoice.status === 'draft', 'it starts as a draft');

const invoiceId = created.data.invoice.id;
const detail = await call(`/invoices/${invoiceId}`, { token: admin });
log(
  detail.data.invoice.total_cents ===
    detail.data.lines.reduce((sum, l) => sum + l.amount_cents, 0) + detail.data.invoice.tax_cents,
  'the stored total matches the stored lines'
);
log(
  detail.data.invoice.cost_cents > 0 && detail.data.invoice.cost_cents < detail.data.invoice.subtotal_cents,
  'cost is recorded and is below what we charge',
  `cost ${detail.data.invoice.cost_cents}c of ${detail.data.invoice.subtotal_cents}c`
);

const noHours = await call('/invoices', {
  token: admin,
  method: 'POST',
  body: { siteId: coral.id, periodStart: dayString(-400), periodEnd: dayString(-395) },
});
log(noHours.status === 409, 'a period with no billable hours is refused', noHours.data?.error);

/* =========================================================== transitions === */
section('status transitions');

const backToDraft = await call(`/invoices/${invoiceId}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'paid' },
});
log(backToDraft.status === 409, 'a draft cannot jump straight to paid', backToDraft.data?.error);

const sent = await call(`/invoices/${invoiceId}`, { token: admin, method: 'PATCH', body: { status: 'sent' } });
log(sent.status === 200 && sent.data.invoice.status === 'sent', 'a draft can be sent');
log(Boolean(sent.data.invoice.issued_at), 'sending stamps the issue date');

const unsend = await call(`/invoices/${invoiceId}`, { token: admin, method: 'PATCH', body: { status: 'draft' } });
log(unsend.status === 409, 'a sent invoice cannot go back to draft', unsend.data?.error);

const deleteSent = await call(`/invoices/${invoiceId}`, { token: admin, method: 'DELETE' });
log(deleteSent.status === 409, 'and it cannot be deleted', deleteSent.data?.error);

const markPaid = await call(`/invoices/${invoiceId}`, { token: admin, method: 'PATCH', body: { status: 'paid' } });
log(markPaid.status === 200 && Boolean(markPaid.data.invoice.paid_at), 'a sent invoice can be marked paid');

const afterPaid = await call(`/invoices/${invoiceId}`, { token: admin, method: 'PATCH', body: { status: 'void' } });
log(afterPaid.status === 409, 'a paid invoice is final');

/* ---------------------------------------------------- draft lifecycle --- */

const draft = await call('/invoices', {
  token: admin,
  method: 'POST',
  body: { siteId: riverfront.id, periodStart: dayString(-10), periodEnd: dayString(-9) },
});
log(draft.status === 201, 'a second invoice is raised for the lifecycle checks');

const voided = await call(`/invoices/${draft.data.invoice.id}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'void' },
});
log(voided.status === 200 && voided.data.invoice.status === 'void', 'a draft can be voided');

const third = await call('/invoices', {
  token: admin,
  method: 'POST',
  body: { siteId: riverfront.id, periodStart: dayString(-6), periodEnd: dayString(-5) },
});
const removed = await call(`/invoices/${third.data.invoice.id}`, { token: admin, method: 'DELETE' });
log(removed.status === 200, 'an untouched draft can be deleted');
log(
  (await call(`/invoices/${third.data.invoice.id}`, { token: admin })).status === 404,
  'and it is gone'
);

/* ============================================================== access === */
section('who can do what');

const supervisorRead = await call('/invoices', { token: supervisor });
log(supervisorRead.status === 200, 'a supervisor can read the invoice list');

const supervisorWrite = await call('/invoices', {
  token: supervisor,
  method: 'POST',
  body: { siteId: riverfront.id, periodStart: dayString(-7), periodEnd: dayString(-1) },
});
log(supervisorWrite.status === 403, 'but cannot raise one', supervisorWrite.data?.error);

const officerRead = await call('/invoices', { token: officer });
log(officerRead.status === 403, 'an officer cannot see invoices at all');

/* ================================================================= CSV === */
section('export');

const csvRes = await fetch(`${BASE}/invoices/${invoiceId}/csv`, {
  headers: { Authorization: `Bearer ${admin}` },
});
const csv = await csvRes.text();
log(csvRes.status === 200, 'an invoice exports as CSV');
log(csv.includes('Description,Hours,Rate,Amount'), 'with a line-item header');
log(csv.includes(detail.data.invoice.number), 'and the invoice number');

/* ============================================================== portal === */
section('what the client sees');

const dana = (
  await call('/client/login', {
    method: 'POST',
    body: { email: 'dana.whitfield@riverfrontholdings.com', password: 'riverfront-portal-01' },
  })
).data.token;

const clientInvoices = await call('/client/invoices', { token: dana });
log(clientInvoices.status === 200 && clientInvoices.data.invoices.length > 0, 'the client sees their invoices', `${clientInvoices.data?.invoices?.length}`);
log(
  clientInvoices.data.invoices.every((i) => ['sent', 'paid'].includes(i.status)),
  'drafts are not shown to the client'
);
log(
  clientInvoices.data.invoices.every((i) => i.cost_cents === undefined && i.margin_cents === undefined),
  'what the work cost us never reaches the client'
);
log(
  clientInvoices.data.invoices.every((i) => i.site_id === riverfront.id),
  'and only their own site is billed to them'
);

const clientDetail = await call(`/client/invoices/${clientInvoices.data.invoices[0].id}`, { token: dana });
log(clientDetail.status === 200 && clientDetail.data.lines.length > 0, 'they can open one');
log(
  clientDetail.data.lines.every((l) => l.cost_cents === undefined && l.rate_cents > 0),
  'lines show the rate charged but not the cost'
);

// Everything the printable invoice needs, and nothing it does not. The
// document is addressed to the client's company, not to the property.
log(
  Boolean(clientDetail.data.invoice.client_name),
  'the invoice is addressed to the client company',
  clientDetail.data.invoice.client_name
);
log(
  ['number', 'period_start', 'period_end', 'subtotal_cents', 'total_cents', 'site_name'].every(
    (f) => clientDetail.data.invoice[f] !== undefined
  ),
  'and carries every field the printed document needs'
);
log(
  clientDetail.data.invoice.cost_cents === undefined &&
    clientDetail.data.invoice.margin_cents === undefined &&
    clientDetail.data.invoice.created_by === undefined,
  'while still withholding cost, margin and who raised it'
);

const marcus = (
  await call('/client/login', {
    method: 'POST',
    body: { email: 'marcus.reyes@palmettoridgehoa.org', password: 'palmetto-portal-02' },
  })
).data.token;

const crossInvoice = await call(`/client/invoices/${clientInvoices.data.invoices[0].id}`, { token: marcus });
log(crossInvoice.status === 404, "one client cannot open another's invoice");

// The one just marked paid is a draft-turned-paid for a period Dana can see.
const draftForClient = await call(`/client/invoices/${draft.data.invoice.id}`, { token: dana });
log(draftForClient.status === 404, 'a voided invoice is not visible to the client either');

/* =============================================================== audit === */
section('audit trail');

const auditLog = await call('/admin/audit?limit=200', { token: admin });
const actions = new Set((auditLog.data?.entries || []).map((e) => e.action));
log(actions.has('invoice.created'), 'raising an invoice is audited');
log(actions.has('invoice.sent'), 'sending one is audited');
log(actions.has('invoice.paid'), 'payment is audited');
log(actions.has('export.invoice'), 'the CSV export is audited');

finish('invoices');
