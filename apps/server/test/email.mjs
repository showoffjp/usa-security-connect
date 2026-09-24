/**
 * Outbound email.
 *
 * The suite runs with delivery switched off, which is also how the system
 * behaves before anyone configures a provider - so this checks the thing that
 * matters either way: that the right message is composed, addressed to the
 * right people, recorded so somebody can see it, and carries no secret.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const officer = await signIn('1003', '4812');

const dayString = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const sites = (await call('/admin/sites', { token: admin })).data.sites;
const riverfront = sites.find((s) => s.name.includes('Riverfront'));

const outbox = async () => (await call('/admin/emails?limit=300', { token: admin })).data;

/* ============================================================= outbox === */
section('the outbox');

const start = await outbox();
log(start.emails !== undefined, 'the outbox is readable');
log(
  ['resend', 'disabled', 'not-configured'].includes(start.delivery),
  'it reports how delivery is configured',
  start.delivery
);

const officerView = await call('/admin/emails', { token: officer });
log(officerView.status === 403, 'an officer cannot read the outbox');

/* ==================================================== portal invitation === */
section('a new portal contact');

const created = await call('/admin/clients', {
  token: admin,
  method: 'POST',
  body: {
    email: 'theresa.lang@coralbaypg.com',
    name: 'Theresa Lang',
    company: 'Coral Bay Property Group',
    siteIds: [sites.find((s) => s.name.includes('Coral')).id],
  },
});
log(created.status === 201, 'the login is created');

const afterInvite = await outbox();
const invite = afterInvite.emails.find(
  (e) => e.kind === 'portal_invited' && e.to_email === 'theresa.lang@coralbaypg.com'
);
log(Boolean(invite), 'an invitation is recorded');
log(invite?.to_name === 'Theresa Lang', 'addressed to the contact by name');
log(
  invite?.status === 'skipped' || invite?.status === 'sent',
  'and marked either sent or skipped, never left queued',
  invite?.status
);

const inviteBody = (await call(`/admin/emails/${invite.id}`, { token: admin })).data.email;

// The single most important check here.
log(
  !/password is\s+\S+/i.test(inviteBody.body) && created.data.password === undefined,
  'there is no password anywhere - none was ever generated'
);
log(
  inviteBody.body.includes(created.data.link),
  'the message carries the single-use link'
);
log(
  /never send a password by email/i.test(inviteBody.body),
  'and says explicitly that a password is never emailed'
);
log(/works once/i.test(inviteBody.body), 'it tells them the link is single-use');
log(inviteBody.body.includes('Coral Bay Retail Plaza'), 'it names the property they will see');

/* ======================================================= password reset === */
section('a password reset');

const reset = await call(`/admin/clients/${created.data.client.id}/reset-password`, {
  token: admin,
  method: 'POST',
});
log(reset.status === 200, 'the password is reset');

const afterReset = await outbox();
const notice = afterReset.emails.find(
  (e) => e.kind === 'portal_password_reset' && e.to_email === 'theresa.lang@coralbaypg.com'
);
log(Boolean(notice), 'a reset notice is recorded');

const noticeBody = (await call(`/admin/emails/${notice.id}`, { token: admin })).data.email;
log(reset.data.password === undefined, 'the reset returns no password either');
log(noticeBody.body.includes(reset.data.link), 'the reset notice carries its own link');

/* ====================================================== invoice issued === */
section('issuing an invoice tells the client');

const invoice = await call('/invoices', {
  token: admin,
  method: 'POST',
  body: { siteId: riverfront.id, periodStart: dayString(-13), periodEnd: dayString(-12) },
});
log(invoice.status === 201, 'an invoice is raised for Riverfront');

const beforeIssue = (await outbox()).emails.length;

const issued = await call(`/invoices/${invoice.data.invoice.id}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'sent' },
});
log(issued.status === 200, 'and issued');
log(issued.data.notified >= 1, 'the response reports who was notified', `${issued.data?.notified} contact(s)`);

const afterIssue = await outbox();
log(afterIssue.emails.length > beforeIssue, 'the outbox grew');

const sent = afterIssue.emails.find(
  (e) => e.kind === 'invoice_issued' && e.entity_id === invoice.data.invoice.id
);
log(Boolean(sent), 'an invoice notice is recorded against the invoice');
log(
  sent?.to_email === 'dana.whitfield@riverfrontholdings.com',
  "addressed to that site's contact",
  sent?.to_email
);
log(sent?.subject.includes(invoice.data.invoice.number), 'the subject carries the invoice number');

const sentBody = (await call(`/admin/emails/${sent.id}`, { token: admin })).data.email;
log(sentBody.body.includes('Dana Whitfield'), 'it greets the contact by name');
log(/\$\d/.test(sentBody.body), 'it states the amount due');
log(
  !/cost|margin|pay rate/i.test(sentBody.body),
  'and says nothing about what the work cost us'
);

// A contact at another property must not be told about this invoice.
log(
  !afterIssue.emails.some(
    (e) => e.kind === 'invoice_issued' && e.entity_id === invoice.data.invoice.id
      && e.to_email === 'marcus.reyes@palmettoridgehoa.org'
  ),
  "a different client's contact is not notified"
);

/* ============================================================ no repeat === */
section('issuing is a one-off');

const before = (await outbox()).emails.filter((e) => e.entity_id === invoice.data.invoice.id).length;
const paid = await call(`/invoices/${invoice.data.invoice.id}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'paid' },
});
log(paid.status === 200, 'the invoice is marked paid');
const after = (await outbox()).emails.filter((e) => e.entity_id === invoice.data.invoice.id).length;
log(after === before, 'marking it paid does not email the client again');

/* ============================================================== hygiene === */
section('recording hygiene');

const all = (await outbox()).emails;
log(all.every((e) => e.to_email && e.subject), 'every recorded message has a recipient and a subject');
log(all.every((e) => e.status !== 'queued'), 'nothing is left stuck in queued');
log(
  all.every((e) => !/password is [a-z-]+\d/i.test(e.subject)),
  'no subject line leaks a credential'
);

// Tidy up so a rerun starts clean.
await call(`/admin/clients/${created.data.client.id}`, { token: admin, method: 'DELETE' });

finish('email');
