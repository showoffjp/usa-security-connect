/**
 * Service agreements, staff side: every site's contracted hours against what
 * is rostered and what was worked, and its renewal date. Supervisors read
 * the board; setting or removing an agreement is an administrator's job,
 * because it is what the client pays for.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam, parseDay } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES } from '../shared.js';
import { agreementBoard, presentAgreement } from '../services/agreements.js';

export const agreementsRouter = Router();
agreementsRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));
const onlyAdmin = requireRole(ROLES.ADMIN);

agreementsRouter.get(
  '/',
  wrap(async (_req, res) => {
    res.json(await agreementBoard());
  })
);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-31.');
const agreementSchema = z
  .object({
    weeklyHours: z.number().positive('Give the hours a week the client pays for.').max(2000, 'That is more hours than a week has across many posts; check the figure.'),
    startsOn: day.nullable().optional(),
    endsOn: day.nullable().optional(),
    noticeDays: z.number().int().min(0).max(365).default(60),
    autoRenew: z.boolean().default(false),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((b) => !b.startsOn || !b.endsOn || b.endsOn > b.startsOn, { message: 'The agreement has to end after it starts.', path: ['endsOn'] });

agreementsRouter.put(
  '/:siteId',
  onlyAdmin,
  wrap(async (req, res) => {
    const siteId = idParam(req.params.siteId, 'site');
    const body = parse(agreementSchema, req.body);
    const site = await db.prepare(`SELECT id FROM sites WHERE id = ?`).get(siteId);
    if (!site) throw new HttpError(404, 'Site not found.');
    if (body.startsOn && !parseDay(body.startsOn)) throw new HttpError(422, 'That start date is not valid.');
    await db
      .prepare(
        `INSERT INTO site_agreements (site_id, weekly_hours, starts_on, ends_on, notice_days, auto_renew, notes, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?, now())
         ON CONFLICT (site_id) DO UPDATE SET weekly_hours = excluded.weekly_hours, starts_on = excluded.starts_on,
           ends_on = excluded.ends_on, notice_days = excluded.notice_days, auto_renew = excluded.auto_renew,
           notes = excluded.notes, updated_by = excluded.updated_by, updated_at = now()`
      )
      .run(siteId, body.weeklyHours, body.startsOn || null, body.endsOn || null, body.noticeDays, body.autoRenew, body.notes || null, req.user.id);
    await audit(req.user.id, 'agreement.saved', 'site', siteId, { weeklyHours: body.weeklyHours, endsOn: body.endsOn || null }, req.ip);
    res.json({ agreement: presentAgreement(await db.prepare(`SELECT * FROM site_agreements WHERE site_id = ?`).get(siteId)) });
  })
);

agreementsRouter.delete(
  '/:siteId',
  onlyAdmin,
  wrap(async (req, res) => {
    const siteId = idParam(req.params.siteId, 'site');
    const info = await db.prepare(`DELETE FROM site_agreements WHERE site_id = ?`).run(siteId);
    if (!info.changes) throw new HttpError(404, 'That site has no agreement.');
    await audit(req.user.id, 'agreement.removed', 'site', siteId, null, req.ip);
    res.json({ ok: true });
  })
);
