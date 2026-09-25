/**
 * Invoicing.
 *
 * An invoice is built from hours already captured by the time clock, priced
 * at the bill rate that applied to each hour. Nothing is typed in twice, so
 * what the client is charged and what the officer was recorded as working
 * cannot drift apart.
 *
 * The cost figure carried on each invoice is direct labour at each officer's
 * base hourly rate. It is there so margin survives on the record; it is not
 * payroll, and the overtime premium - which accrues to an officer's week
 * rather than to one client's site - is deliberately not apportioned here.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, parseDay, toDateString } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import {
  ROLES,
  INVOICE_STATUS,
  canTransitionInvoice,
  amountForMinutes,
  effectiveBillRate,
  billableMinutes,
  invoiceTotals,
  daysOverdue,
  toHours,
} from '../shared.js';
import { toSql } from '../services/compliance.js';
import { notifyInvoiceIssued, emailKind } from '../services/email.js';
import { loadRateBook, rateOn, dayOf } from '../services/payroll.js';

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

const onlyAdmin = requireRole(ROLES.ADMIN);
const TIMES = ['issued_at', 'paid_at', 'created_at'];

/* ------------------------------------------------------------ building --- */

/**
 * Price a site's worked hours for a period.
 *
 * Grouped by post and by rate: a post whose rate changed mid-period, or that
 * ran an overtime-rate weekend, produces one line per rate rather than an
 * averaged figure the client cannot check.
 */
export async function buildLines({ siteId, start, end }) {
  const rows = await db
    .prepare(
      `SELECT te.id, te.user_id, te.clock_in_at, te.minutes_worked, te.unpaid_break_minutes,
              p.id AS post_id, p.name AS post_name, p.bill_rate_cents AS post_rate,
              sh.bill_rate_cents AS shift_rate,
              u.bill_rate_cents AS officer_rate, u.pay_rate_cents, u.pay_type, u.overtime_multiplier
       FROM time_entries te
       JOIN posts p ON p.id = te.post_id
       JOIN users u ON u.id = te.user_id
       LEFT JOIN shifts sh ON sh.id = te.shift_id
       WHERE p.site_id = ?
         AND te.clock_out_at IS NOT NULL
         AND te.clock_in_at >= ? AND te.clock_in_at < ?
       ORDER BY p.name, te.clock_in_at`
    )
    .all(siteId, toSql(start), toSql(end));

  // Cost at the pay rate in effect on the day, as the reports price it.
  const book = await loadRateBook();
  const groups = new Map();
  const unpriced = [];

  for (const r of rows) {
    const minutes = billableMinutes(r.minutes_worked, r.unpaid_break_minutes);
    if (minutes === 0) continue;

    const rate = effectiveBillRate({
      shiftRateCents: r.shift_rate,
      postRateCents: r.post_rate,
      officerRateCents: r.officer_rate,
    });

    // Hours with no rate anywhere are reported rather than billed at zero -
    // silently giving work away is worse than an invoice that will not build.
    if (rate == null) {
      unpriced.push({ post_id: r.post_id, post_name: r.post_name, minutes });
      continue;
    }

    const key = `${r.post_id}:${rate}`;
    const group = groups.get(key) || {
      post_id: r.post_id,
      post_name: r.post_name,
      rate_cents: rate,
      minutes: 0,
      cost_cents: 0,
      entries: 0,
    };
    group.minutes += minutes;
    group.entries += 1;
    group.cost_cents += amountForMinutes(minutes, rateOn(book, r, dayOf(r.clock_in_at)).rate || 0);
    groups.set(key, group);
  }

  const rateCounts = new Map();
  for (const g of groups.values()) rateCounts.set(g.post_id, (rateCounts.get(g.post_id) || 0) + 1);

  const lines = [...groups.values()]
    .sort((a, b) => a.post_name.localeCompare(b.post_name) || a.rate_cents - b.rate_cents)
    .map((g, i) => ({
      post_id: g.post_id,
      // Only name the rate when a post has more than one, so the common case
      // reads as a plain post name.
      description:
        rateCounts.get(g.post_id) > 1
          ? `${g.post_name} (at $${(g.rate_cents / 100).toFixed(2)}/hr)`
          : g.post_name,
      minutes: g.minutes,
      hours: toHours(g.minutes),
      rate_cents: g.rate_cents,
      amount_cents: amountForMinutes(g.minutes, g.rate_cents),
      cost_cents: g.cost_cents,
      sequence: i,
    }));

  return { lines, unpriced };
}

