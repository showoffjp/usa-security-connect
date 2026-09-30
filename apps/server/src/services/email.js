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
 * Secrets are never sent by email. A portal contact chooses their own password
 * through a single-use link, so no password ever exists for anyone to leak.
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

/** `skip-link` for messages that already carry a link of their own. */
const signOff = (mode) => {
  const url = publicUrl();
  const showLink = mode !== 'skip-link';
  return [
    '',
    showLink
      ? url
        ? `Sign in: ${url}/portal`
        : 'Sign in to the client portal to see the detail.'
      : null,
    '',
    'USA Security & Protection Group',
    'Licensed Florida security agency - B 3400341',
  ]
    .filter((l) => l !== null)
    .join('\n');
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
 * Carries a single-use link rather than a password. A link expires on its own
 * and works once; an emailed credential outlives the conversation in an inbox.
 */
export async function notifyPortalAccount({ client, sites = [], reset = false, link, expiresAt }) {
  const expires = expiresAt
    ? new Date(expiresAt).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })
    : null;

  return send({
    to: client.email,
    name: client.name,
    kind: reset ? 'portal_password_reset' : 'portal_invited',
    entity: 'client_user',
    entityId: client.id,
    subject: reset
      ? 'Choose a new client portal password'
      : 'Your client portal account is ready',
    body: [
      `Dear ${client.name},`,
      '',
      reset
        ? 'The password for your client portal account has been reset. Choose a new'
        : 'An account has been created for you on the USA Security Connect client',
      reset ? 'one using the link below.' : 'portal. Use the link below to choose your password.',
      '',
      link || 'Your account manager will send you a link to set your password.',
      '',
      expires ? `The link works once and expires on ${expires}.` : 'The link works once.',
      '',
      'We never send a password by email, and nobody here can see the one you',
      'choose. If you did not expect this message, tell your account manager and',
      'ignore the link - it expires on its own.',
      '',
      sites.length > 0 ? `You will see: ${sites.map((s) => s.name).join(', ')}.` : null,
      'In the portal you can see who was on post, patrol records, incident reports',
      'and your invoices.',
      signOff('skip-link'),
    ]
      .filter((l) => l !== null)
      .join('\n'),
  });
}

/**
 * Tell the contact who asked for extra coverage what became of it.
 * `request` carries site_name, starts_at, ends_at, officers, status, response.
 */
export async function notifyCoverageRequestAnswered(request) {
  const contact = request.client_user_id
    ? await db
        .prepare(`SELECT id, email, name FROM client_users WHERE id = ? AND status = 'active'`)
        .get(request.client_user_id)
    : null;
  if (!contact) return 0;

  const when = (iso) =>
    new Date(iso).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York',
    });
  const scheduled = request.status === 'scheduled';
  await send({
    to: contact.email,
    name: contact.name,
    kind: scheduled ? 'coverage_scheduled' : 'coverage_declined',
    entity: 'coverage_request',
    entityId: request.id,
    subject: scheduled
      ? `Extra coverage confirmed - ${request.site_name}`
      : `Extra coverage request - ${request.site_name}`,
    body: [
      `Dear ${contact.name},`,
      '',
      scheduled
        ? `Your request for extra coverage at ${request.site_name} has been scheduled.`
        : `We are unable to cover your request for extra coverage at ${request.site_name}.`,
      '',
      `  From      ${when(request.starts_at)}`,
      `  To        ${when(request.ends_at)}`,
      `  Officers  ${request.officers}${request.armed ? ' (armed)' : ''}`,
      request.response ? '' : null,
      request.response ? `  Note      ${request.response}` : null,
      '',
      scheduled
        ? 'The officers standing it will appear on the coverage record in your portal.'
        : 'Reply to this email or call the office if you would like to talk it through.',
      signOff(),
    ]
      .filter((l) => l !== null)
      .join('\n'),
  });
  return 1;
}

/** A client's requested change to a post's orders, applied or declined. */
export async function notifyOrderRequestAnswered(request) {
  const contact = request.client_user_id
    ? await db
        .prepare(`SELECT id, email, name FROM client_users WHERE id = ? AND status = 'active'`)
        .get(request.client_user_id)
    : null;
  if (!contact) return 0;

  const applied = request.status === 'applied';
  await send({
    to: contact.email,
    name: contact.name,
    kind: applied ? 'post_orders_changed' : 'post_orders_declined',
    entity: 'post_order_request',
    entityId: request.id,
    subject: applied
      ? `Post orders updated - ${request.post_name}, ${request.site_name}`
      : `Your post orders request - ${request.post_name}, ${request.site_name}`,
    body: [
      `Dear ${contact.name},`,
      '',
      applied
        ? `We have changed the orders for ${request.post_name} at ${request.site_name} as you asked. Every officer who works the post is asked to read and acknowledge the new version.`
        : `We have not changed the orders for ${request.post_name} at ${request.site_name} as you asked.`,
      '',
      `  You asked  ${request.body}`,
      request.response ? `  Our reply  ${request.response}` : null,
      '',
      'The orders in force are in your portal under Post orders.',
      signOff(),
    ]
      .filter((l) => l !== null)
      .join('\n'),
  });
  return 1;
}
