/**
 * Keys and equipment.
 *
 * Split three ways, which mirrors who is standing where:
 *
 *   * An officer can see what they are holding and hand it back. They cannot
 *     see the inventory, because knowing which key rings exist at which sites
 *     is not something every officer needs.
 *   * A supervisor runs the counter: the inventory, issuing, taking things
 *     back, and the history of any one item.
 *   * Only an administrator adds, edits or retires an item, the same boundary
 *     the rest of the configuration screens draw.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, EQUIPMENT_CATEGORIES, EQUIPMENT_STATUS, EQUIPMENT_CONDITIONS } from '../shared.js';
import { issue, returnItem, inventory, history, heldBy, currentHolder } from '../services/equipment.js';

export const equipmentRouter = Router();
equipmentRouter.use(requireAuth);

const onlySupervisor = requireRole(ROLES.SUPERVISOR);
const onlyAdmin = requireRole(ROLES.ADMIN);

const ASSIGNMENT_TIMES = ['issued_at', 'returned_at'];

/* --------------------------------------------------------- the officer -- */

/**
 * What I am holding. Deliberately the first route in the file and the only one
 * an officer can reach: it is the question they actually have.
 */
equipmentRouter.get(
  '/mine',
  wrap(async (req, res) => {
    const held = await heldBy(req.user.id);
    res.json({
      held: held.map((h) => isoFields(h, ['issued_at'])),
      mustReturnBeforeClockOut: held.filter((h) => h.return_by_end_of_shift).length,
    });
  })
);

/** Hand something back without a supervisor present. */
equipmentRouter.post(
  '/mine/:equipmentId/return',
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        condition: z.enum(EQUIPMENT_CONDITIONS).default('good'),
        note: z.string().trim().max(300).nullable().optional(),
      }),
      req.body
    );

    const holder = await currentHolder(Number(req.params.equipmentId));
    if (!holder || holder.user_id !== req.user.id) {
      throw new HttpError(404, 'You do not have that item signed out.');
    }

    const result = await returnItem({
      equipmentId: Number(req.params.equipmentId),
      returnedTo: req.user.id,
      condition: body.condition,
      note: body.note ?? null,
    });

    await audit(req.user.id, 'equipment.returned', 'equipment', Number(req.params.equipmentId), {
      condition: body.condition,
      selfReturn: true,
    }, req.ip);

    res.json({ returned: true, status: result.status });
  })
);

/* ------------------------------------------------------ the supervisor -- */

equipmentRouter.get(
  '/',
  onlySupervisor,
  wrap(async (req, res) => {
    const rows = await inventory({
      siteId: req.query.siteId ? Number(req.query.siteId) : null,
      category: req.query.category || null,
      status: req.query.status || null,
    });

    const summary = rows.reduce(
      (acc, r) => {
        acc.total += 1;
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      },
      { total: 0 }
    );

    res.json({
      equipment: rows.map((r) => isoFields(r, ['issued_at', 'created_at'])),
      summary,
    });
  })
);

equipmentRouter.get(
  '/:id/history',
  onlySupervisor,
  wrap(async (req, res) => {
    const item = await db.prepare(`SELECT * FROM equipment WHERE id = ?`).get(Number(req.params.id));
    if (!item) throw new HttpError(404, 'Item not found.');
    const rows = await history(Number(req.params.id));
    res.json({
      item,
      history: rows.map((r) => isoFields(r, ASSIGNMENT_TIMES)),
    });
  })
);

const issueSchema = z.object({
  userId: z.number().int().positive(),
  condition: z.enum(EQUIPMENT_CONDITIONS).default('good'),
  note: z.string().trim().max(300).nullable().optional(),
});

