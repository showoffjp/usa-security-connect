/**
 * Notices from us to the client contacts: a hurricane plan, holiday coverage,
 * a new account manager. A notice goes to every property or to chosen ones,
 * shows in the portal between its start and end, and can be emailed to the
 * contacts when it is posted. Each contact marks it read once; the office
 * sees how many have.
 *
 * Mounted on /api/admin/client-notices for supervisors and administrators.
 * The portal side lives in client.js.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, idParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES } from '../shared.js';
import { toSql } from '../services/compliance.js';
import { send } from '../services/email.js';

export const noticesRouter = Router();
noticesRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

export const NOTICE_LEVELS = ['info', 'important', 'urgent'];
const DAY = 86400000;

/** Active client contacts who can see a notice. */
async function audienceFor(notice) {
  return db
    .prepare(
      `SELECT DISTINCT c.id, c.email, c.name FROM client_users c JOIN client_sites cs ON cs.client_user_id = c.id
       WHERE c.status = 'active' AND (? = true OR cs.site_id IN (SELECT site_id FROM client_notice_sites WHERE notice_id = ?))
       ORDER BY c.id`
    )
    .all(Boolean(notice.all_sites), notice.id);
}

const state = (n, now = Date.now()) => {
  if (n.withdrawn_at) return 'withdrawn';
  if (new Date(n.starts_at).getTime() > now) return 'scheduled';
  if (n.ends_at && new Date(n.ends_at).getTime() <= now) return 'ended';
  return 'live';
};

async function present(n) {
  const row = isoFields(n, ['starts_at', 'ends_at', 'emailed_at', 'withdrawn_at', 'created_at']);
  const sites = n.all_sites
    ? []
    : await db
        .prepare(`SELECT s.id, s.name FROM client_notice_sites ns JOIN sites s ON s.id = ns.site_id WHERE ns.notice_id = ? ORDER BY s.name`)
        .all(n.id);
  const audience = await audienceFor(n);
  const reads = Number((await db.prepare(`SELECT COUNT(*) AS n FROM client_notice_reads WHERE notice_id = ?`).get(n.id)).n);
  return { ...row, all_sites: Boolean(n.all_sites), sites, state: state(row), audience: audience.length, reads };
}

const noticeSelect = `SELECT n.*, u.first_name || ' ' || u.last_name AS created_by_name FROM client_notices n LEFT JOIN users u ON u.id = n.created_by`;

noticesRouter.get(
  '/',
  wrap(async (_req, res) => {
    const rows = await db.prepare(`${noticeSelect} ORDER BY n.withdrawn_at IS NOT NULL, n.starts_at DESC, n.id DESC LIMIT 100`).all();
    const notices = [];
    for (const n of rows) notices.push(await present(n));
    res.json({ notices, live: notices.filter((n) => n.state === 'live').length });
  })
);

const noticeSchema = z
  .object({
    title: z.string().trim().min(3, 'Give the notice a title.').max(120),
    body: z.string().trim().min(10, 'Say what the client needs to know.').max(2000),
    level: z.enum(NOTICE_LEVELS).default('info'),
    allSites: z.boolean().default(false),
    siteIds: z.array(z.number().int().positive()).max(200).default([]),
    startsAt: z.string().optional().nullable(),
    endsAt: z.string().optional().nullable(),
    email: z.boolean().default(false),
  })
  .refine((b) => b.allSites || b.siteIds.length > 0, { message: 'Choose the properties, or send it to all of them.', path: ['siteIds'] });

const readTime = (value, field) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(422, 'That date is not valid.', [{ field, message: 'Pick a date and time.' }]);
  return d;
};

/** Post a notice. Emailed, if asked, to every contact who can see it, straight away. */
noticesRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = parse(noticeSchema, req.body);
    const now = Date.now();
    const starts = body.startsAt ? readTime(body.startsAt, 'startsAt') : new Date(now);
    const ends = body.endsAt ? readTime(body.endsAt, 'endsAt') : null;
    if (starts.getTime() > now + 60 * DAY) throw new HttpError(422, 'A notice can be scheduled up to 60 days ahead.', [{ field: 'startsAt', message: 'No more than 60 days ahead.' }]);
    if (starts.getTime() < now - DAY) throw new HttpError(422, 'A notice cannot start in the past.', [{ field: 'startsAt', message: 'Start it today or later.' }]);
    if (ends && ends <= starts) throw new HttpError(422, 'The notice has to end after it starts.', [{ field: 'endsAt', message: 'Pick a later end.' }]);
    if (ends && ends.getTime() - starts.getTime() > 180 * DAY) throw new HttpError(422, 'A notice can run for up to 180 days.', [{ field: 'endsAt', message: 'No more than 180 days.' }]);

    const siteIds = body.allSites ? [] : [...new Set(body.siteIds)];
    if (siteIds.length) {
      const found = await db.prepare(`SELECT id FROM sites WHERE id IN (${siteIds.map(() => '?').join(',')})`).all(...siteIds);
      if (found.length !== siteIds.length) throw new HttpError(422, 'One of those properties does not exist.', [{ field: 'siteIds', message: 'Pick existing properties.' }]);
    }

    const info = await db
      .prepare(`INSERT INTO client_notices (title, body, level, all_sites, starts_at, ends_at, created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(body.title, body.body, body.level, body.allSites, toSql(starts), ends ? toSql(ends) : null, req.user.id);
    const id = Number(info.lastInsertRowid);
    for (const siteId of siteIds) {
      await db.prepare(`INSERT INTO client_notice_sites (notice_id, site_id) VALUES (?,?)`).run(id, siteId);
    }

    let notice = await db.prepare(`${noticeSelect} WHERE n.id = ?`).get(id);
    let emailed = 0;
    if (body.email) {
      for (const c of await audienceFor(notice)) {
        await send({
          to: c.email,
          name: c.name,
          kind: 'client_notice',
          entity: 'client_notice',
          entityId: id,
          subject: `${body.level === 'urgent' ? 'Urgent: ' : ''}${body.title}`,
          body: [
            `Dear ${c.name},`,
            '',
            body.body,
            '',
            'This notice is also in your client portal.',
          ].join('\n'),
        });
        emailed++;
      }
      await db.prepare(`UPDATE client_notices SET emailed_at = now() WHERE id = ?`).run(id);
      notice = await db.prepare(`${noticeSelect} WHERE n.id = ?`).get(id);
    }
    await audit(req.user.id, 'client_notice.posted', 'client_notice', id, { allSites: body.allSites, sites: siteIds.length, emailed }, req.ip);
    res.status(201).json({ notice: await present(notice), emailed });
  })
);

/** Take a notice down before its end. It leaves the portal at once. */
noticesRouter.post(
  '/:id/withdraw',
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'notice');
    const done = await db.prepare(`UPDATE client_notices SET withdrawn_at = now() WHERE id = ? AND withdrawn_at IS NULL`).run(id);
    if (!done.changes) {
      const exists = await db.prepare(`SELECT id FROM client_notices WHERE id = ?`).get(id);
      throw new HttpError(exists ? 409 : 404, exists ? 'That notice has already been withdrawn.' : 'Notice not found.');
    }
    await audit(req.user.id, 'client_notice.withdrawn', 'client_notice', id, null, req.ip);
    res.json({ notice: await present(await db.prepare(`${noticeSelect} WHERE n.id = ?`).get(id)) });
  })
);