/** INV-2026-0001, restarting each calendar year. */
export async function nextNumber(year) {
  const row = await db
    .prepare(`SELECT number FROM invoices WHERE number LIKE ? ORDER BY number DESC LIMIT 1`)
    .get(`INV-${year}-%`);
  const last = row ? Number(String(row.number).split('-')[2]) : 0;
  return `INV-${year}-${String(last + 1).padStart(4, '0')}`;
}

/* --------------------------------------------------------------- period --- */

/** Read periodStart/periodEnd, defaulting to the calendar month just gone. */
function readPeriod(query) {
  if (query.periodStart || query.from) {
    const start = parseDay(query.periodStart || query.from);
    const end = parseDay(query.periodEnd || query.to);
    if (!start || !end) throw new HttpError(422, 'Those dates are not valid.');
    if (end < start) throw new HttpError(422, 'The period ends before it starts.');
    return { start, end };
  }
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  return { start, end };
}

/** Time entries are timestamps, so the exclusive bound is the next midnight. */
const exclusiveEnd = (end) => new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);

/* -------------------------------------------------------------- preview --- */

/** What an invoice for this site and period would look like, unsaved. */
invoicesRouter.get(
  '/preview',
  wrap(async (req, res) => {
    const siteId = Number(req.query.siteId);
    if (!siteId) throw new HttpError(422, 'Choose a site to bill.');

    const site = await db.prepare(`SELECT * FROM sites WHERE id = ?`).get(siteId);
    if (!site) throw new HttpError(404, 'Site not found.');

    const { start, end } = readPeriod(req.query);
    const { lines, unpriced } = await buildLines({ siteId, start, end: exclusiveEnd(end) });
    const taxPercent = Number(req.query.taxPercent) || 0;

    // An overlapping invoice almost always means someone is about to bill the
    // same hours twice.
    const overlapping = await db
      .prepare(
        `SELECT id, number, period_start, period_end, status FROM invoices
         WHERE site_id = ? AND status != 'void' AND period_start <= ? AND period_end >= ?`
      )
      .all(siteId, toDateString(end), toDateString(start));

    res.json({
      site: { id: site.id, name: site.name, client_name: site.client_name },
      periodStart: toDateString(start),
      periodEnd: toDateString(end),
      lines,
      unpriced,
      totals: invoiceTotals(lines, taxPercent),
      overlapping,
    });
  })
);

/* --------------------------------------------------------------- create --- */

const createSchema = z.object({
  siteId: z.number().int().positive(),
  periodStart: z.string().min(8),
  periodEnd: z.string().min(8),
  taxPercent: z.number().min(0).max(30).default(0),
  dueDays: z.number().int().min(0).max(120).default(30),
  notes: z.string().max(2000).optional().nullable(),
});

invoicesRouter.post(
  '/',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(createSchema, req.body);

    const site = await db.prepare(`SELECT * FROM sites WHERE id = ?`).get(body.siteId);
    if (!site) throw new HttpError(404, 'Site not found.');

    const start = parseDay(body.periodStart);
    const end = parseDay(body.periodEnd);
    if (!start || !end) throw new HttpError(422, 'Those dates are not valid.');
    if (end < start) throw new HttpError(422, 'The period ends before it starts.');

    const { lines, unpriced } = await buildLines({ siteId: site.id, start, end: exclusiveEnd(end) });
    if (lines.length === 0) {
      throw new HttpError(
        409,
        unpriced.length > 0
          ? 'Every hour in this period is missing a bill rate. Set one on the post before invoicing.'
          : 'There are no billable hours in this period.'
      );
    }

    const totals = invoiceTotals(lines, body.taxPercent);
    const due = new Date(Date.now() + body.dueDays * 86400000);

    const invoice = await db.transaction(async () => {
      const number = await nextNumber(new Date().getFullYear());
      const created = await db
        .prepare(
          `INSERT INTO invoices
           (number, site_id, period_start, period_end, status, subtotal_cents, tax_cents,
            total_cents, cost_cents, notes, due_on, created_by)
           VALUES (?,?,?,?,'draft',?,?,?,?,?,?,?)`
        )
        .run(
          number,
          site.id,
          toDateString(start),
          toDateString(end),
          totals.subtotalCents,
          totals.taxCents,
          totals.totalCents,
          totals.costCents,
          body.notes?.trim() || null,
          toDateString(due),
          req.user.id
        );

      const id = Number(created.lastInsertRowid);
      for (const line of lines) {
        await db
          .prepare(
            `INSERT INTO invoice_lines
             (invoice_id, post_id, description, minutes, rate_cents, amount_cents, cost_cents, sequence)
             VALUES (?,?,?,?,?,?,?,?)`
          )
          .run(
            id, line.post_id, line.description, line.minutes,
            line.rate_cents, line.amount_cents, line.cost_cents, line.sequence
          );
      }
      return db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id);
    })();

    await audit(req.user.id, 'invoice.created', 'invoice', invoice.id, {
      number: invoice.number,
      total: totals.totalCents,
    }, req.ip);

    res.status(201).json({ invoice: isoFields(invoice, TIMES), lines, unpriced, totals });
  })
);

