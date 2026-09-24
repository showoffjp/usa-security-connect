/**
 * Outbound email.
 *
 * Two rules shape this file.
 *
 * First, nothing here may break a request. An invoice is still issued and a
 * portal account still created if the mail provider is down; the failure is
 * recorded and the caller carries on. Same contract as push delivery.
 *
 * Second, every message is written to the `emails` table before any attempt is
 * made to send it, and the row keeps its outcome. With no API key configured
 * nothing leaves the building and rows land as 'skipped' - visible in the
 * admin console, so "did the client get told?" has an answer either way.
 *
 * Secrets are never sent by email. A portal password is given to a contact by
 * their account manager; the message only tells them an account exists.
 */

import { db } from '../lib/db.js';

const API_KEY = process.env.USC_EMAIL_API_KEY || '';
const FROM = process.env.USC_EMAIL_FROM || 'USA Security Connect <onboarding@resend.dev>';
const DISABLED = process.env.USC_EMAIL_DISABLED === '1';

/** Where a recipient should click to reach the portal. */
export const publicUrl = () => (process.env.USC_PUBLIC_URL || '').replace(/\/+$/, '');

export const configured = Boolean(API_KEY) && !DISABLED;
export const emailKind = configured ? 'resend' : DISABLED ? 'disabled' : 'not-configured';

/** Enough to catch a typo or an empty column; real validation is the provider's job. */
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

async function record({ to, name, subject, body, kind, entity, entityId, status, error }) {
  const row = await db
    .prepare(
      `INSERT INTO emails (to_email, to_name, subject, body, kind, entity, entity_id, status, provider, error)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      String(to).trim(),
      name || null,
      subject,
      body,
      kind,
      entity || null,
      entityId ?? null,
      status,
      configured ? 'resend' : null,
      error || null
    );
  return Number(row.lastInsertRowid);
}

/**
 * Send one message.
 *
 * Always resolves. The returned `ok` says whether it actually went out, which
 * is not the same as whether the caller succeeded.
 */
export async function send({ to, name, subject, body, kind, entity, entityId }) {
  if (!looksLikeEmail(to)) {
    return { ok: false, reason: 'invalid_address' };
  }

  if (!configured) {
    const id = await record({
      to, name, subject, body, kind, entity, entityId,
      status: 'skipped',
      error: DISABLED ? 'Email delivery is switched off.' : 'No USC_EMAIL_API_KEY is set.',
    });
    return { ok: false, reason: emailKind, id };
  }

  const id = await record({ to, name, subject, body, kind, entity, entityId, status: 'queued' });

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [name ? `${name} <${to}>` : to],
        subject,
        text: body,
      }),
    });

    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      const message = payload?.message || `Provider returned ${res.status}.`;
      await db
        .prepare(`UPDATE emails SET status = 'failed', error = ? WHERE id = ?`)
        .run(String(message).slice(0, 500), id);
      console.error('[usc] email failed:', message);
      return { ok: false, reason: 'provider_error', id, error: message };
    }

    await db
      .prepare(`UPDATE emails SET status = 'sent', provider_id = ?, sent_at = now() WHERE id = ?`)
      .run(payload?.id || null, id);
    return { ok: true, id };
  } catch (err) {
    await db
      .prepare(`UPDATE emails SET status = 'failed', error = ? WHERE id = ?`)
      .run(String(err.message).slice(0, 500), id);
    console.error('[usc] email failed:', err.message);
    return { ok: false, reason: 'network_error', id, error: err.message };
  }
}

/** Fire and forget, for the places that must not wait on a mail server. */
export function sendAsync(message) {
  send(message).catch((err) => console.error('[usc] email crashed:', err.message));
}

/* ------------------------------------------------------------ messages --- */

const signOff = () => {
  const url = publicUrl();
  return [
    '',
    url ? `Sign in: ${url}/portal` : 'Sign in to the client portal to see the detail.',
    '',
    'USA Security & Protection Group',
    'Licensed Florida security agency - B 3400341',
  ].join('\n');
};

const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;

/** Tell a site's contacts that an invoice has been issued. */
export async function notifyInvoiceIssued(invoice) {
  const contacts = await db
    .prepare(
      `SELECT DISTINCT c.id, c.email, c.name
       FROM client_users c
       JOIN client_sites cs ON cs.client_user_id = c.id
       WHERE cs.site_id = ? AND c.status = 'active'`
    )
    .all(invoice.site_id);

  for (const contact of contacts) {
    await send({
      to: contact.email,
      name: contact.name,
      kind: 'invoice_issued',
      entity: 'invoice',
      entityId: invoice.id,
      subject: `Invoice ${invoice.number} - ${invoice.site_name}`,
      body: [
        `Dear ${contact.name},`,
        '',
        `Invoice ${invoice.number} for ${invoice.site_name} is now available.`,
        '',
        `  Service period  ${invoice.period_start} to ${invoice.period_end}`,
        `  Amount due      ${money(invoice.total_cents)}`,
        invoice.due_on ? `  Payment due     ${invoice.due_on}` : null,
        '',
        'The invoice lists the hours billed, post by post. The coverage record in',
        'your portal shows those same hours shift by shift.',
        signOff(),
      ]
        .filter((l) => l !== null)
        .join('\n'),
    });
  }

  return contacts.length;
}

/**
 * Tell a new contact their portal account exists.
 *
 * Deliberately carries no password. Whoever creates the account reads it to
 * them; an emailed credential outlives the conversation in an inbox.
 */
export async function notifyPortalAccount({ client, sites = [], reset = false }) {
  const url = publicUrl();
  return send({
    to: client.email,
    name: client.name,
    kind: reset ? 'portal_password_reset' : 'portal_invited',
    entity: 'client_user',
    entityId: client.id,
    subject: reset
      ? 'Your client portal password has been reset'
      : 'Your client portal account is ready',
    body: [
      `Dear ${client.name},`,
      '',
      reset
        ? 'The password for your client portal account has been reset. Your account'
        : 'An account has been created for you on the USA Security Connect client',
      reset
        ? 'manager will pass the new password to you directly.'
        : 'portal. Your account manager will pass your password to you directly.',
      '',
      'For your security the password is never sent by email.',
      '',
      sites.length > 0 ? `You will see: ${sites.map((s) => s.name).join(', ')}.` : null,
      '',
      url ? `The portal is at ${url}/portal` : null,
      'There you can see who was on post, patrol records, incident reports and',
      'your invoices.',
      signOff(),
    ]
      .filter((l) => l !== null)
      .join('\n'),
  });
}
