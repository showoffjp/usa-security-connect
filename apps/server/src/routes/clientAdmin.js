/**
 * Managing client-portal logins, from the admin console.
 *
 * Kept out of admin.js because it is the only place staff touch the separate
 * client identity space, and mixing the two files is how the two get confused.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { publicClient, createPasswordToken } from '../lib/clientAuth.js';
import { ROLES } from '../shared.js';
import { notifyPortalAccount, publicUrl } from '../services/email.js';

export const clientAdminRouter = Router();
clientAdminRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

const onlyAdmin = requireRole(ROLES.ADMIN);

/**
 * The link a contact follows to choose their password.
 *
 * Falls back to a bare path when USC_PUBLIC_URL is unset, so a developer
 * still gets something they can paste after localhost.
 */
const setPasswordLink = (token) =>
  `${publicUrl() || ''}/portal/set-password?token=${encodeURIComponent(token)}`;
const TIMES = ['created_at', 'last_login_at'];

const contactSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  name: z.string().min(2, 'Enter the contact’s name.'),
  company: z.string().max(120).optional().nullable(),
  siteIds: z.array(z.number().int().positive()).default([]),
});

/** Sites exist before contacts do, so a bad id is a mistake worth reporting. */
async function assertSitesExist(siteIds) {
  if (siteIds.length === 0) return;
  const found = await db
    .prepare(`SELECT id FROM sites WHERE id IN (${siteIds.map(() => '?').join(',')})`)
    .all(...siteIds);
  if (found.length !== siteIds.length) throw new HttpError(422, 'One of those sites no longer exists.');
}

async function setSites(clientUserId, siteIds) {
  await db.prepare(`DELETE FROM client_sites WHERE client_user_id = ?`).run(clientUserId);
  for (const siteId of siteIds) {
    await db
      .prepare(`INSERT INTO client_sites (client_user_id, site_id) VALUES (?,?)`)
      .run(clientUserId, siteId);
  }
}

/* ----------------------------------------------------------------- list --- */

clientAdminRouter.get(
  '/',
  wrap(async (_req, res) => {
    const rows = await db
      .prepare(
        `SELECT c.*, u.first_name AS created_by_first, u.last_name AS created_by_last
         FROM client_users c
         LEFT JOIN users u ON u.id = c.created_by
         ORDER BY c.company NULLS LAST, c.name`
      )
      .all();

    const links = await db
      .prepare(
        `SELECT cs.client_user_id, s.id, s.name
         FROM client_sites cs JOIN sites s ON s.id = cs.site_id
         ORDER BY s.name`
      )
      .all();

    res.json({
      clients: rows.map((r) => ({
        ...isoFields(publicClient(r), TIMES),
        created_by_name: r.created_by_first ? `${r.created_by_first} ${r.created_by_last}` : null,
        created_by_first: undefined,
        created_by_last: undefined,
        sites: links.filter((l) => l.client_user_id === r.id).map(({ id, name }) => ({ id, name })),
      })),
    });
  })
);

/* --------------------------------------------------------------- create --- */

clientAdminRouter.post(
  '/',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(contactSchema, req.body);
    await assertSitesExist(body.siteIds);

    const existing = await db
      .prepare(`SELECT id FROM client_users WHERE lower(email) = lower(?)`)
      .get(body.email.trim());
    if (existing) {
      throw new HttpError(409, 'A portal login already exists for that email address.');
    }

    // No password is set here at all. The contact chooses their own through a
    // single-use link, so one never exists in a form somebody could read out,
    // paste into a chat, or leave in an inbox.
    const created = await db
      .prepare(
        `INSERT INTO client_users (email, name, company, created_by)
         VALUES (?,?,?,?)`
      )
      .run(body.email.trim(), body.name.trim(), body.company?.trim() || null, req.user.id);

    const id = Number(created.lastInsertRowid);
    await setSites(id, body.siteIds);
    await audit(req.user.id, 'client.created', 'client_user', id, { sites: body.siteIds.length }, req.ip);

    const row = await db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(id);

    // Tells them the account exists; deliberately carries no password.
    const sites = body.siteIds.length
      ? await db
          .prepare(`SELECT name FROM sites WHERE id IN (${body.siteIds.map(() => '?').join(',')})`)
          .all(...body.siteIds)
      : [];
    const { token, expiresAt } = await createPasswordToken({
      clientUserId: id,
      purpose: 'invite',
      createdBy: req.user.id,
    });
    const link = setPasswordLink(token);
    const notice = await notifyPortalAccount({ client: row, sites, link, expiresAt });

    res.status(201).json({
      client: isoFields(publicClient(row), TIMES),
      link,
      expiresAt: expiresAt.toISOString(),
      note: 'Send this link to the contact. It works once and cannot be shown again.',
      emailed: notice.ok,
    });
  })
);

