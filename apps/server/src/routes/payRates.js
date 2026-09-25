/**
 * Pay rates: what every officer is paid and billed at, by classification.
 *
 * The figures live on the employee record, where the timesheet and invoice
 * code already read them. This screen is a faster way to set them - one table
 * for the whole roster, a bulk raise for a whole classification - and every
 * change lands in pay_rate_history with who made it, why, and from when.
 *
 * Reading is for supervisors, because they staff shifts against margin.
 * Changing anything is for administrators only.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, parseDay, toDateString } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, EMPLOYMENT_TYPES, PAY_TYPES, computePay, toHours } from '../shared.js';
import { toSql } from '../services/compliance.js';
import { recordPayHistory } from '../services/payHistory.js';
import { classificationProblem } from './admin.js';

export const payRatesRouter = Router();
payRatesRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));
const onlyAdmin = requireRole(ROLES.ADMIN);

const dollars = (cents) => (cents == null ? null : cents / 100);

payRatesRouter.get(
  '/',
  wrap(async (_req, res) => {
    const since = toSql(new Date(Date.now() - 28 * 86400000));
    const rows = await db
      .prepare(
        `SELECT u.id, u.employee_code, u.first_name || ' ' || u.last_name AS name, u.role, u.status,
                u.employment_type, u.pay_type, u.exempt, u.pay_rate_cents, u.salary_cents,
                u.bill_rate_cents, u.overtime_multiplier, u.license_type, u.business_name,
                u.w9_on_file, u.hire_date, s.name AS home_site,
                (SELECT ROUND(AVG(p.bill_rate_cents)) FROM posts p
                  WHERE p.site_id = u.default_site_id AND p.active = 1) AS site_bill_cents,
                (SELECT COALESCE(SUM(te.minutes_worked), 0) FROM time_entries te
                  WHERE te.user_id = u.id AND te.clock_in_at >= ?) AS minutes_28d,
                (SELECT COUNT(*) FROM pay_rate_history h WHERE h.user_id = u.id) AS changes
         FROM users u
         LEFT JOIN sites s ON s.id = u.default_site_id
         WHERE u.status IN ('active','on_leave','suspended')
         ORDER BY u.employment_type, u.last_name, u.first_name`
      )
      .all(since);

    const latest = await db
      .prepare(
        `SELECT DISTINCT ON (h.user_id) h.user_id, h.effective_on, h.reason, h.created_at,
                c.first_name || ' ' || c.last_name AS changed_by_name
         FROM pay_rate_history h LEFT JOIN users c ON c.id = h.changed_by
         ORDER BY h.user_id, h.effective_on DESC, h.id DESC`
      )
      .all();
    const latestBy = new Map(latest.map((l) => [l.user_id, l]));

    const people = rows.map((r) => {
      const armed = /class g|armed/i.test(r.license_type || '');
      const hourly = r.pay_type === 'hourly';
      // Most officers are billed at the post's standing rate rather than their
      // own, so margin falls back to the average rate at their home site.
      const billBasis = r.bill_rate_cents ?? (r.site_bill_cents != null ? Number(r.site_bill_cents) : null);
      const margin =
        hourly && r.pay_rate_cents != null && billBasis
          ? Math.round(((billBasis - r.pay_rate_cents) / billBasis) * 1000) / 10
          : null;
      const pay = computePay({
        minutes: Number(r.minutes_28d),
        employmentType: r.employment_type,
        payType: r.pay_type,
        exempt: Boolean(r.exempt),
        payRateCents: r.pay_rate_cents,
        billRateCents: r.bill_rate_cents,
        overtimeMultiplier: r.overtime_multiplier || 1.5,
        weeklyThresholdHours: 160,
        salaryCents: r.salary_cents,
      });
      const last = latestBy.get(r.id);
      return {
        id: r.id,
        employee_code: r.employee_code,
        name: r.name,
        role: r.role,
        status: r.status,
        employment_type: r.employment_type,
        pay_type: r.pay_type,
        exempt: Boolean(r.exempt),
        armed,
        license_type: r.license_type,
        business_name: r.business_name,
        w9_on_file: Boolean(r.w9_on_file),
        home_site: r.home_site,
        hire_date: r.hire_date,
        pay_rate: dollars(r.pay_rate_cents),
        salary: dollars(r.salary_cents),
        bill_rate: dollars(r.bill_rate_cents),
        site_bill_rate: r.site_bill_cents != null ? Math.round(Number(r.site_bill_cents)) / 100 : null,
        margin_basis: r.bill_rate_cents != null ? 'own' : r.site_bill_cents != null ? 'site' : null,
        overtime_multiplier: r.overtime_multiplier,
        overtime_rate:
          r.employment_type === 'w2' && !r.exempt && hourly && r.pay_rate_cents != null
            ? Math.round(r.pay_rate_cents * (r.overtime_multiplier || 1.5)) / 100
            : null,
        margin_percent: margin,
        hours_28d: toHours(Number(r.minutes_28d)),
        pay_28d: dollars(pay.payCents),
        changes: Number(r.changes),
        last_change: last ? isoFields(last, ['created_at']) : null,
      };
    });

    const summarise = (set) => {
      const hourly = set.filter((p) => p.pay_type === 'hourly' && p.pay_rate != null);
      const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
      return {
        people: set.length,
        avg_pay_rate: avg(hourly.map((p) => p.pay_rate)),
        min_pay_rate: hourly.length ? Math.min(...hourly.map((p) => p.pay_rate)) : null,
        max_pay_rate: hourly.length ? Math.max(...hourly.map((p) => p.pay_rate)) : null,
        avg_bill_rate: avg(set.filter((p) => p.bill_rate != null).map((p) => p.bill_rate)),
        avg_margin_percent: avg(set.filter((p) => p.margin_percent != null).map((p) => p.margin_percent)),
        hours_28d: Math.round(set.reduce((n, p) => n + p.hours_28d, 0) * 100) / 100,
        pay_28d: Math.round(set.reduce((n, p) => n + (p.pay_28d || 0), 0) * 100) / 100,
      };
    };

    res.json({
      people,
      summary: {
        w2: summarise(people.filter((p) => p.employment_type === 'w2')),
        contractor: summarise(people.filter((p) => p.employment_type === '1099')),
        armed: summarise(people.filter((p) => p.armed)),
        unarmed: summarise(people.filter((p) => !p.armed)),
      },
    });
  })
);

payRatesRouter.get(
  '/:userId/history',
  wrap(async (req, res) => {
    const rows = await db
      .prepare(
        `SELECT h.*, c.first_name || ' ' || c.last_name AS changed_by_name
         FROM pay_rate_history h LEFT JOIN users c ON c.id = h.changed_by
         WHERE h.user_id = ?
         ORDER BY h.effective_on DESC, h.id DESC`
      )
      .all(Number(req.params.userId));
    res.json({
      history: rows.map((h) => ({
        ...isoFields(h, ['created_at']),
        pay_rate: dollars(h.pay_rate_cents),
        salary: dollars(h.salary_cents),
        bill_rate: dollars(h.bill_rate_cents),
      })),
    });
  })
);

const effectiveOn = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-01.')
  .optional();

const rateSchema = z.object({
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  payType: z.enum(PAY_TYPES).optional(),
  exempt: z.boolean().optional(),
  payRate: z.number().nonnegative().max(1000).nullable().optional(),
  salary: z.number().nonnegative().max(1_000_000).nullable().optional(),
  billRate: z.number().nonnegative().max(2000).nullable().optional(),
  overtimeMultiplier: z.number().min(1).max(3).optional(),
  effectiveOn,
  reason: z.string().trim().min(3, 'Say why the rate is changing.').max(300),
});

payRatesRouter.patch(
  '/:userId',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(rateSchema, req.body);
    const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(Number(req.params.userId));
    if (!user) throw new HttpError(404, 'Employee not found.');

    const next = {
      employment_type: body.employmentType ?? user.employment_type,
      pay_type: body.payType ?? user.pay_type,
      exempt: body.exempt ?? Boolean(user.exempt),
      pay_rate_cents: body.payRate !== undefined ? (body.payRate == null ? null : Math.round(body.payRate * 100)) : user.pay_rate_cents,
      salary_cents: body.salary !== undefined ? (body.salary == null ? null : Math.round(body.salary * 100)) : user.salary_cents,
      bill_rate_cents: body.billRate !== undefined ? (body.billRate == null ? null : Math.round(body.billRate * 100)) : user.bill_rate_cents,
      overtime_multiplier: body.overtimeMultiplier ?? user.overtime_multiplier,
    };

    // A contractor is never exempt and never on overtime; switching someone to
    // 1099 here clears the flag rather than refusing, because the classification
    // is the decision being made.
    if (next.employment_type === '1099') next.exempt = false;

    const problem = classificationProblem({
      employmentType: next.employment_type,
      status: user.status,
      exempt: next.exempt,
      w9OnFile: Boolean(user.w9_on_file),
    });
    if (problem) throw new HttpError(422, problem.message, [problem]);

    if (next.pay_type === 'salary' && next.salary_cents == null) {
      throw new HttpError(422, 'Enter the salary for a salaried employee.', [{ field: 'salary', message: 'Required.' }]);
    }
    if (next.pay_type !== 'salary' && next.pay_rate_cents == null) {
      throw new HttpError(422, 'Enter the pay rate.', [{ field: 'payRate', message: 'Required.' }]);
    }

    await db
      .prepare(
        `UPDATE users SET employment_type = ?, pay_type = ?, exempt = ?, pay_rate_cents = ?,
                salary_cents = ?, bill_rate_cents = ?, overtime_multiplier = ?, updated_at = now()
         WHERE id = ?`
      )
      .run(
        next.employment_type,
        next.pay_type,
        next.exempt,
        next.pay_rate_cents,
        next.salary_cents,
        next.bill_rate_cents,
        next.overtime_multiplier,
        user.id
      );

    const historyId = await recordPayHistory(user.id, {
      changedBy: req.user.id,
      reason: body.reason,
      effectiveOn: body.effectiveOn || null,
    });

    await audit(
      req.user.id,
      'pay_rate.changed',
      'user',
      user.id,
      {
        from: { type: user.employment_type, rate: user.pay_rate_cents, bill: user.bill_rate_cents },
        to: { type: next.employment_type, rate: next.pay_rate_cents, bill: next.bill_rate_cents },
        reason: body.reason,
      },
      req.ip
    );

    res.json({ ok: true, changed: Boolean(historyId) });
  })
);

const bulkSchema = z.object({
  employmentType: z.enum([...EMPLOYMENT_TYPES, 'all']),
  armed: z.enum(['armed', 'unarmed', 'all']).default('all'),
  field: z.enum(['pay', 'bill']).default('pay'),
  mode: z.enum(['percent', 'amount']),
  value: z.number().min(-50).max(100),
  effectiveOn,
  reason: z.string().trim().min(3, 'Say why the rates are changing.').max(300),
  /** Preview the result without saving it. */
  dryRun: z.boolean().default(false),
});

