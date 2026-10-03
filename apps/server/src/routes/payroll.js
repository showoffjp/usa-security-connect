/**
 * Payroll close: open a pay period, review every officer's hours and pay,
 * approve them, close the period, export the register.
 *
 * Reading is for supervisors - they already see estimated pay on Timesheets.
 * Opening, approving, closing and reopening are for administrators only.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, sqlToIso } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES } from '../shared.js';
import {
  PERIOD_STATUS,
  validatePeriod,
  suggestNext,
  reviewPeriod,
  closedLines,
  totalsOf,
  closeBlockers,
  writeLine,
  dayString,
  periodLabel,
} from '../services/payPeriods.js';
import { periodExpenses, payClaims, unpayClaims } from '../services/expenses.js';

export const payrollRouter = Router();
payrollRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));
const onlyAdmin = requireRole(ROLES.ADMIN);

const TIMES = ['closed_at', 'reopened_at', 'created_at'];

function present(p) {
  const out = { ...p, period_start: dayString(p.period_start), period_end: dayString(p.period_end) };
  for (const k of TIMES) out[k] = sqlToIso(p[k]);
  return out;
}

async function loadPeriod(id) {
  const period = await db
    .prepare(
      `SELECT p.*, c.first_name || ' ' || c.last_name AS closed_by_name
       FROM pay_periods p LEFT JOIN users c ON c.id = p.closed_by WHERE p.id = ?`
    )
    .get(Number(id));
  if (!period) throw new HttpError(404, 'Pay period not found.');
  return period;
}

const linesFor = (period) => (period.status === PERIOD_STATUS.CLOSED ? closedLines(period) : reviewPeriod(period));

/**
 * Expense claims the period pays, set beside each officer's line. They are
 * reimbursements, kept apart from the hours and the gross pay.
 */
function withReimbursements(lines, expenses) {
  return lines.map((l) => {
    const cents = expenses.byUser.get(l.user_id) || 0;
    return { ...l, reimbursement_cents: cents, reimbursement: cents / 100 };
  });
}

/* ------------------------------------------------------------------ list --- */

payrollRouter.get(
  '/periods',
  wrap(async (_req, res) => {
    const periods = await db
      .prepare(
        `SELECT p.*, c.first_name || ' ' || c.last_name AS closed_by_name
         FROM pay_periods p LEFT JOIN users c ON c.id = p.closed_by
         ORDER BY p.period_start DESC LIMIT 60`
      )
      .all();

    // Closed periods carry their totals; open ones are worked out now, so the
    // list shows how close each is to done.
    const out = [];
    for (const p of periods) {
      if (p.status === PERIOD_STATUS.CLOSED) {
        out.push({
          ...present(p),
          totals: {
            people: p.people,
            hours: Math.round((p.total_minutes / 60) * 100) / 100,
            overtime_hours: Math.round((p.overtime_minutes / 60) * 100) / 100,
            gross_pay: p.gross_cents / 100,
            w2_pay: p.w2_cents / 100,
            contractor_pay: p.contractor_cents / 100,
            approved: p.people,
            pending: 0,
            changed: 0,
            blocked: 0,
          },
          blockers: [],
        });
      } else {
        const lines = await reviewPeriod(p);
        const t = totalsOf(lines);
        out.push({
          ...present(p),
          totals: {
            people: t.people,
            hours: t.hours,
            overtime_hours: t.overtime_hours,
            gross_pay: t.gross_pay,
            w2_pay: t.w2.pay,
            contractor_pay: t.contractor.pay,
            approved: t.approved,
            pending: t.pending,
            changed: t.changed,
            blocked: t.blocked,
          },
          blockers: closeBlockers(p, lines),
        });
      }
    }
    res.json({ periods: out, suggestion: await suggestNext() });
  })
);

/* ---------------------------------------------------------------- create --- */

