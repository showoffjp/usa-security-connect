/**
 * Expense claims.
 *
 *   * An officer claims back what they spent on the job, with a photo of the
 *     receipt, and can withdraw a claim nobody has decided yet.
 *   * Supervisors see the queue; only an administrator approves or declines,
 *     since it is money - and never their own claim.
 *   * The receipt is served through the API, to the claimant and to staff.
 */

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam, parseDay, toDateString } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import {
  ROLES,
  atLeast,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABEL,
  EXPENSE_WINDOW_DAYS,
  EXPENSE_MAX_CENTS,
  MILEAGE_RATE_CENTS,
  RECEIPT_REQUIRED_CENTS,
  expenseAmountCents,
} from '../shared.js';
import * as storage from '../services/storage.js';
import { CLAIM_SELECT, presentClaim, loadClaim } from '../services/expenses.js';

export const expensesRouter = Router();
expensesRouter.use(requireAuth);

const onlySupervisor = requireRole(ROLES.SUPERVISOR);
const onlyAdmin = requireRole(ROLES.ADMIN);

const RECEIPT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!RECEIPT_TYPES.has(file.mimetype)) return cb(new HttpError(422, 'A receipt must be a photo (JPEG, PNG, WebP, HEIC) or a PDF.'));
    cb(null, true);
  },
});

const rules = {
  mileageRateCents: MILEAGE_RATE_CENTS,
  receiptRequiredCents: RECEIPT_REQUIRED_CENTS,
  windowDays: EXPENSE_WINDOW_DAYS,
  maxCents: EXPENSE_MAX_CENTS,
};

/* ------------------------------------------------------------ officer -- */

/** My claims, newest first, with what is waiting and what is on its way. */
expensesRouter.get(
  '/mine',
  wrap(async (req, res) => {
    const rows = await db.prepare(`${CLAIM_SELECT} WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT 100`).all(req.user.id);
    const claims = rows.map(presentClaim);
    const sum = (status) => claims.filter((c) => c.status === status).reduce((n, c) => n + c.amount_cents, 0) / 100;
    res.json({
      claims,
      summary: { pending: sum('pending'), approved: sum('approved'), paid: sum('paid') },
      rules,
      categories: EXPENSE_CATEGORIES.map((value) => ({ value, label: EXPENSE_CATEGORY_LABEL[value] })),
    });
  })
);

const claimSchema = z
  .object({
    category: z.enum(EXPENSE_CATEGORIES),
    incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the date you spent it.'),
    miles: z.coerce.number().positive('How many miles?').max(1000, 'More than 1,000 miles is not one claim.').optional(),
    amount: z.coerce.number().positive('How much was it?').optional(),
    description: z.string().trim().min(5, 'Say what it was for.').max(500),
    siteId: z.coerce.number().int().positive().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.category === 'mileage' && d.miles == null) ctx.addIssue({ code: 'custom', path: ['miles'], message: 'How many miles?' });
    if (d.category !== 'mileage' && d.amount == null) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'How much was it?' });
  });