/* --------------------------------------------------------------- update --- */

clientAdminRouter.patch(
  '/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const client = await db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(req.params.id);
    if (!client) throw new HttpError(404, 'Client login not found.');

    const body = parse(
      z.object({
        name: z.string().min(2).optional(),
        company: z.string().max(120).optional().nullable(),
        status: z.enum(['active', 'suspended']).optional(),
        siteIds: z.array(z.number().int().positive()).optional(),
      }),
      req.body
    );

    const fields = [];
    const values = [];
    for (const key of ['name', 'company', 'status']) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(typeof body[key] === 'string' ? body[key].trim() || null : body[key]);
      }
    }
    if (fields.length > 0) {
      await db.prepare(`UPDATE client_users SET ${fields.join(', ')} WHERE id = ?`).run(...values, client.id);
    }

    if (body.siteIds) {
      await assertSitesExist(body.siteIds);
      await setSites(client.id, body.siteIds);
    }

    await audit(req.user.id, 'client.updated', 'client_user', client.id, body, req.ip);
    const row = await db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(client.id);
    res.json({ client: isoFields(publicClient(row), TIMES) });
  })
);

/* ------------------------------------------------------ password / lock --- */

clientAdminRouter.post(
  '/:id/reset-password',
  onlyAdmin,
  wrap(async (req, res) => {
    const client = await db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(req.params.id);
    if (!client) throw new HttpError(404, 'Client login not found.');

    // The old password stops working immediately and every open session goes
    // with it - that is the point of a reset when a laptop has gone missing.
    // The contact then chooses a new one through the link.
    await db
      .prepare(
        `UPDATE client_users
         SET password_hash = NULL, password_salt = NULL,
             token_version = token_version + 1,
             failed_attempts = 0, locked_until = NULL
         WHERE id = ?`
      )
      .run(client.id);

    await audit(req.user.id, 'client.password_reset', 'client_user', client.id, null, req.ip);

    const { token, expiresAt } = await createPasswordToken({
      clientUserId: client.id,
      purpose: 'reset',
      createdBy: req.user.id,
    });
    const link = setPasswordLink(token);
    const notice = await notifyPortalAccount({ client, reset: true, link, expiresAt });

    res.json({
      email: client.email,
      link,
      expiresAt: expiresAt.toISOString(),
      note: 'Send this link to the contact. It works once and cannot be shown again.',
      emailed: notice.ok,
    });
  })
);

clientAdminRouter.post(
  '/:id/unlock',
  wrap(async (req, res) => {
    await db
      .prepare(`UPDATE client_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?`)
      .run(req.params.id);
    await audit(req.user.id, 'client.unlocked', 'client_user', Number(req.params.id), null, req.ip);
    res.json({ ok: true });
  })
);

/* --------------------------------------------------------------- delete --- */

clientAdminRouter.delete(
  '/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const client = await db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(req.params.id);
    if (!client) throw new HttpError(404, 'Client login not found.');

    await db.prepare(`DELETE FROM client_users WHERE id = ?`).run(client.id);
    await audit(req.user.id, 'client.deleted', 'client_user', client.id, { email: client.email }, req.ip);
    res.json({ ok: true });
  })
);