const createSchema = z.object({
  periodStart: z.string().trim(),
  periodEnd: z.string().trim(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

payrollRouter.post(
  '/periods',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(createSchema, req.body);
    validatePeriod(body.periodStart, body.periodEnd);

    const overlap = await db
      .prepare(`SELECT * FROM pay_periods WHERE period_start <= ? AND period_end >= ? LIMIT 1`)
      .get(body.periodEnd, body.periodStart);
    if (overlap) {
      throw new HttpError(409, `That overlaps the pay period ${periodLabel(overlap)}.`, {
        code: 'overlap',
        periodId: overlap.id,
      });
    }

    const created = await db
      .prepare(`INSERT INTO pay_periods (period_start, period_end, notes, created_by) VALUES (?,?,?,?)`)
      .run(body.periodStart, body.periodEnd, body.notes || null, req.user.id);
    const id = Number(created.lastInsertRowid);
    await audit(req.user.id, 'pay_period.created', 'pay_period', id, { periodStart: body.periodStart, periodEnd: body.periodEnd }, req.ip);
    res.status(201).json({ period: present(await loadPeriod(id)) });
  })
);

/* ---------------------------------------------------------------- review --- */

payrollRouter.get(
  '/periods/:id',
  wrap(async (req, res) => {
    const period = await loadPeriod(req.params.id);
    const expenses = await periodExpenses(period);
    const lines = withReimbursements(await linesFor(period), expenses);
    res.json({
      period: present(period),
      lines,
      totals: { ...totalsOf(lines), reimbursements: expenses.total },
      expenses: { claims: expenses.claims, total: expenses.total, pending: expenses.pending },
      blockers: period.status === PERIOD_STATUS.OPEN ? closeBlockers(period, lines, { pendingExpenses: expenses.pending }) : [],
    });
  })
);

/** Remove an open period nobody has approved anything in - a mistyped date range. */
payrollRouter.delete(
  '/periods/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const period = await loadPeriod(req.params.id);
    if (period.status !== PERIOD_STATUS.OPEN) throw new HttpError(409, 'A closed period cannot be deleted. Reopen it first.');
    const approved = await db.prepare(`SELECT COUNT(*) AS n FROM pay_period_lines WHERE pay_period_id = ?`).get(period.id);
    if (Number(approved.n) > 0) {
      throw new HttpError(409, 'Officers in this period have been approved. Remove their approvals before deleting it.');
    }
    await db.prepare(`DELETE FROM pay_periods WHERE id = ?`).run(period.id);
    await audit(req.user.id, 'pay_period.deleted', 'pay_period', period.id, { period: periodLabel(period) }, req.ip);
    res.json({ ok: true });
  })
);

/* --------------------------------------------------------------- approve --- */

const approveSchema = z.object({
  /** Officers to approve; omit to approve everyone who is ready. */
  userIds: z.array(z.number().int().positive()).max(500).optional(),
});

payrollRouter.post(
  '/periods/:id/approve',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(approveSchema, req.body || {});
    const period = await loadPeriod(req.params.id);
    if (period.status !== PERIOD_STATUS.OPEN) throw new HttpError(409, 'This period is closed. Reopen it to change approvals.');

    const lines = await reviewPeriod(period);
    const byUser = new Map(lines.map((l) => [l.user_id, l]));
    const wanted = body.userIds ?? lines.filter((l) => l.approval.state !== 'approved').map((l) => l.user_id);

    const approved = [];
    const skipped = [];
    for (const userId of wanted) {
      const line = byUser.get(userId);
      if (!line) {
        skipped.push({ userId, reason: 'No hours in this period.' });
        continue;
      }
      if (line.blocked) {
        skipped.push({
          userId,
          officer: line.officer,
          reason: line.issues.filter((i) => i.level === 'block').map((i) => i.message).join(' '),
        });
        continue;
      }
      if (line.approval.state === 'approved') continue;
      await writeLine(period.id, line, req.user.id);
      approved.push({ userId, officer: line.officer, gross_pay: line.gross_pay });
    }

    if (approved.length) {
      await audit(
        req.user.id,
        'pay_period.approved',
        'pay_period',
        period.id,
        { officers: approved.map((a) => a.userId), skipped: skipped.length },
        req.ip
      );
    }
    res.json({ approved, skipped });
  })
);

payrollRouter.delete(
  '/periods/:id/approvals/:userId',
  onlyAdmin,
  wrap(async (req, res) => {
    const period = await loadPeriod(req.params.id);
    if (period.status !== PERIOD_STATUS.OPEN) throw new HttpError(409, 'This period is closed. Reopen it to change approvals.');
    const gone = await db
      .prepare(`DELETE FROM pay_period_lines WHERE pay_period_id = ? AND user_id = ?`)
      .run(period.id, Number(req.params.userId));
    if (!gone.changes) throw new HttpError(404, 'That officer is not approved in this period.');
    await audit(req.user.id, 'pay_period.unapproved', 'pay_period', period.id, { userId: Number(req.params.userId) }, req.ip);
    res.json({ ok: true });
  })
);

/* ----------------------------------------------------------------- close --- */