/* ----------------------------------------------------------------- list --- */

invoicesRouter.get(
  '/',
  wrap(async (req, res) => {
    const filters = [];
    const params = [];
    if (req.query.status) {
      filters.push('i.status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.siteId) {
      filters.push('i.site_id = ?');
      params.push(Number(req.query.siteId));
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const rows = await db
      .prepare(
        `SELECT i.*, s.name AS site_name, s.client_name,
                (SELECT COUNT(*) FROM invoice_lines l WHERE l.invoice_id = i.id) AS line_count
         FROM invoices i JOIN sites s ON s.id = i.site_id
         ${where}
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT 300`
      )
      .all(...params);

    const summary = await db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'draft' THEN total_cents ELSE 0 END), 0) AS draft_cents,
           COALESCE(SUM(CASE WHEN status = 'sent'  THEN total_cents ELSE 0 END), 0) AS outstanding_cents,
           COALESCE(SUM(CASE WHEN status = 'paid'  THEN total_cents ELSE 0 END), 0) AS paid_cents,
           COALESCE(SUM(CASE WHEN status != 'void' THEN cost_cents ELSE 0 END), 0) AS cost_cents,
           COALESCE(SUM(CASE WHEN status != 'void' THEN subtotal_cents ELSE 0 END), 0) AS billed_cents
         FROM invoices`
      )
      .get();

    res.json({
      invoices: rows.map((r) => ({
        ...isoFields(r, TIMES),
        overdue_days: daysOverdue(r.due_on, r.status),
      })),
      summary: {
        ...summary,
        margin_cents: summary.billed_cents - summary.cost_cents,
        margin_percent: summary.billed_cents > 0
          ? Math.round(((summary.billed_cents - summary.cost_cents) / summary.billed_cents) * 1000) / 10
          : null,
      },
    });
  })
);

/* --------------------------------------------------------------- detail --- */

async function loadInvoice(id) {
  const invoice = await db
    .prepare(
      `SELECT i.*, s.name AS site_name, s.client_name, s.address, s.city, s.state, s.postal_code,
              s.contact_name, s.contact_email,
              u.first_name || ' ' || u.last_name AS created_by_name
       FROM invoices i
       JOIN sites s ON s.id = i.site_id
       LEFT JOIN users u ON u.id = i.created_by
       WHERE i.id = ?`
    )
    .get(id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');

  const lines = await db
    .prepare(`SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sequence, id`)
    .all(invoice.id);

  return { invoice, lines: lines.map((l) => ({ ...l, hours: toHours(l.minutes) })) };
}

invoicesRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const { invoice, lines } = await loadInvoice(req.params.id);
    res.json({
      invoice: { ...isoFields(invoice, TIMES), overdue_days: daysOverdue(invoice.due_on, invoice.status) },
      lines,
      totals: invoiceTotals(lines, invoice.subtotal_cents > 0
        ? (invoice.tax_cents / invoice.subtotal_cents) * 100
        : 0),
    });
  })
);

/* --------------------------------------------------------------- update --- */

invoicesRouter.patch(
  '/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const invoice = await db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(req.params.id);
    if (!invoice) throw new HttpError(404, 'Invoice not found.');

    const body = parse(
      z.object({
        status: z.enum(INVOICE_STATUS).optional(),
        notes: z.string().max(2000).optional().nullable(),
        dueOn: z.string().optional().nullable(),
      }),
      req.body
    );

    let notified = null;

    if (body.status && body.status !== invoice.status) {
      if (!canTransitionInvoice(invoice.status, body.status)) {
        throw new HttpError(
          409,
          `A ${invoice.status} invoice cannot be marked ${body.status}.` +
            (invoice.status === 'sent' ? ' Void it and raise a new one instead.' : '')
        );
      }
      const stamps = {
        sent: `issued_at = now()`,
        paid: `paid_at = now()`,
      };
      await db
        .prepare(
          `UPDATE invoices SET status = ?${stamps[body.status] ? `, ${stamps[body.status]}` : ''} WHERE id = ?`
        )
        .run(body.status, invoice.id);
      await audit(req.user.id, `invoice.${body.status}`, 'invoice', invoice.id, { number: invoice.number }, req.ip);

      // Issuing an invoice is the moment the client needs telling. Awaited so
      // the response can report how many contacts were notified, but it never
      // throws - a mail failure must not undo an issued invoice.
      if (body.status === 'sent') {
        const { invoice: issued } = await loadInvoice(invoice.id);
        notified = await notifyInvoiceIssued(issued).catch((err) => {
          console.error('[usc] invoice notification failed:', err.message);
          return 0;
        });
      }
    }

    if (body.notes !== undefined) {
      await db.prepare(`UPDATE invoices SET notes = ? WHERE id = ?`).run(body.notes?.trim() || null, invoice.id);
    }
    if (body.dueOn !== undefined) {
      const due = body.dueOn ? parseDay(body.dueOn) : null;
      if (body.dueOn && !due) throw new HttpError(422, 'That due date is not valid.');
      await db.prepare(`UPDATE invoices SET due_on = ? WHERE id = ?`).run(due ? toDateString(due) : null, invoice.id);
    }

    const { invoice: updated, lines } = await loadInvoice(invoice.id);
    res.json({
      invoice: { ...isoFields(updated, TIMES), overdue_days: daysOverdue(updated.due_on, updated.status) },
      lines,
      notified,
      emailConfigured: emailKind === 'resend',
    });
  })
);

/* --------------------------------------------------------------- delete --- */

invoicesRouter.delete(
  '/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const invoice = await db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(req.params.id);
    if (!invoice) throw new HttpError(404, 'Invoice not found.');

    // Once a number has gone to a client it stays in the ledger; void it.
    if (invoice.status !== 'draft') {
      throw new HttpError(409, `Invoice ${invoice.number} has been issued. Void it rather than deleting it.`);
    }

    await db.prepare(`DELETE FROM invoices WHERE id = ?`).run(invoice.id);
    await audit(req.user.id, 'invoice.deleted', 'invoice', invoice.id, { number: invoice.number }, req.ip);
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ CSV --- */

invoicesRouter.get(
  '/:id/csv',
  wrap(async (req, res) => {
    const { invoice, lines } = await loadInvoice(req.params.id);

    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const money = (cents) => (cents / 100).toFixed(2);

    const rows = [
      ['Invoice', invoice.number],
      ['Client', invoice.client_name || ''],
      ['Site', invoice.site_name],
      ['Period', `${invoice.period_start} to ${invoice.period_end}`],
      ['Status', invoice.status],
      ['Due', invoice.due_on || ''],
      [],
      ['Description', 'Hours', 'Rate', 'Amount'],
      ...lines.map((l) => [l.description, toHours(l.minutes), money(l.rate_cents), money(l.amount_cents)]),
      [],
      ['Subtotal', '', '', money(invoice.subtotal_cents)],
      ['Tax', '', '', money(invoice.tax_cents)],
      ['Total', '', '', money(invoice.total_cents)],
    ];

    await audit(req.user.id, 'export.invoice', 'invoice', invoice.id, { number: invoice.number }, req.ip);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.number}.csv"`);
    res.send(rows.map((r) => r.map(esc).join(',')).join('\n'));
  })
);
