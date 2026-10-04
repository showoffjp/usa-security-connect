/**
 * The company holiday calendar.
 *
 *   * Anyone signed in sees the next few holidays, and an officer is told
 *     whether they earn the holiday premium.
 *   * Supervisors read a year, with the federal holidays not yet on it.
 *   * Administrators add, change and remove holidays, or add the six that
 *     nearly every security contract treats as holidays in one go.
 *
 * A holiday inside a closed pay period cannot be added, changed or removed:
 * those wages are paid. Invoices already sent keep their figures; the change
 * reports how many cover the day so the office knows to look at them.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam, parseDay, toDateString } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import {
  ROLES,
  usHolidays,
  HOLIDAY_DEFAULT_MULTIPLIER,
  HOLIDAY_MULTIPLIER_MIN,
  HOLIDAY_MULTIPLIER_MAX,
} from '../shared.js';
import { presentHoliday, upcomingHolidays } from '../services/holidays.js';
import { closedPeriodOn, periodLabel } from '../services/payPeriods.js';

export const holidaysRouter = Router();
holidaysRouter.use(requireAuth);

const onlyAdmin = requireRole(ROLES.ADMIN);
const multiplier = z.coerce
  .number()
  .min(HOLIDAY_MULTIPLIER_MIN, `At least ${HOLIDAY_MULTIPLIER_MIN}x - a holiday cannot pay or bill less than a normal day.`)
  .max(HOLIDAY_MULTIPLIER_MAX, `At most ${HOLIDAY_MULTIPLIER_MAX}x.`)
  .transform((n) => Math.round(n * 100) / 100);
const name = z.string().trim().min(2, 'Name the holiday.').max(60, 'Keep the name under 60 characters.');

/** The next few, for everyone; officers learn whether the premium is theirs. */
holidaysRouter.get(
  '/upcoming',
  wrap(async (req, res) => {
    const me = await db.prepare(`SELECT employment_type, pay_type, exempt FROM users WHERE id = ?`).get(req.user.id);
    const holidays = await upcomingHolidays(4);
    res.json({
      holidays: holidays.map((h) => ({ day: h.day, name: h.name, pay_multiplier: h.pay_multiplier })),
      earns_premium: Boolean(me && me.employment_type === 'w2' && me.pay_type === 'hourly' && !me.exempt),
    });
  })
);

/** A year's calendar, with the federal holidays not yet on it. */
holidaysRouter.get(
  '/',
  requireRole(ROLES.SUPERVISOR),
  wrap(async (req, res) => {
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(422, 'Pick a year between 2000 and 2100.');
    const rows = await db
      .prepare(`SELECT * FROM holidays WHERE day >= ? AND day <= ? ORDER BY day`)
      .all(`${year}-01-01`, `${year}-12-31`);
    const today = toDateString(new Date());
    const holidays = [];
    for (const h of rows) {
      const closed = await closedPeriodOn(h.day);
      holidays.push({ ...presentHoliday(h), past: h.day < today, locked: Boolean(closed) });
    }
    const taken = new Set(rows.map((h) => h.day));
    res.json({
      year,
      holidays,
      suggestions: usHolidays(year).filter((h) => !taken.has(h.day)),
      default_multiplier: HOLIDAY_DEFAULT_MULTIPLIER,
      limits: { min: HOLIDAY_MULTIPLIER_MIN, max: HOLIDAY_MULTIPLIER_MAX },
    });
  })
);

async function assertDayOpen(day, what) {
  const closed = await closedPeriodOn(day);
  if (closed) {
    throw new HttpError(409, `Payroll for ${periodLabel(closed)} is closed, so a holiday in it cannot be ${what}. Reopen the period first.`, {
      code: 'period_closed',
      periodId: closed.id,
    });
  }
}