payrollRouter.post(
  '/periods/:id/close',
  onlyAdmin,
  wrap(async (req, res) => {
    const period = await loadPeriod(req.params.id);
    // Worked out again here rather than trusted from the screen: a punch
    // corrected since the page loaded changes a fingerprint and blocks this.
    const lines = await reviewPeriod(period);
    const expenses = await periodExpenses(period);
    const blockers = closeBlockers(period, lines, { pendingExpenses: expenses.pending });
    if (blockers.length) {
      throw new HttpError(409, blockers.map((b) => b.message).join(' '), { code: 'cannot_close', blockers });
    }

    const t = totalsOf(lines);
    await db.transaction(async () => {
      // Approvals left over for people with no hours now have nothing to pay.
      const keep = lines.map((l) => l.user_id);
      await db
        .prepare(
          `DELETE FROM pay_period_lines WHERE pay_period_id = ?
           ${keep.length ? `AND user_id NOT IN (${keep.map(() => '?').join(',')})` : ''}`
        )
        .run(period.id, ...keep);
      // The fingerprint matched, so the approved figures are the final ones;
      // only names are refreshed, in case a site was renamed since.
      for (const line of lines) {
        await db
          .prepare(`UPDATE pay_period_lines SET officer = ?, sites = ? WHERE pay_period_id = ? AND user_id = ?`)
          .run(line.officer, JSON.stringify(line.sites), period.id, line.user_id);
      }
      await db
        .prepare(
          `UPDATE pay_periods SET status = 'closed', closed_at = now(), closed_by = ?, people = ?,
             total_minutes = ?, overtime_minutes = ?, gross_cents = ?, w2_cents = ?, contractor_cents = ?
           WHERE id = ?`
        )
        .run(req.user.id, t.people, t.minutes, t.overtime_minutes, t.gross_cents, t.w2.cents, t.contractor.cents, period.id);
      // Approved expense claims up to the last day are paid with it.
      await payClaims(period);
    })();

    await audit(
      req.user.id,
      'pay_period.closed',
      'pay_period',
      period.id,
      { period: periodLabel(period), people: t.people, gross_cents: t.gross_cents },
      req.ip
    );
    const closed = await loadPeriod(period.id);
    res.json({ period: present(closed), totals: totalsOf(await closedLines(closed)) });
  })
);

const reopenSchema = z.object({
  reason: z.string().trim().min(5, 'Record why this period is being reopened.').max(500),
});

payrollRouter.post(
  '/periods/:id/reopen',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(reopenSchema, req.body);
    const period = await loadPeriod(req.params.id);
    if (period.status !== PERIOD_STATUS.CLOSED) throw new HttpError(409, 'This period is not closed.');
    await db
      .prepare(`UPDATE pay_periods SET status = 'open', reopened_at = now(), reopen_reason = ? WHERE id = ?`)
      .run(body.reason, period.id);
    // What it reimbursed waits for the next close again.
    await unpayClaims(period);
    await audit(req.user.id, 'pay_period.reopened', 'pay_period', period.id, { reason: body.reason }, req.ip);
    res.json({ period: present(await loadPeriod(period.id)) });
  })
);

/* ---------------------------------------------------------------- export --- */

const csvCell = (v) => {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * The payroll register: one row per officer, W-2 employees and 1099
 * contractors in separate blocks, the way they are filed.
 */
payrollRouter.get(
  '/periods/:id/register.csv',
  onlyAdmin,
  wrap(async (req, res) => {
    const period = await loadPeriod(req.params.id);
    const expenses = await periodExpenses(period);
    const lines = withReimbursements(await linesFor(period), expenses);
    const header = [
      'Classification',
      'Employee code',
      'Name',
      'Business name',
      'Pay type',
      'Shifts',
      'Regular hours',
      'Overtime hours',
      'Total hours',
      'Regular pay',
      'Overtime pay',
      'Gross pay',
      'Reimbursements',
      'Sites',
      'Status',
    ];
    const rows = [header.join(',')];
    for (const type of ['w2', '1099']) {
      for (const l of lines.filter((x) => x.employment_type === type)) {
        rows.push(
          [
            type === 'w2' ? 'W-2' : '1099',
            l.employee_code,
            l.officer,
            l.business_name || '',
            l.pay_type,
            l.entries,
            l.regular_hours,
            l.overtime_hours,
            l.hours,
            l.regular_pay,
            l.overtime_pay,
            l.gross_pay,
            l.reimbursement || '',
            l.sites.map((s) => `${s.site} ${s.hours}h`).join('; '),
            l.approval.state,
          ]
            .map(csvCell)
            .join(',')
        );
      }
    }
    const t = totalsOf(lines);
    rows.push('');
    rows.push(['Total W-2', '', '', '', '', '', '', '', t.w2.hours, '', '', t.w2.pay].map(csvCell).join(','));
    rows.push(['Total 1099', '', '', '', '', '', '', '', t.contractor.hours, '', '', t.contractor.pay].map(csvCell).join(','));
    rows.push(['Total', '', '', '', '', '', '', t.overtime_hours, t.hours, '', t.overtime_pay, t.gross_pay].map(csvCell).join(','));
    // Reimbursements are paid with the wages but are not wages: their own total.
    if (expenses.total) rows.push(['Total reimbursements', '', '', '', '', '', '', '', '', '', '', '', expenses.total].map(csvCell).join(','));
    // Claims for officers with no hours in the period are paid all the same.
    const lineUsers = new Set(lines.map((l) => l.user_id));
    const orphans = expenses.claims.filter((c) => !lineUsers.has(c.user_id));
    if (orphans.length) {
      rows.push('');
      rows.push(['Reimbursements to officers with no hours in the period'].map(csvCell).join(','));
      for (const c of orphans) {
        rows.push(['', c.employee_code, c.officer, '', '', '', '', '', '', '', '', '', c.amount, c.category_label].map(csvCell).join(','));
      }
    }

    const name = `payroll-${dayString(period.period_start)}-to-${dayString(period.period_end)}.csv`;
    await audit(req.user.id, 'pay_period.exported', 'pay_period', period.id, null, req.ip);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(rows.join('\n'));
  })
);
