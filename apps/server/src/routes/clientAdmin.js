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
import { hashPassword, generatePassword, publicClient } from '../lib/clientAuth.js';
import { ROLES } from '../shared.js';

export const clientAdminRouter = Router();
clientAdminRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

const onlyAdmin = requireRole(ROLES.ADMIN);
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

    // Generated rather than chosen, so a weak password never reaches the table.
    const password = generatePassword();
    const { hash, salt } = hashPassword(password);

    const created = await db
      .prepare(
        `INSERT INTO client_users (email, name, company, password_hash, password_salt, created_by)
         VALUES (?,?,?,?,?,?)`
      )
      .run(body.email.trim(), body.name.trim(), body.company?.trim() || null, hash, salt, req.user.id);

    const id = Number(created.lastInsertRowid);
    await setSites(id, body.siteIds);
    await audit(req.user.id, 'client.created', 'client_user', id, { sites: body.siteIds.length }, req.ip);

    const row = await db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(id);
    res.status(201).json({
      client: isoFields(publicClient(row), TIMES),
      password,
      note: 'Send this to the contact now. It is not stored and cannot be shown again.',
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

    const password = generatePassword();
    const { hash, salt } = hashPassword(password);
    // Bumping the version ends any session the contact still had open, which
    // is the point of a reset when a laptop has gone missing.
    await db
      .prepare(
        `UPDATE client_users
         SET password_hash = ?, password_salt = ?, token_version = token_version + 1,
             failed_attempts = 0, locked_until = NULL
         WHERE id = ?`
      )
      .run(hash, salt, client.id);

    await audit(req.user.id, 'client.password_reset', 'client_user', client.id, null, req.ip);
    res.json({
      email: client.email,
      password,
      note: 'Send this to the contact now. It is not stored and cannot be shown again.',
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