expensesRouter.post(
  '/',
  upload.single('receipt'),
  wrap(async (req, res) => {
    // Multipart sends "" for an empty field; that is "not given", not zero.
    const fields = Object.fromEntries(Object.entries(req.body || {}).filter(([, v]) => v !== ''));
    const body = parse(claimSchema, fields);

    const day = parseDay(body.incurredOn);
    const today = parseDay();
    if (day > today) throw new HttpError(422, 'A claim is for money already spent.', [{ field: 'incurredOn', message: 'Not a future date.' }]);
    if ((today - day) / 86400000 > EXPENSE_WINDOW_DAYS) {
      throw new HttpError(422, `Claims go back ${EXPENSE_WINDOW_DAYS} days. Ask the office about anything older.`, [
        { field: 'incurredOn', message: `Within the last ${EXPENSE_WINDOW_DAYS} days.` },
      ]);
    }
    const cents = expenseAmountCents({ category: body.category, miles: body.miles, amountCents: Math.round((body.amount || 0) * 100) });
    if (cents <= 0) throw new HttpError(422, 'A claim has to be for something.', [{ field: 'amount', message: 'More than nothing.' }]);
    if (cents > EXPENSE_MAX_CENTS) {
      throw new HttpError(422, `One claim can be up to $${EXPENSE_MAX_CENTS / 100}. Split it, or ask the office.`, [{ field: 'amount', message: 'Too much for one claim.' }]);
    }
    if (body.category !== 'mileage' && cents > RECEIPT_REQUIRED_CENTS && !req.file) {
      throw new HttpError(422, `A receipt is needed for anything over $${RECEIPT_REQUIRED_CENTS / 100}.`, [{ field: 'receipt', message: 'Add a photo of the receipt.' }]);
    }
    if (body.siteId && !(await db.prepare(`SELECT id FROM sites WHERE id = ?`).get(body.siteId))) {
      throw new HttpError(404, 'Site not found.');
    }

    let stored = null;
    if (req.file) {
      stored = await storage.put({
        buffer: req.file.buffer,
        filename: storage.generateFilename(req.file.originalname),
        mimeType: req.file.mimetype,
      });
    }
    const info = await db
      .prepare(
        `INSERT INTO expense_claims (user_id, site_id, category, incurred_on, miles, amount_cents, description,
           receipt_filename, receipt_url, receipt_type)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        req.user.id,
        body.siteId ?? null,
        body.category,
        toDateString(day),
        body.category === 'mileage' ? body.miles : null,
        cents,
        body.description,
        stored?.filename ?? null,
        stored?.storageUrl ?? null,
        req.file?.mimetype ?? null
      );
    const id = Number(info.lastInsertRowid);
    await audit(req.user.id, 'expense.claimed', 'expense_claim', id, { category: body.category, cents }, req.ip);
    res.status(201).json({ claim: presentClaim(await loadClaim(id)) });
  })
);

expensesRouter.post(
  '/:id/withdraw',
  wrap(async (req, res) => {
    const claim = await loadClaim(idParam(req.params.id, 'claim'));
    if (!claim || claim.user_id !== req.user.id) throw new HttpError(404, 'Claim not found.');
    if (claim.status !== 'pending') throw new HttpError(409, 'Only a claim still waiting for a decision can be withdrawn.');
    await db.prepare(`UPDATE expense_claims SET status = 'withdrawn' WHERE id = ?`).run(claim.id);
    await audit(req.user.id, 'expense.withdrawn', 'expense_claim', claim.id, null, req.ip);
    res.json({ claim: presentClaim(await loadClaim(claim.id)) });
  })
);

/** The receipt, to the claimant and to staff only. */
expensesRouter.get(
  '/:id/receipt',
  wrap(async (req, res) => {
    const claim = await loadClaim(idParam(req.params.id, 'claim'));
    if (!claim || (claim.user_id !== req.user.id && !atLeast(req.user.role, ROLES.SUPERVISOR))) {
      throw new HttpError(404, 'Claim not found.');
    }
    if (!claim.receipt_filename) throw new HttpError(404, 'No receipt with this claim.');
    let buffer;
    try {
      buffer = await storage.read({ filename: claim.receipt_filename, storage_url: claim.receipt_url });
    } catch (err) {
      throw new HttpError(404, err.message || 'Receipt file is missing.');
    }
    res.type(claim.receipt_type || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    // Shown as a document of its own: nothing in it can run or reach anything.
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  })
);

/* -------------------------------------------------------------- staff -- */

const STATUSES = ['pending', 'approved', 'declined', 'withdrawn', 'paid'];

expensesRouter.get(
  '/',
  onlySupervisor,
  wrap(async (req, res) => {
    const status = req.query.status && STATUSES.includes(String(req.query.status)) ? String(req.query.status) : null;
    const rows = await db
      .prepare(`${CLAIM_SELECT} ${status ? 'WHERE c.status = ?' : ''} ORDER BY c.status = 'pending' DESC, c.created_at DESC LIMIT 300`)
      .all(...(status ? [status] : []));
    const counts = await db.prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS cents FROM expense_claims GROUP BY status`).all();
    const summary = Object.fromEntries(STATUSES.map((s) => {
      const r = counts.find((x) => x.status === s);
      return [s, { count: Number(r?.n || 0), amount: Number(r?.cents || 0) / 100 }];
    }));
    res.json({ claims: rows.map(presentClaim), summary, rules });
  })
);

async function decide(req, res, approve) {
  const body = parse(
    z.object({ note: approve ? z.string().trim().max(500).optional() : z.string().trim().min(5, 'Say why, so the officer knows.').max(500) }),
    req.body || {}
  );
  const claim = await loadClaim(idParam(req.params.id, 'claim'));
  if (!claim) throw new HttpError(404, 'Claim not found.');
  if (claim.user_id === req.user.id) throw new HttpError(403, 'Someone else has to decide your own claim.');
  if (claim.status !== 'pending') throw new HttpError(409, `That claim was already ${claim.status}.`);
  await db
    .prepare(`UPDATE expense_claims SET status = ?, decided_by = ?, decided_at = now(), decision_note = ? WHERE id = ?`)
    .run(approve ? 'approved' : 'declined', req.user.id, body.note || null, claim.id);
  await audit(req.user.id, approve ? 'expense.approved' : 'expense.declined', 'expense_claim', claim.id, { cents: claim.amount_cents }, req.ip);
  res.json({ claim: presentClaim(await loadClaim(claim.id)) });
}

expensesRouter.post('/:id/approve', onlyAdmin, wrap((req, res) => decide(req, res, true)));
expensesRouter.post('/:id/decline', onlyAdmin, wrap((req, res) => decide(req, res, false)));