equipmentRouter.post(
  '/:id/issue',
  onlySupervisor,
  wrap(async (req, res) => {
    const body = parse(issueSchema, req.body);

    // Tie the issue to the officer's open shift where there is one, so the
    // history reads "signed out on Tuesday's night shift" rather than just a
    // timestamp somebody has to correlate by hand.
    const entry = await db
      .prepare(`SELECT id FROM time_entries WHERE user_id = ? AND clock_out_at IS NULL ORDER BY clock_in_at DESC LIMIT 1`)
      .get(body.userId);

    const result = await issue({
      equipmentId: Number(req.params.id),
      userId: body.userId,
      issuedBy: req.user.id,
      condition: body.condition,
      note: body.note ?? null,
      timeEntryId: entry?.id ?? null,
    });

    if (!result.ok) {
      const status = result.code === 'not_found' || result.code === 'no_officer' ? 404
        : result.code === 'already_out' ? 409
        : 422;
      throw new HttpError(status, result.reason, { code: result.code });
    }

    await audit(req.user.id, 'equipment.issued', 'equipment', Number(req.params.id), {
      to: body.userId,
      condition: body.condition,
    }, req.ip);

    res.status(201).json({ assignment: isoFields(result.assignment, ASSIGNMENT_TIMES) });
  })
);

equipmentRouter.post(
  '/:id/return',
  onlySupervisor,
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        condition: z.enum(EQUIPMENT_CONDITIONS).default('good'),
        note: z.string().trim().max(300).nullable().optional(),
      }),
      req.body
    );

    const result = await returnItem({
      equipmentId: Number(req.params.id),
      returnedTo: req.user.id,
      condition: body.condition,
      note: body.note ?? null,
    });
    if (!result.ok) throw new HttpError(409, result.reason, { code: result.code });

    await audit(req.user.id, 'equipment.returned', 'equipment', Number(req.params.id), {
      condition: body.condition,
    }, req.ip);

    res.json({ returned: true, status: result.status });
  })
);

/* ------------------------------------------------- the administrator --- */

const itemSchema = z.object({
  siteId: z.number().int().positive().nullable().optional(),
  category: z.enum(EQUIPMENT_CATEGORIES),
  label: z.string().trim().min(2).max(120),
  identifier: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  returnByEndOfShift: z.boolean().default(true),
  armedOnly: z.boolean().default(false),
});

equipmentRouter.post(
  '/',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(itemSchema, req.body);
    if (body.siteId) {
      const site = await db.prepare(`SELECT id FROM sites WHERE id = ?`).get(body.siteId);
      if (!site) throw new HttpError(404, 'Site not found.');
    }

    const info = await db
      .prepare(
        `INSERT INTO equipment (site_id, category, label, identifier, notes, return_by_end_of_shift, armed_only)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        body.siteId ?? null,
        body.category,
        body.label,
        body.identifier ?? null,
        body.notes ?? null,
        body.returnByEndOfShift,
        body.armedOnly
      );

    await audit(req.user.id, 'equipment.created', 'equipment', Number(info.lastInsertRowid), {
      category: body.category,
      label: body.label,
    }, req.ip);

    res.status(201).json({
      item: await db.prepare(`SELECT * FROM equipment WHERE id = ?`).get(info.lastInsertRowid),
    });
  })
);

const patchSchema = z.object({
  label: z.string().trim().min(2).max(120).optional(),
  identifier: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  status: z.enum(EQUIPMENT_STATUS).optional(),
  returnByEndOfShift: z.boolean().optional(),
  armedOnly: z.boolean().optional(),
  active: z.boolean().optional(),
});

equipmentRouter.patch(
  '/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(patchSchema, req.body);
    const item = await db.prepare(`SELECT * FROM equipment WHERE id = ?`).get(Number(req.params.id));
    if (!item) throw new HttpError(404, 'Item not found.');

    // Somebody is holding it. Marking it available would lose that fact
    // silently, and marking it lost while a named officer has it is a
    // different conversation from marking a shelf item lost.
    const held = await currentHolder(item.id);
    if (held && body.status && body.status !== 'issued' && body.status !== 'lost') {
      throw new HttpError(
        409,
        `${held.first_name} ${held.last_name} has that item signed out. Take it back first, or record it as missing.`,
        { code: 'still_out' }
      );
    }

    const map = {
      label: 'label',
      identifier: 'identifier',
      notes: 'notes',
      status: 'status',
      returnByEndOfShift: 'return_by_end_of_shift',
      armedOnly: 'armed_only',
      active: 'active',
    };
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(map)) {
      if (body[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(body[key]);
      }
    }
    if (!sets.length) return res.json({ item });

    params.push(item.id);
    await db.prepare(`UPDATE equipment SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    await audit(req.user.id, 'equipment.updated', 'equipment', item.id, body, req.ip);
    res.json({ item: await db.prepare(`SELECT * FROM equipment WHERE id = ?`).get(item.id) });
  })
);