/** A raise (or cut) across a whole classification, previewed before it is applied. */
payRatesRouter.post(
  '/bulk',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(bulkSchema, req.body);
    const column = body.field === 'pay' ? 'pay_rate_cents' : 'bill_rate_cents';

    const candidates = await db
      .prepare(
        `SELECT id, first_name || ' ' || last_name AS name, employment_type, pay_type,
                license_type, ${column} AS cents
         FROM users
         WHERE status IN ('active','on_leave') AND ${column} IS NOT NULL
           AND (pay_type != 'salary' OR ? = 'bill')`
      )
      .all(body.field);

    const matches = candidates.filter((c) => {
      if (body.employmentType !== 'all' && c.employment_type !== body.employmentType) return false;
      const armed = /class g|armed/i.test(c.license_type || '');
      if (body.armed === 'armed' && !armed) return false;
      if (body.armed === 'unarmed' && armed) return false;
      return true;
    });

    const changes = matches.map((c) => {
      const next =
        body.mode === 'percent'
          ? Math.round(c.cents * (1 + body.value / 100))
          : Math.round(c.cents + body.value * 100);
      return { id: c.id, name: c.name, from: c.cents / 100, to: Math.max(0, next) / 100 };
    });

    if (!body.dryRun) {
      await db.transaction(async () => {
        for (const c of changes) {
          await db
            .prepare(`UPDATE users SET ${column} = ?, updated_at = now() WHERE id = ?`)
            .run(Math.round(c.to * 100), c.id);
          await recordPayHistory(c.id, {
            changedBy: req.user.id,
            reason: body.reason,
            effectiveOn: body.effectiveOn || null,
          });
        }
      })();
      await audit(req.user.id, 'pay_rate.bulk_changed', 'user', null, { ...body, count: changes.length }, req.ip);
    }

    res.json({ applied: !body.dryRun, count: changes.length, changes });
  })
);

/**
 * What changed in pay over a period - for the bookkeeper reconciling payroll
 * against the rates they were told about.
 */
payRatesRouter.get(
  '/changes/recent',
  wrap(async (req, res) => {
    const from = parseDay(req.query.from || toDateString(new Date(Date.now() - 90 * 86400000)));
    const rows = await db
      .prepare(
        `SELECT h.*, u.first_name || ' ' || u.last_name AS name, u.employee_code,
                c.first_name || ' ' || c.last_name AS changed_by_name
         FROM pay_rate_history h
         JOIN users u ON u.id = h.user_id
         LEFT JOIN users c ON c.id = h.changed_by
         WHERE h.created_at >= ?
         ORDER BY h.created_at DESC LIMIT 200`
      )
      .all(toSql(from));
    res.json({
      changes: rows.map((h) => ({
        ...isoFields(h, ['created_at']),
        pay_rate: dollars(h.pay_rate_cents),
        bill_rate: dollars(h.bill_rate_cents),
        salary: dollars(h.salary_cents),
      })),
    });
  })
);