/** Sent or paid invoices whose period covers the day: they keep their figures. */
async function invoicesCovering(day) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM invoices WHERE status IN ('sent','paid') AND period_start <= ? AND period_end >= ?`)
    .get(day, day);
  return Number(row?.n || 0);
}

const create = z.object({
  day: z.string().refine((v) => parseDay(v) != null, 'Pick a date.'),
  name,
  payMultiplier: multiplier.optional(),
  billMultiplier: multiplier.optional(),
});

holidaysRouter.post(
  '/',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(create, req.body);
    const day = toDateString(parseDay(body.day));
    await assertDayOpen(day, 'added');
    if (await db.prepare(`SELECT 1 FROM holidays WHERE day = ?`).get(day)) {
      throw new HttpError(409, 'There is already a holiday on that day.', [{ field: 'day', message: 'Already a holiday.' }]);
    }
    const info = await db
      .prepare(`INSERT INTO holidays (day, name, pay_multiplier, bill_multiplier, created_by) VALUES (?,?,?,?,?)`)
      .run(day, body.name, body.payMultiplier ?? HOLIDAY_DEFAULT_MULTIPLIER, body.billMultiplier ?? HOLIDAY_DEFAULT_MULTIPLIER, req.user.id);
    const holiday = presentHoliday(await db.prepare(`SELECT * FROM holidays WHERE id = ?`).get(Number(info.lastInsertRowid)));
    await audit(req.user.id, 'holiday.add', 'holiday', holiday.id, { day, name: body.name }, req.ip);
    res.status(201).json({ holiday, invoices_covering: await invoicesCovering(day) });
  })
);

/** The six core holidays for a year, skipping any already there or in a closed period. */
holidaysRouter.post(
  '/standard',
  onlyAdmin,
  wrap(async (req, res) => {
    const { year } = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100) }), req.body);
    const added = [];
    const skipped = [];
    for (const h of usHolidays(year).filter((x) => x.core)) {
      if (await db.prepare(`SELECT 1 FROM holidays WHERE day = ?`).get(h.day)) continue;
      if (await closedPeriodOn(h.day)) {
        skipped.push({ ...h, reason: 'Its pay period is closed.' });
        continue;
      }
      await db
        .prepare(`INSERT INTO holidays (day, name, pay_multiplier, bill_multiplier, created_by) VALUES (?,?,?,?,?)`)
        .run(h.day, h.name, HOLIDAY_DEFAULT_MULTIPLIER, HOLIDAY_DEFAULT_MULTIPLIER, req.user.id);
      added.push(h);
    }
    if (added.length) await audit(req.user.id, 'holiday.standard', 'holiday', null, { year, added: added.map((h) => h.day) }, req.ip);
    res.status(added.length ? 201 : 200).json({ added, skipped });
  })
);

const update = z
  .object({ name: name.optional(), payMultiplier: multiplier.optional(), billMultiplier: multiplier.optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change.');

holidaysRouter.patch(
  '/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'holiday');
    const body = parse(update, req.body);
    const before = await db.prepare(`SELECT * FROM holidays WHERE id = ?`).get(id);
    if (!before) throw new HttpError(404, 'Holiday not found.');
    // Renaming changes no money; the multipliers do.
    if (body.payMultiplier != null || body.billMultiplier != null) await assertDayOpen(before.day, 'changed');
    await db
      .prepare(`UPDATE holidays SET name = ?, pay_multiplier = ?, bill_multiplier = ? WHERE id = ?`)
      .run(body.name ?? before.name, body.payMultiplier ?? before.pay_multiplier, body.billMultiplier ?? before.bill_multiplier, id);
    const holiday = presentHoliday(await db.prepare(`SELECT * FROM holidays WHERE id = ?`).get(id));
    await audit(req.user.id, 'holiday.update', 'holiday', id, { before: presentHoliday(before), after: holiday }, req.ip);
    res.json({ holiday, invoices_covering: await invoicesCovering(before.day) });
  })
);

holidaysRouter.delete(
  '/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'holiday');
    const before = await db.prepare(`SELECT * FROM holidays WHERE id = ?`).get(id);
    if (!before) throw new HttpError(404, 'Holiday not found.');
    await assertDayOpen(before.day, 'removed');
    await db.prepare(`DELETE FROM holidays WHERE id = ?`).run(id);
    await audit(req.user.id, 'holiday.remove', 'holiday', id, presentHoliday(before), req.ip);
    res.json({ ok: true, invoices_covering: await invoicesCovering(before.day) });
  })
);
