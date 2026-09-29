import { Router } from 'express';
import { z } from 'zod';
import { db, audit, demoInstance } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, sqlToIso, parseDay, toDateString } from '../lib/http.js';
import { requireAuth, requireRole, hashPin, generatePin, generateEmployeeCode, publicUser } from '../lib/auth.js';
import {
  ROLES,
  RULES,
  EMPLOYEE_STATUS,
  EMPLOYMENT_TYPES,
  PAY_TYPES,
  FLAG_LABEL,
  splitOvertime,
  computePay,
  expiryState,
  toHours,
  minutesBetween,
  shiftEligibility,
  blocksAssignment,
  payrollWeekOf,
  distanceMeters,
} from '../shared.js';
import { toSql, sweep } from '../services/compliance.js';
import { emailKind } from '../services/email.js';
import { recordPayHistory } from '../services/payHistory.js';
import { loadPricedEntries, personPay, groupBy } from '../services/payroll.js';
import { assertHoursOpen } from '../services/payPeriods.js';
import { checkEligibility } from './shiftRequests.js';
import { pushAsync } from '../services/push.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

const onlyAdmin = requireRole(ROLES.ADMIN);

/* =============================================================== dashboard === */

adminRouter.get(
  '/dashboard',
  wrap(async (req, res) => {
    await sweep(); // never show a supervisor stale compliance numbers

    const onDuty = (await db
      .prepare(
        `SELECT te.id, te.clock_in_at, te.clock_in_geofence, te.late_minutes,
                u.id AS user_id, u.employee_code,
                u.first_name || ' ' || u.last_name AS officer,
                p.name AS post_name, s.name AS site_name,
                (SELECT COUNT(*) FROM status_checks sc
                  WHERE sc.time_entry_id = te.id AND sc.status = 'missed') AS missed_checks,
                (SELECT MIN(due_at) FROM status_checks sc
                  WHERE sc.time_entry_id = te.id AND sc.status = 'pending') AS next_check_due
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.clock_out_at IS NULL
         ORDER BY te.clock_in_at`
      )
      .all());

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const counts = {
      openFlags: (await db.prepare(`SELECT COUNT(*) AS n FROM flags WHERE resolved_at IS NULL`).get()).n,
      openIncidents: (await db.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE status != 'closed'`).get()).n,
      onDuty: onDuty.length,
      activeStaff: (await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`).get()).n,
      shiftsToday: (await db
        .prepare(`SELECT COUNT(*) AS n FROM shifts WHERE date(starts_at) = date('now')`)
        .get()).n,
      hoursToday: toHours(
        (await db
          .prepare(`SELECT COALESCE(SUM(minutes_worked),0) AS m FROM time_entries WHERE clock_in_at >= ?`)
          .get(toSql(todayStart))).m
      ),
    };

    const recentFlags = (await db
      .prepare(
        `SELECT f.*, u.employee_code, u.first_name || ' ' || u.last_name AS officer
         FROM flags f JOIN users u ON u.id = f.user_id
         WHERE f.resolved_at IS NULL
         ORDER BY f.occurred_at DESC LIMIT 15`
      )
      .all());

    const upcoming = (await db
      .prepare(
        `SELECT sh.*, p.name AS post_name, s.name AS site_name,
                u.first_name || ' ' || u.last_name AS officer
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         LEFT JOIN users u ON u.id = sh.user_id
         WHERE sh.starts_at BETWEEN datetime('now') AND datetime('now', '+12 hours')
           AND sh.status = 'scheduled'
         ORDER BY sh.starts_at LIMIT 20`
      )
      .all());

    const unfilled = (await db
      .prepare(
        `SELECT COUNT(*) AS n FROM shifts
         WHERE user_id IS NULL AND starts_at > datetime('now') AND status = 'scheduled'`
      )
      .get()).n;

    const activeAlerts = (await db
      .prepare(`SELECT COUNT(*) AS n FROM panic_alerts WHERE status IN ('active','acknowledged')`)
      .get()).n;

    const pendingTimeOff = (await db
      .prepare(`SELECT COUNT(*) AS n FROM time_off_requests WHERE status = 'pending'`)
      .get()).n;

    // Issued, past its due date and still unpaid: the only invoices anyone
    // needs to be nudged about.
    const overdueInvoices = (await db
      .prepare(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'sent' AND due_on < current_date`)
      .get()).n;

    // A swap still waiting on the other officer is not the supervisor's to act
    // on yet, so it is not counted here.
    const openShiftRequests = (await db
      .prepare(
        `SELECT COUNT(*) AS n FROM shift_requests
         WHERE status = 'accepted' OR (status = 'pending' AND kind != 'swap')`
      )
      .get()).n;

    // Anything that lapses within 60 days, across certifications, state
    // licences and contractor insurance.
    const expiringCredentials =
      (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM certifications c JOIN users u ON u.id = c.user_id
           WHERE c.expires_on IS NOT NULL AND u.status IN ('active','on_leave')
             AND date(c.expires_on) <= date('now','+60 days')`
        )
        .get()).n +
      (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM users
           WHERE license_expires_on IS NOT NULL AND status IN ('active','on_leave')
             AND date(license_expires_on) <= date('now','+60 days')`
        )
        .get()).n +
      (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM users
           WHERE insurance_expires_on IS NOT NULL AND employment_type = '1099'
             AND status IN ('active','on_leave')
             AND date(insurance_expires_on) <= date('now','+60 days')`
        )
        .get()).n;

    // Officers on the clock whose latest position is outside their post, and
    // shifts under way that nobody has clocked into yet.
    const offPost = Number((await db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT DISTINCT ON (lp.user_id) lp.geofence
           FROM location_pings lp
           JOIN time_entries te ON te.id = lp.time_entry_id AND te.clock_out_at IS NULL
           ORDER BY lp.user_id, lp.recorded_at DESC
         ) latest WHERE latest.geofence = 'outside'`
      )
      .get()).n);
    const lateNow = Number((await db
      .prepare(
        `SELECT COUNT(*) AS n FROM shifts sh
         WHERE sh.user_id IS NOT NULL AND sh.status IN ('scheduled','missed')
           AND sh.starts_at < ? AND sh.ends_at > now()
           AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.shift_id = sh.id)`
      )
      .get(toSql(new Date(Date.now() - RULES.lateGraceMinutes * 60000)))).n);

    // Extra coverage clients have asked for and nobody has answered yet.
    const coverageRequests = Number((await db
      .prepare(`SELECT COUNT(*) AS n FROM coverage_requests WHERE status = 'open'`)
      .get()).n);

    // Pay periods that have ended and are still waiting to be closed.
    // Items that should have come back and have not: the officer holding them
    // is off the clock. The same condition the sweep flags on, so the badge and
    // the flag list can never disagree.
    const equipmentOut = Number((await db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM equipment_assignments ea
         JOIN equipment e ON e.id = ea.equipment_id
         WHERE ea.returned_at IS NULL
           AND e.return_by_end_of_shift = true
           AND NOT EXISTS (
             SELECT 1 FROM time_entries te
             WHERE te.user_id = ea.user_id AND te.clock_out_at IS NULL
           )`
      )
      .get()).n);

    // People signed in at a post and not yet signed out, across every site.
    const visitorsOnSite = Number((await db
      .prepare(`SELECT COUNT(*) AS n FROM visitor_log WHERE departed_at IS NULL`)
      .get()).n);

    const payrollDue = Number((await db
      .prepare(`SELECT COUNT(*) AS n FROM pay_periods WHERE status = 'open' AND period_end < ?`)
      .get(toDateString(new Date()))).n);

    const openAlerts = (await db
      .prepare(
        `SELECT p.*, u.first_name || ' ' || u.last_name AS officer, u.phone,
                po.name AS post_name
         FROM panic_alerts p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN posts po ON po.id = p.post_id
         WHERE p.status IN ('active','acknowledged')
         ORDER BY p.triggered_at DESC`
      )
      .all());

    res.json({
      counts: {
        ...counts,
        unfilledShifts: unfilled,
        activeAlerts,
        pendingTimeOff,
        openShiftRequests,
        overdueInvoices,
        expiringCredentials,
        offPost,
        lateNow,
        lateOrOff: offPost + lateNow,
        payrollDue,
        equipmentOut,
        coverageRequests,
        visitorsOnSite,
      },
      alerts: openAlerts.map((a) => isoFields(a, ['triggered_at', 'acknowledged_at'])),
      onDuty: onDuty.map((r) => ({
        ...isoFields(r, ['clock_in_at', 'next_check_due']),
        minutes_on_post: minutesBetween(sqlToIso(r.clock_in_at), new Date().toISOString()),
      })),
      recentFlags: recentFlags.map((f) => ({
        ...isoFields(f, ['occurred_at', 'created_at']),
        label: FLAG_LABEL[f.type] || f.type,
      })),
      upcoming: upcoming.map((s) => isoFields(s, ['starts_at', 'ends_at'])),
    });
  })
);

/* =============================================================== employees === */

adminRouter.get(
  '/employees',
  wrap(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      where.push('u.status = ?');
      params.push(req.query.status);
    }
    if (req.query.role) {
      where.push('u.role = ?');
      params.push(req.query.role);
    }
    if (req.query.search) {
      where.push(`(u.first_name || ' ' || u.last_name LIKE ? OR u.employee_code LIKE ? OR u.email LIKE ?)`);
      const q = `%${req.query.search}%`;
      params.push(q, q, q);
    }

    const rows = (await db
      .prepare(
        `SELECT u.*, s.name AS default_site_name,
                (SELECT COUNT(*) FROM flags f WHERE f.user_id = u.id AND f.resolved_at IS NULL) AS open_flags,
                (SELECT COALESCE(SUM(minutes_worked),0) FROM time_entries te
                   WHERE te.user_id = u.id
                     AND te.clock_in_at >= date_trunc('week', now())) AS week_minutes,
                EXISTS(SELECT 1 FROM time_entries te WHERE te.user_id = u.id AND te.clock_out_at IS NULL) AS on_duty
         FROM users u
         LEFT JOIN sites s ON s.id = u.default_site_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY u.status, u.last_name, u.first_name`
      )
      .all(...params));

    res.json({
      employees: rows.map((u) => ({
        ...publicUser(isoFields(u, ['created_at', 'updated_at', 'last_login_at', 'pin_set_at'])),
        week_hours: toHours(u.week_minutes),
        on_duty: Boolean(u.on_duty),
      })),
    });
  })
);

/**
 * The employee fields, without the cross-field rules.
 *
 * Kept separate because `.refine()` produces a ZodEffects, and a ZodEffects
 * has no `.partial()` - so a PATCH cannot be built from the refined schema.
 * The rules are applied to the whole record instead, by classificationProblem
 * below.
 */
const employeeFields = z
  .object({
    firstName: z.string().trim().min(1, 'First name is required.').max(80),
    lastName: z.string().trim().min(1, 'Last name is required.').max(80),
    employeeCode: z.string().trim().regex(/^[0-9]{4,6}$/, 'Employee code must be 4-6 digits.').optional(),
    email: z.string().trim().email('Enter a valid email.').max(160).optional().or(z.literal('')),
    phone: z.string().trim().max(40).optional(),
    role: z.enum([ROLES.OFFICER, ROLES.SUPERVISOR, ROLES.ADMIN]).default(ROLES.OFFICER),
    status: z.enum(EMPLOYEE_STATUS).default('active'),
    hireDate: z.string().nullable().optional(),
    licenseNumber: z.string().trim().max(60).optional(),
    licenseType: z.string().trim().max(40).optional(),
    licenseExpiresOn: z.string().nullable().optional(),
    emergencyContactName: z.string().trim().max(120).optional(),
    emergencyContactPhone: z.string().trim().max(40).optional(),
    emergencyContactRelation: z.string().trim().max(60).optional(),
    defaultSiteId: z.number().int().positive().nullable().optional(),
    notes: z.string().max(2000).optional(),

    /* Employment classification and pay */
    employmentType: z.enum(EMPLOYMENT_TYPES).default('w2'),
    payType: z.enum(PAY_TYPES).default('hourly'),
    exempt: z.boolean().default(false),
    payRate: z.number().nonnegative().max(1000).nullable().optional(),
    salary: z.number().nonnegative().max(1_000_000).nullable().optional(),
    billRate: z.number().nonnegative().max(2000).nullable().optional(),
    overtimeMultiplier: z.number().min(1).max(3).default(1.5),

    /* 1099 contractor paperwork */
    businessName: z.string().trim().max(160).optional(),
    taxIdLast4: z.string().trim().regex(/^\d{4}$/, 'Enter the last four digits only.').optional().or(z.literal('')),
    w9OnFile: z.boolean().default(false),
    contractorAgreementOnFile: z.boolean().default(false),
    insuranceExpiresOn: z.string().nullable().optional(),

    /* Mailing address */
    addressLine1: z.string().trim().max(160).optional(),
    addressLine2: z.string().trim().max(160).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().max(2).optional(),
    postalCode: z.string().trim().max(12).optional(),
    uniformSize: z.string().trim().max(6).optional(),
  });

/**
 * The classification rules, as a plain check over a whole employee record.
 *
 * A contractor with no paperwork on file is the classic audit finding, so a
 * 1099 cannot be recorded as active without at least a W-9, and "exempt" is a
 * W-2 concept.
 *
 * This runs against the *merged* record on a PATCH - the row as it will be
 * after the change, not just the fields being changed. Checking the patch
 * alone would let `{ status: 'active' }` slip past on a contractor whose W-9
 * was never filed, which is exactly the case the rule exists for.
 */
export function classificationProblem(record) {
  if (record.employmentType === '1099' && record.status === 'active' && !record.w9OnFile) {
    return { field: 'w9OnFile', message: 'A 1099 contractor cannot be made active until their W-9 is on file.' };
  }
  if (record.employmentType === '1099' && record.exempt) {
    return { field: 'exempt', message: 'Exempt status applies to W-2 employees only.' };
  }
  return null;
}

const employeeSchema = employeeFields.superRefine((d, ctx) => {
  const problem = classificationProblem(d);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [problem.field], message: problem.message });
});

adminRouter.post(
  '/employees',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(employeeSchema, req.body);
    const code = body.employeeCode || await generateEmployeeCode();

    if ((await db.prepare(`SELECT 1 FROM users WHERE employee_code = ?`).get(code))) {
      throw new HttpError(409, `Employee code ${code} is already in use.`, [
        { field: 'employeeCode', message: 'Already taken.' },
      ]);
    }

    // The starting PIN is generated here and shown to the admin exactly once.
    const pin = generatePin(4);
    const { hash, salt } = hashPin(pin);

    // Built as a column map so adding a profile field later is a one-line change.
    const values = {
      employee_code: code,
      first_name: body.firstName,
      last_name: body.lastName,
      email: body.email || null,
      phone: body.phone || null,
      role: body.role,
      status: body.status,
      hire_date: body.hireDate || null,
      license_number: body.licenseNumber || null,
      license_type: body.licenseType || null,
      license_expires_on: body.licenseExpiresOn || null,
      emergency_contact_name: body.emergencyContactName || null,
      emergency_contact_phone: body.emergencyContactPhone || null,
      emergency_contact_relation: body.emergencyContactRelation || null,
      default_site_id: body.defaultSiteId ?? null,
      notes: body.notes || null,

      employment_type: body.employmentType,
      pay_type: body.payType,
      exempt: body.exempt ? 1 : 0,
      overtime_multiplier: body.overtimeMultiplier,
      pay_rate_cents: body.payRate != null ? Math.round(body.payRate * 100) : null,
      salary_cents: body.salary != null ? Math.round(body.salary * 100) : null,
      bill_rate_cents: body.billRate != null ? Math.round(body.billRate * 100) : null,

      business_name: body.businessName || null,
      tax_id_last4: body.taxIdLast4 || null,
      w9_on_file: body.w9OnFile ? 1 : 0,
      contractor_agreement_on_file: body.contractorAgreementOnFile ? 1 : 0,
      insurance_expires_on: body.insuranceExpiresOn || null,

      address_line1: body.addressLine1 || null,
      address_line2: body.addressLine2 || null,
      city: body.city || null,
      state: body.state || null,
      postal_code: body.postalCode || null,
      uniform_size: body.uniformSize || null,

      pin_hash: hash,
      pin_salt: salt,
    };

    const columns = Object.keys(values);
    const info = (await db
      .prepare(
        `INSERT INTO users (${columns.join(', ')}, pin_set_at, must_change_pin)
         VALUES (${columns.map(() => '?').join(', ')}, now(), true)`
      )
      .run(...Object.values(values)));

    await recordPayHistory(Number(info.lastInsertRowid), {
      changedBy: req.user.id,
      reason: 'Starting rate',
      effectiveOn: body.hireDate || null,
    });
    await audit(req.user.id, 'employee.created', 'user', Number(info.lastInsertRowid), { code, role: body.role }, req.ip);

    res.status(201).json({
      employee: publicUser((await db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid))),
      credentials: {
        employeeCode: code,
        pin,
        note: 'Give these to the officer now - the PIN is not stored in readable form and cannot be shown again.',
      },
    });
  })
);

adminRouter.get(
  '/employees/:id',
  wrap(async (req, res) => {
    const user = (await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id));
    if (!user) throw new HttpError(404, 'Employee not found.');

    const entries = (await db
      .prepare(
        `SELECT te.*, p.name AS post_name, s.name AS site_name
         FROM time_entries te
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.user_id = ? ORDER BY te.clock_in_at DESC LIMIT 60`
      )
      .all(user.id));

    const flags = (await db
      .prepare(`SELECT * FROM flags WHERE user_id = ? ORDER BY occurred_at DESC LIMIT 40`)
      .all(user.id));

    const shifts = (await db
      .prepare(
        `SELECT sh.*, p.name AS post_name, s.name AS site_name
         FROM shifts sh JOIN posts p ON p.id = sh.post_id JOIN sites s ON s.id = p.site_id
         WHERE sh.user_id = ? AND sh.starts_at > datetime('now','-7 days')
         ORDER BY sh.starts_at LIMIT 40`
      )
      .all(user.id));

    const totals = (await db
      .prepare(
        `SELECT COALESCE(SUM(minutes_worked),0) AS minutes, COUNT(*) AS shifts,
                COALESCE(SUM(CASE WHEN late_minutes > 0 THEN 1 ELSE 0 END),0) AS late_count
         FROM time_entries WHERE user_id = ? AND clock_in_at >= datetime('now','-30 days')`
      )
      .get(user.id));

    const certifications = (await db
      .prepare(`SELECT * FROM certifications WHERE user_id = ? ORDER BY expires_on IS NULL, expires_on`)
      .all(user.id));

    const availability = (await db
      .prepare(`SELECT * FROM availability WHERE user_id = ? ORDER BY weekday`)
      .all(user.id));

    const timeOff = (await db
      .prepare(
        `SELECT * FROM time_off_requests WHERE user_id = ?
         ORDER BY starts_on DESC LIMIT 20`
      )
      .all(user.id));

    // Show the money the same way the timesheet does, so the two agree.
    const pay = computePay({
      minutes: totals.minutes,
      employmentType: user.employment_type,
      payType: user.pay_type,
      exempt: Boolean(user.exempt),
      payRateCents: user.pay_rate_cents,
      billRateCents: user.bill_rate_cents,
      overtimeMultiplier: user.overtime_multiplier || 1.5,
      weeklyThresholdHours: 40 * 4,
      salaryCents: user.salary_cents,
      shifts: totals.shifts,
    });

    res.json({
      employee: publicUser(isoFields(user, ['created_at', 'updated_at', 'last_login_at', 'pin_set_at'])),
      entries: entries.map((e) => isoFields(e, ['clock_in_at', 'clock_out_at', 'created_at'])),
      flags: flags.map((f) => ({ ...isoFields(f, ['occurred_at', 'resolved_at']), label: FLAG_LABEL[f.type] || f.type })),
      shifts: shifts.map((s) => isoFields(s, ['starts_at', 'ends_at'])),
      certifications: certifications.map((c) => ({
        ...isoFields(c, ['created_at', 'verified_at']),
        expiry: expiryState(c.expires_on),
      })),
      availability,
      timeOff: timeOff.map((t) => isoFields(t, ['created_at', 'decided_at'])),
      last30Days: {
        hours: toHours(totals.minutes),
        shifts: totals.shifts,
        lateCount: totals.late_count,
        estimatedPay: pay.payCents != null ? pay.payCents / 100 : null,
        estimatedBill: pay.billCents != null ? pay.billCents / 100 : null,
        marginPercent: pay.marginPercent,
      },
    });
  })
);

adminRouter.patch(
  '/employees/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(employeeFields.partial(), req.body);
    const user = (await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id));
    if (!user) throw new HttpError(404, 'Employee not found.');

    // The classification rules apply to the record as it will be, so they are
    // checked against the existing row with the patch laid over it.
    const problem = classificationProblem({
      employmentType: body.employmentType ?? user.employment_type,
      status: body.status ?? user.status,
      exempt: body.exempt ?? user.exempt,
      w9OnFile: body.w9OnFile ?? user.w9_on_file,
    });
    if (problem) {
      throw new HttpError(422, 'Please correct the highlighted fields.', [problem]);
    }

    // Never let the last administrator demote or disable themselves out of the system.
    const losingAdmin =
      user.role === ROLES.ADMIN &&
      ((body.role && body.role !== ROLES.ADMIN) || (body.status && body.status !== 'active'));
    if (losingAdmin) {
      const admins = (await db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'`)
        .get()).n;
      if (admins <= 1) throw new HttpError(409, 'This is the only active administrator. Promote someone else first.');
    }

    const map = {
      firstName: 'first_name',
      lastName: 'last_name',
      email: 'email',
      phone: 'phone',
      role: 'role',
      status: 'status',
      hireDate: 'hire_date',
      licenseNumber: 'license_number',
      licenseType: 'license_type',
      licenseExpiresOn: 'license_expires_on',
      emergencyContactName: 'emergency_contact_name',
      emergencyContactPhone: 'emergency_contact_phone',
      emergencyContactRelation: 'emergency_contact_relation',
      defaultSiteId: 'default_site_id',
      notes: 'notes',
      employeeCode: 'employee_code',
      employmentType: 'employment_type',
      payType: 'pay_type',
      overtimeMultiplier: 'overtime_multiplier',
      businessName: 'business_name',
      taxIdLast4: 'tax_id_last4',
      insuranceExpiresOn: 'insurance_expires_on',
      addressLine1: 'address_line1',
      addressLine2: 'address_line2',
      city: 'city',
      state: 'state',
      postalCode: 'postal_code',
      uniformSize: 'uniform_size',
    };

    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(map)) {
      if (body[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(body[key] === '' ? null : body[key]);
      }
    }

    // Money arrives in dollars and is stored in whole cents.
    for (const [key, column] of Object.entries({
      payRate: 'pay_rate_cents',
      salary: 'salary_cents',
      billRate: 'bill_rate_cents',
    })) {
      if (body[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(body[key] == null ? null : Math.round(body[key] * 100));
      }
    }

    for (const [key, column] of Object.entries({
      exempt: 'exempt',
      w9OnFile: 'w9_on_file',
      contractorAgreementOnFile: 'contractor_agreement_on_file',
    })) {
      if (body[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(body[key] ? 1 : 0);
      }
    }
    if (!sets.length) return res.json({ employee: publicUser(user) });

    sets.push(`updated_at = datetime('now')`);
    params.push(user.id);
    (await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params));
    await recordPayHistory(user.id, { changedBy: req.user.id, reason: 'Changed on the employee record' });

    await audit(req.user.id, 'employee.updated', 'user', user.id, Object.keys(body), req.ip);
    res.json({ employee: publicUser((await db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id))) });
  })
);

/** Issue a fresh PIN. Shown once, and the officer must change it at next sign-in. */
adminRouter.post(
  '/employees/:id/reset-pin',
  onlyAdmin,
  wrap(async (req, res) => {
    const user = (await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id));
    if (!user) throw new HttpError(404, 'Employee not found.');

    if (demoInstance) {
      throw new HttpError(403, 'PINs cannot be reset on the demo site, so everyone can keep using the published ones.');
    }
    const length = Number(req.body?.length) === 6 ? 6 : 4;
    const pin = generatePin(length);
    const { hash, salt } = hashPin(pin);

    (await db.prepare(
      `UPDATE users
       SET pin_hash = ?, pin_salt = ?, pin_set_at = datetime('now'),
           must_change_pin = 1, failed_attempts = 0, locked_until = NULL,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(hash, salt, user.id));

    await audit(req.user.id, 'employee.pin_reset', 'user', user.id, null, req.ip);
    res.json({
      employeeCode: user.employee_code,
      pin,
      note: 'Share this with the officer now. They will be asked to choose their own PIN when they sign in.',
    });
  })
);

adminRouter.post(
  '/employees/:id/unlock',
  wrap(async (req, res) => {
    (await db.prepare(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?`).run(req.params.id));
    await audit(req.user.id, 'employee.unlocked', 'user', Number(req.params.id), null, req.ip);
    res.json({ ok: true });
  })
);

/* ================================================================ schedule === */

/**
 * Who could work this shift, best first.
 *
 * Every active officer is judged with the same shared rule claims and swaps
 * use - licence for an armed post, overlaps, approved leave, stated
 * availability - and then ranked by what a scheduler weighs: eligible before
 * blocked, no overtime before overtime, people who know the post before
 * strangers, then whoever has the fewest hours that week. Queries are made
 * once for everybody, not once per officer.
 */
adminRouter.get(
  '/shifts/candidates',
  wrap(async (req, res) => {
    const postId = Number(req.query.postId);
    const startsAt = new Date(String(req.query.startsAt || ''));
    const endsAt = new Date(String(req.query.endsAt || ''));
    const excludeShiftId = Number(req.query.excludeShiftId) || 0;
    if (!Number.isInteger(postId) || postId <= 0) throw new HttpError(422, 'Choose a post.');
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      throw new HttpError(422, 'Give a start and an end, with the end after the start.');
    }
    if (endsAt - startsAt > 24 * 3600000) throw new HttpError(422, 'A shift is at most 24 hours.');

    const post = await db
      .prepare(`SELECT p.*, s.latitude AS site_lat, s.longitude AS site_lng FROM posts p JOIN sites s ON s.id = p.site_id WHERE p.id = ?`)
      .get(postId);
    if (!post) throw new HttpError(404, 'Post not found.');

    const people = await db
      .prepare(
        `SELECT u.*, s.name AS home_site, s.latitude AS home_lat, s.longitude AS home_lng
         FROM users u LEFT JOIN sites s ON s.id = u.default_site_id
         WHERE u.status = 'active' AND u.role IN ('officer','supervisor')`
      )
      .all();

    const byUser = (rows) => groupBy(rows, 'user_id');
    const certs = byUser(await db.prepare(`SELECT user_id, type, expires_on FROM certifications`).all());
    const overlaps = byUser(
      await db
        .prepare(
          `SELECT id, user_id FROM shifts
           WHERE user_id IS NOT NULL AND id != ? AND status != 'cancelled'
             AND starts_at < ? AND ends_at > ?`
        )
        .all(excludeShiftId, toSql(endsAt), toSql(startsAt))
    );
    const day = `${startsAt.getFullYear()}-${String(startsAt.getMonth() + 1).padStart(2, '0')}-${String(startsAt.getDate()).padStart(2, '0')}`;
    const leave = byUser(
      await db
        .prepare(
          `SELECT id, user_id FROM time_off_requests
           WHERE status = 'approved' AND starts_on <= ? AND ends_on >= ?`
        )
        .all(day, day)
    );
    const availability = new Map(
      (await db.prepare(`SELECT * FROM availability WHERE weekday = ?`).all(startsAt.getDay())).map((a) => [a.user_id, a])
    );

    // Hours already on the roster in this payroll week, to project overtime.
    const weekStart = parseDay(payrollWeekOf(startsAt));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const rostered = new Map(
      (
        await db
          .prepare(
            `SELECT user_id, SUM(EXTRACT(EPOCH FROM (ends_at - starts_at)) / 60) AS minutes
             FROM shifts
             WHERE user_id IS NOT NULL AND id != ? AND status != 'cancelled'
               AND starts_at >= ? AND starts_at < ?
             GROUP BY user_id`
          )
          .all(excludeShiftId, toSql(weekStart), toSql(weekEnd))
      ).map((r) => [r.user_id, Number(r.minutes) || 0])
    );

    // Who has actually stood this post lately knows the post orders.
    const familiarity = new Map(
      (
        await db
          .prepare(
            `SELECT user_id, COUNT(*) AS n FROM time_entries
             WHERE post_id = ? AND clock_in_at >= ? GROUP BY user_id`
          )
          .all(postId, toSql(new Date(Date.now() - 60 * 86400000)))
      ).map((r) => [r.user_id, Number(r.n)])
    );

    const shiftMinutes = Math.round((endsAt - startsAt) / 60000);
    const threshold = RULES.overtimeWeeklyHours * 60;

    const candidates = people.map((u) => {
      const reasons = shiftEligibility({
        post,
        officer: u,
        certifications: certs.get(u.id) || [],
        conflicts: overlaps.get(u.id) || [],
        timeOff: leave.get(u.id) || [],
        availability: availability.get(u.id) || null,
      });
      const before = rostered.get(u.id) || 0;
      const after = before + shiftMinutes;
      const earnsOvertime = u.employment_type === 'w2' && !u.exempt && u.pay_type === 'hourly';
      const overtimeMinutes = earnsOvertime ? Math.max(0, after - Math.max(threshold, before)) : 0;
      const rate = u.pay_type === 'hourly' ? u.pay_rate_cents : null;
      const costCents =
        u.pay_type === 'per_shift'
          ? u.pay_rate_cents
          : rate != null
            ? Math.round((shiftMinutes / 60) * rate + (overtimeMinutes / 60) * rate * ((u.overtime_multiplier || 1.5) - 1))
            : null;
      const billCents = post.bill_rate_cents != null ? Math.round((shiftMinutes / 60) * post.bill_rate_cents) : null;
      const distance =
        u.home_lat != null && post.latitude != null ? distanceMeters(u.home_lat, u.home_lng, post.latitude, post.longitude) : null;
      return {
        user_id: u.id,
        name: `${u.first_name} ${u.last_name}`,
        employee_code: u.employee_code,
        role: u.role,
        employment_type: u.employment_type,
        license_type: u.license_type,
        home_site: u.home_site,
        home_site_match: u.default_site_id === post.site_id,
        home_distance_km: distance != null ? Math.round(distance / 100) / 10 : null,
        eligible: !blocksAssignment(reasons),
        reasons,
        week_hours_before: toHours(before),
        week_hours_after: toHours(after),
        overtime_hours: toHours(overtimeMinutes),
        times_at_post: familiarity.get(u.id) || 0,
        cost: costCents != null ? costCents / 100 : null,
        margin_percent: billCents && costCents != null ? Math.round(((billCents - costCents) / billCents) * 1000) / 10 : null,
      };
    });

    candidates.sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        Number(a.overtime_hours > 0) - Number(b.overtime_hours > 0) ||
        a.reasons.length - b.reasons.length ||
        Number(b.times_at_post > 0) - Number(a.times_at_post > 0) ||
        Number(b.home_site_match) - Number(a.home_site_match) ||
        (a.home_distance_km ?? 9999) - (b.home_distance_km ?? 9999) ||
        a.week_hours_before - b.week_hours_before
    );

    res.json({
      post: { id: post.id, name: post.name, armed: Boolean(post.armed), bill_rate: post.bill_rate_cents != null ? post.bill_rate_cents / 100 : null },
      shift_hours: toHours(shiftMinutes),
      candidates,
    });
  })
);

adminRouter.get(
  '/shifts',
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 14 * 86400000);

    const rows = (await db
      .prepare(
        `SELECT sh.*, p.name AS post_name, p.post_code, s.name AS site_name, s.id AS site_id,
                u.first_name || ' ' || u.last_name AS officer, u.employee_code,
                te.id AS entry_id, te.clock_in_at, te.clock_out_at, te.minutes_worked, te.late_minutes
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         LEFT JOIN users u ON u.id = sh.user_id
         LEFT JOIN time_entries te ON te.shift_id = sh.id
         WHERE sh.starts_at BETWEEN ? AND ?
         ${req.query.siteId ? 'AND s.id = ?' : ''}
         ${req.query.userId ? 'AND sh.user_id = ?' : ''}
         ORDER BY sh.starts_at`
      )
      .all(
        toSql(from),
        toSql(to),
        ...(req.query.siteId ? [Number(req.query.siteId)] : []),
        ...(req.query.userId ? [Number(req.query.userId)] : [])
      ));

    res.json({
      shifts: rows.map((s) => isoFields(s, ['starts_at', 'ends_at', 'clock_in_at', 'clock_out_at', 'created_at'])),
    });
  })
);

// The fields on their own, so an edit can take any subset of them: a zod
// schema wrapped in refine() has no partial(), which is what broke every
// shift edit with a 500.
const shiftFields = z
  .object({
    userId: z.number().int().positive().nullable().optional(),
    postId: z.number().int().positive(),
    startsAt: z.string().min(1),
    endsAt: z.string().min(1),
    notes: z.string().max(1000).optional(),
    /** Assign despite a blocking eligibility problem; needs a written reason. */
    override: z.boolean().optional(),
    overrideReason: z.string().trim().max(500).optional(),
  });

const shiftSchema = shiftFields
  .refine((d) => new Date(d.endsAt) > new Date(d.startsAt), {
    message: 'The shift must end after it starts.',
    path: ['endsAt'],
  });

/** Reject a shift that overlaps one the officer already has. */
async function assertNoOverlap({ userId, startsAt, endsAt, excludeShiftId }) {
  if (!userId) return;
  const clash = (await db
    .prepare(
      `SELECT sh.id, sh.starts_at, sh.ends_at, p.name AS post_name
       FROM shifts sh JOIN posts p ON p.id = sh.post_id
       WHERE sh.user_id = ? AND sh.status != 'cancelled'
         AND sh.starts_at < ? AND sh.ends_at > ?
         ${excludeShiftId ? 'AND sh.id != ?' : ''}
       LIMIT 1`
    )
    .get(userId, toSql(new Date(endsAt)), toSql(new Date(startsAt)), ...(excludeShiftId ? [excludeShiftId] : [])));

  if (clash) {
    throw new HttpError(409, `That officer already has a shift at ${clash.post_name} covering this time.`, {
      conflictingShiftId: clash.id,
    });
  }
}

/**
 * The same eligibility rule claims and swaps use, applied to a supervisor's
 * direct assignment. Overlaps are left to assertNoOverlap, which says which
 * shift clashes. Anything else that blocks - no Class G for an armed post,
 * approved leave, an expired licence - is refused unless the supervisor
 * overrides with a reason, which goes on the audit log with the problems.
 * Advisory reasons (outside stated availability) come back as warnings.
 */
async function checkAssignment(req, { userId, postId, startsAt, endsAt, excludeShiftId, override, overrideReason }) {
  if (!userId) return { warnings: [] };
  const reasons = (
    await checkEligibility(userId, {
      id: excludeShiftId || 0,
      post_id: postId,
      starts_at: toSql(new Date(startsAt)),
      ends_at: toSql(new Date(endsAt)),
    })
  ).filter((r) => r.code !== 'conflict');
  const blocking = reasons.filter((r) => !r.advisory);
  if (blocking.length) {
    if (!override) {
      throw new HttpError(409, blocking.map((r) => r.message).join(' '), { code: 'ineligible', reasons: blocking });
    }
    if (!overrideReason || overrideReason.length < 5) {
      throw new HttpError(422, 'Say why this officer is being assigned anyway.', [
        { field: 'overrideReason', message: 'Required when overriding.' },
      ]);
    }
    await audit(req.user.id, 'shift.eligibility_overridden', 'user', userId, {
      reasons: blocking.map((r) => r.code),
      reason: overrideReason,
    }, req.ip);
  }
  return { warnings: reasons.filter((r) => r.advisory) };
}

/** Tell an officer their roster changed. Fire and forget. */
async function notifyShift(userId, kind, shiftLike) {
  if (!userId) return;
  const post = await db
    .prepare(`SELECT p.name, s.name AS site_name FROM posts p JOIN sites s ON s.id = p.site_id WHERE p.id = ?`)
    .get(shiftLike.post_id);
  const when = new Date(sqlToIso(shiftLike.starts_at)).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const title = { added: 'New shift', changed: 'Shift changed', removed: 'Shift removed' }[kind];
  pushAsync([userId], {
    title,
    body: `${when} - ${post?.name || 'post'}, ${post?.site_name || ''}`.trim(),
    data: { type: 'schedule', kind },
  });
}

adminRouter.post(
  '/shifts',
  wrap(async (req, res) => {
    const body = parse(shiftSchema, req.body);
    await assertNoOverlap(body);
    const { warnings } = await checkAssignment(req, body);

    const info = (await db
      .prepare(
        `INSERT INTO shifts (user_id, post_id, starts_at, ends_at, notes, created_by)
         VALUES (?,?,?,?,?,?)`
      )
      .run(
        body.userId ?? null,
        body.postId,
        toSql(new Date(body.startsAt)),
        toSql(new Date(body.endsAt)),
        body.notes ?? null,
        req.user.id
      ));

    await audit(req.user.id, 'shift.created', 'shift', Number(info.lastInsertRowid), null, req.ip);
    const created = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(info.lastInsertRowid);
    await notifyShift(created.user_id, 'added', created);
    res.status(201).json({ shift: isoFields(created, ['starts_at', 'ends_at']), warnings });
  })
);

/** Repeat a shift pattern across a date range - how a week's roster is actually built. */
const bulkSchema = z.object({
  userId: z.number().int().positive().nullable().optional(),
  postId: z.number().int().positive(),
  startDate: z.string(),
  endDate: z.string(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.'),
  /** 0 = Sunday. */
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one day.'),
  skipConflicts: z.boolean().default(true),
});

adminRouter.post(
  '/shifts/bulk',
  wrap(async (req, res) => {
    const body = parse(bulkSchema, req.body);
    const start = new Date(body.startDate);
    const end = new Date(body.endDate);
    if (end < start) throw new HttpError(422, 'The end date is before the start date.');
    if ((end - start) / 86400000 > 180) throw new HttpError(422, 'Generate at most six months at a time.');

    const [sh, sm] = body.startTime.split(':').map(Number);
    const [eh, em] = body.endTime.split(':').map(Number);
    const created = [];
    const skipped = [];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (!body.weekdays.includes(d.getDay())) continue;

      const startsAt = new Date(d);
      startsAt.setHours(sh, sm, 0, 0);
      const endsAt = new Date(d);
      endsAt.setHours(eh, em, 0, 0);
      // An end time earlier than the start means the shift runs overnight.
      if (endsAt <= startsAt) endsAt.setDate(endsAt.getDate() + 1);

      try {
        await assertNoOverlap({ userId: body.userId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
        await checkAssignment(req, { userId: body.userId, postId: body.postId, startsAt, endsAt });
      } catch (err) {
        if (body.skipConflicts) {
          skipped.push({ date: startsAt.toISOString().slice(0, 10), reason: err.message });
          continue;
        }
        throw err;
      }

      const info = (await db
        .prepare(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at, created_by) VALUES (?,?,?,?,?)`)
        .run(body.userId ?? null, body.postId, toSql(startsAt), toSql(endsAt), req.user.id));
      created.push(Number(info.lastInsertRowid));
    }

    await audit(req.user.id, 'shift.bulk_created', 'shift', null, { count: created.length }, req.ip);
    if (body.userId && created.length) {
      pushAsync([body.userId], {
        title: 'New shifts',
        body: `${created.length} shift${created.length === 1 ? '' : 's'} added to your schedule.`,
        data: { type: 'schedule', kind: 'added' },
      });
    }
    res.status(201).json({ created: created.length, skipped });
  })
);

/**
 * Roll a week's roster forward. Each shift lands on the same weekday and wall
 * clock time in the target week; an officer who is already booked then keeps
 * the shift open rather than being double-booked.
 */
const copyWeekSchema = z.object({
  fromWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
  toWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
  siteId: z.number().int().positive().nullable().optional(),
  keepOfficers: z.boolean().default(true),
});

adminRouter.post(
  '/shifts/copy-week',
  wrap(async (req, res) => {
    const body = parse(copyWeekSchema, req.body);
    const from = parseDay(body.fromWeekStart);
    const to = parseDay(body.toWeekStart);
    if (!from || !to) throw new HttpError(422, 'Use dates like 2026-09-28.');
    const dayShift = Math.round((to - from) / 86400000);
    if (dayShift === 0) throw new HttpError(422, 'Pick a different week to copy into.');
    const fromEnd = new Date(from);
    fromEnd.setDate(fromEnd.getDate() + 7);

    const source = await db
      .prepare(
        `SELECT sh.*, p.site_id FROM shifts sh JOIN posts p ON p.id = sh.post_id
         WHERE sh.starts_at >= ? AND sh.starts_at < ? AND sh.status != 'cancelled'
         ${body.siteId ? 'AND p.site_id = ?' : ''}
         ORDER BY sh.starts_at`
      )
      .all(toSql(from), toSql(fromEnd), ...(body.siteId ? [body.siteId] : []));

    const moved = (value) => {
      // setDate keeps the wall-clock time across a daylight saving change.
      const d = new Date(sqlToIso(value));
      d.setDate(d.getDate() + dayShift);
      return d;
    };

    // What the target week already has, per post and start time. A post can
    // legitimately carry two officers at once, so this is a count: copying
    // tops each slot up to the source's number and never past it, which also
    // makes running the same copy twice a no-op.
    const toEnd = new Date(to);
    toEnd.setDate(toEnd.getDate() + 7);
    const existing = new Map();
    for (const t of await db
      .prepare(`SELECT post_id, starts_at FROM shifts WHERE starts_at >= ? AND starts_at < ? AND status != 'cancelled'`)
      .all(toSql(to), toSql(toEnd))) {
      const key = `${t.post_id}|${new Date(sqlToIso(t.starts_at)).getTime()}`;
      existing.set(key, (existing.get(key) || 0) + 1);
    }

    let created = 0;
    let opened = 0;
    const skipped = [];
    const notified = new Map();
    for (const s of source) {
      const startsAt = moved(s.starts_at);
      const endsAt = moved(s.ends_at);

      const key = `${s.post_id}|${startsAt.getTime()}`;
      if ((existing.get(key) || 0) > 0) {
        existing.set(key, existing.get(key) - 1);
        skipped.push({ shiftId: s.id, reason: 'That post is already scheduled at that time.' });
        continue;
      }

      let userId = body.keepOfficers ? s.user_id : null;
      if (userId) {
        // A clash, approved leave or a lapsed licence leaves the copy open
        // for someone else rather than booking a person who cannot work it.
        try {
          await assertNoOverlap({ userId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
          await checkAssignment(req, { userId, postId: s.post_id, startsAt, endsAt });
        } catch {
          userId = null;
          opened += 1;
        }
      }
      if (userId) notified.set(userId, (notified.get(userId) || 0) + 1);

      await db
        .prepare(
          `INSERT INTO shifts (user_id, post_id, starts_at, ends_at, notes, bill_rate_cents, is_open, created_by)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(userId, s.post_id, toSql(startsAt), toSql(endsAt), s.notes, s.bill_rate_cents, !userId, req.user.id);
      created += 1;
    }

    await audit(req.user.id, 'shift.week_copied', 'shift', null, { ...body, created, opened }, req.ip);
    for (const [userId, count] of notified) {
      pushAsync([userId], {
        title: 'Next roster is out',
        body: `${count} shift${count === 1 ? '' : 's'} added for the week of ${body.toWeekStart}.`,
        data: { type: 'schedule', kind: 'added' },
      });
    }
    res.status(201).json({ created, opened, skipped });
  })
);

adminRouter.patch(
  '/shifts/:id',
  wrap(async (req, res) => {
    const body = parse(shiftFields.partial(), req.body);
    const shift = (await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(req.params.id));
    if (!shift) throw new HttpError(404, 'Shift not found.');

    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date(sqlToIso(shift.starts_at));
    const endsAt = body.endsAt ? new Date(body.endsAt) : new Date(sqlToIso(shift.ends_at));
    const userId = body.userId !== undefined ? body.userId : shift.user_id;

    if (endsAt <= startsAt) throw new HttpError(422, 'The shift must end after it starts.');
    await assertNoOverlap({ userId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), excludeShiftId: shift.id });

    const postId = body.postId ?? shift.post_id;
    const moved =
      postId !== shift.post_id ||
      startsAt.getTime() !== new Date(sqlToIso(shift.starts_at)).getTime() ||
      endsAt.getTime() !== new Date(sqlToIso(shift.ends_at)).getTime();
    const reassigned = (userId ?? null) !== (shift.user_id ?? null);

    // Only re-judged when who, where or when changes: editing the notes on a
    // shift somebody already holds is not a new assignment.
    const { warnings } =
      moved || reassigned
        ? await checkAssignment(req, { ...body, userId, postId, startsAt, endsAt, excludeShiftId: shift.id })
        : { warnings: [] };

    (await db.prepare(
      `UPDATE shifts SET user_id = ?, post_id = ?, starts_at = ?, ends_at = ?, notes = ?, status = ?, is_open = ? WHERE id = ?`
    ).run(
      userId ?? null,
      postId,
      toSql(startsAt),
      toSql(endsAt),
      body.notes !== undefined ? body.notes : shift.notes,
      req.body.status || shift.status,
      !userId,
      shift.id
    ));

    await audit(req.user.id, 'shift.updated', 'shift', shift.id, null, req.ip);
    const updated = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shift.id);
    if (reassigned) {
      await notifyShift(shift.user_id, 'removed', shift);
      await notifyShift(updated.user_id, 'added', updated);
    } else if (moved) {
      await notifyShift(updated.user_id, 'changed', updated);
    }
    res.json({ shift: isoFields(updated, ['starts_at', 'ends_at']), warnings });
  })
);

adminRouter.delete(
  '/shifts/:id',
  wrap(async (req, res) => {
    const shift = (await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(req.params.id));
    if (!shift) throw new HttpError(404, 'Shift not found.');
    // Keep any shift that has already been worked; cancel it instead of deleting.
    const worked = (await db.prepare(`SELECT 1 FROM time_entries WHERE shift_id = ?`).get(shift.id));
    const upcoming = new Date(sqlToIso(shift.ends_at)) > new Date();
    if (worked) {
      (await db.prepare(`UPDATE shifts SET status = 'cancelled' WHERE id = ?`).run(shift.id));
      await audit(req.user.id, 'shift.cancelled', 'shift', shift.id, null, req.ip);
      if (upcoming) await notifyShift(shift.user_id, 'removed', shift);
      return res.json({ ok: true, cancelled: true });
    }
    (await db.prepare(`DELETE FROM shifts WHERE id = ?`).run(shift.id));
    await audit(req.user.id, 'shift.deleted', 'shift', shift.id, null, req.ip);
    if (upcoming) await notifyShift(shift.user_id, 'removed', shift);
    res.json({ ok: true, deleted: true });
  })
);

/* ============================================================== timesheets === */

adminRouter.get(
  '/timesheets',
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 14 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const rows = (await db
      .prepare(
        `SELECT u.id AS user_id, u.employee_code, u.first_name || ' ' || u.last_name AS officer,
                u.role, u.pay_rate_cents, u.bill_rate_cents, u.salary_cents,
                u.employment_type, u.pay_type, u.exempt, u.overtime_multiplier,
                u.business_name, u.w9_on_file,
                COUNT(te.id) AS shifts,
                COALESCE(SUM(te.minutes_worked),0) AS gross_minutes,
                COALESCE(SUM(te.unpaid_break_minutes),0) AS break_minutes,
                COALESCE(SUM(CASE WHEN te.late_minutes > 0 THEN 1 ELSE 0 END),0) AS late_shifts,
                COALESCE(SUM(CASE WHEN te.auto_closed THEN 1 ELSE 0 END),0) AS auto_closed,
                COALESCE(SUM(CASE WHEN te.clock_in_geofence = 'outside' THEN 1 ELSE 0 END),0) AS geofence_issues
         FROM users u
         LEFT JOIN time_entries te
           ON te.user_id = u.id AND te.clock_in_at BETWEEN ? AND ?
         WHERE u.status IN ('active','on_leave')
         GROUP BY u.id
         ORDER BY gross_minutes DESC`
      )
      .all(toSql(from), toSql(to)));

    // Pay and billing come from the shared pricing, so this screen, the
    // reports and invoice cost agree: each hour at the rate in effect that
    // day, overtime decided payroll week by payroll week, and billing at the
    // shift's rate, else the post's, else the officer's.
    const priced = groupBy(await loadPricedEntries({ from, to }), 'user_id');

    const pricedRows = rows.map((r) => {
      const list = priced.get(r.user_id) || [];
      if (!list.length) {
        return {
          ...r,
          minutes: 0,
          hours: 0,
          break_hours: toHours(r.break_minutes),
          regular_hours: 0,
          overtime_hours: 0,
          earns_overtime: r.employment_type === 'w2' && !r.exempt && r.pay_type === 'hourly',
          estimated_pay: null,
          estimated_bill: null,
          margin: null,
          margin_percent: null,
        };
      }
      const pay = personPay(list);
      const billable = list.filter((e) => e.bill_rate_cents != null);
      const billCents = billable.length ? billable.reduce((n, e) => n + e.billed_cents, 0) : null;
      const marginCents = billCents != null && pay.payCents != null ? billCents - pay.payCents : null;
      return {
        ...r,
        minutes: pay.minutes,
        hours: toHours(pay.minutes),
        break_hours: toHours(r.break_minutes),
        regular_hours: toHours(pay.regularMinutes),
        overtime_hours: toHours(pay.overtimeMinutes),
        earns_overtime: pay.earnsOvertime,
        estimated_pay: pay.payCents != null ? pay.payCents / 100 : null,
        estimated_bill: billCents != null ? billCents / 100 : null,
        margin: marginCents != null ? marginCents / 100 : null,
        margin_percent: marginCents != null && billCents > 0 ? Math.round((marginCents / billCents) * 1000) / 10 : null,
      };
    });
    pricedRows.sort((a, b) => b.minutes - a.minutes);
    // Totals split by classification, which is what the bookkeeper needs.
    const totalsFor = (type) => {
      const set = pricedRows.filter((r) => r.employment_type === type);
      return {
        people: set.filter((r) => r.shifts > 0).length,
        hours: Math.round(set.reduce((n, r) => n + r.hours, 0) * 100) / 100,
        pay: Math.round(set.reduce((n, r) => n + (r.estimated_pay || 0), 0) * 100) / 100,
      };
    };

    res.json({
      range: { from: from.toISOString(), to: to.toISOString() },
      rows: pricedRows,
      totals: {
        w2: totalsFor('w2'),
        contractor: totalsFor('1099'),
        bill: Math.round(pricedRows.reduce((n, r) => n + (r.estimated_bill || 0), 0) * 100) / 100,
        margin: Math.round(pricedRows.reduce((n, r) => n + (r.margin || 0), 0) * 100) / 100,
      },
    });
  })
);

/** Every clock event in a range - the detail behind the timesheet totals. */
adminRouter.get(
  '/time-entries',
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const rows = (await db
      .prepare(
        `SELECT te.*, u.employee_code, u.first_name || ' ' || u.last_name AS officer,
                p.name AS post_name, s.name AS site_name,
                (SELECT COUNT(*) FROM status_checks sc WHERE sc.time_entry_id = te.id AND sc.status = 'missed') AS missed_checks
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.clock_in_at BETWEEN ? AND ?
         ${req.query.userId ? 'AND te.user_id = ?' : ''}
         ORDER BY te.clock_in_at DESC LIMIT 500`
      )
      .all(toSql(from), toSql(to), ...(req.query.userId ? [Number(req.query.userId)] : [])));

    res.json({ entries: rows.map((r) => isoFields(r, ['clock_in_at', 'clock_out_at', 'created_at'])) });
  })
);

/** Correct a bad punch. The original values are preserved for the audit trail. */
const adjustSchema = z.object({
  clockInAt: z.string().optional(),
  clockOutAt: z.string().nullable().optional(),
  reason: z.string().trim().min(5, 'Record why this entry was changed.').max(500),
});

adminRouter.patch(
  '/time-entries/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(adjustSchema, req.body);
    const entry = (await db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(req.params.id));
    if (!entry) throw new HttpError(404, 'Time entry not found.');

    const clockIn = body.clockInAt ? new Date(body.clockInAt) : new Date(sqlToIso(entry.clock_in_at));
    const clockOut =
      body.clockOutAt === undefined
        ? entry.clock_out_at
          ? new Date(sqlToIso(entry.clock_out_at))
          : null
        : body.clockOutAt
          ? new Date(body.clockOutAt)
          : null;

    if (clockOut && clockOut <= clockIn) throw new HttpError(422, 'Clock-out must be after clock-in.');
    // Hours in a closed payroll period are what was paid; moving an entry
    // into one would be the same change by the back door.
    await assertHoursOpen(entry.clock_in_at, 'correct a punch');
    await assertHoursOpen(clockIn, 'correct a punch');

    (await db.prepare(
      `UPDATE time_entries
       SET clock_in_at = ?, clock_out_at = ?, minutes_worked = ?,
           original_clock_in_at = COALESCE(original_clock_in_at, ?),
           original_clock_out_at = COALESCE(original_clock_out_at, ?),
           adjusted_by = ?, adjustment_reason = ?
       WHERE id = ?`
    ).run(
      toSql(clockIn),
      clockOut ? toSql(clockOut) : null,
      clockOut ? minutesBetween(clockIn.toISOString(), clockOut.toISOString()) : null,
      entry.clock_in_at,
      entry.clock_out_at,
      req.user.id,
      body.reason,
      entry.id
    ));

    await audit(req.user.id, 'time_entry.adjusted', 'time_entry', entry.id, { reason: body.reason }, req.ip);
    res.json({ entry: isoFields((await db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(entry.id)), ['clock_in_at', 'clock_out_at']) });
  })
);

/* =================================================================== flags === */

adminRouter.get(
  '/flags',
  wrap(async (req, res) => {
    const resolved = req.query.resolved === 'true';
    const rows = (await db
      .prepare(
        `SELECT f.*, u.employee_code, u.first_name || ' ' || u.last_name AS officer,
                r.first_name || ' ' || r.last_name AS resolved_by_name
         FROM flags f
         JOIN users u ON u.id = f.user_id
         LEFT JOIN users r ON r.id = f.resolved_by
         WHERE f.resolved_at IS ${resolved ? 'NOT' : ''} NULL
         ${req.query.type ? 'AND f.type = ?' : ''}
         ${req.query.userId ? 'AND f.user_id = ?' : ''}
         ORDER BY f.occurred_at DESC LIMIT 300`
      )
      .all(
        ...(req.query.type ? [req.query.type] : []),
        ...(req.query.userId ? [Number(req.query.userId)] : [])
      ));

    res.json({
      flags: rows.map((f) => ({
        ...isoFields(f, ['occurred_at', 'resolved_at', 'created_at']),
        label: FLAG_LABEL[f.type] || f.type,
        // `detail` is a jsonb column, so the driver has already parsed it.
        detail: typeof f.detail === 'string' ? JSON.parse(f.detail) : (f.detail ?? null),
      })),
    });
  })
);

adminRouter.post(
  '/flags/:id/resolve',
  wrap(async (req, res) => {
    const note = String(req.body?.note || '').slice(0, 500);
    if (note.trim().length < 3) throw new HttpError(422, 'Add a short note explaining the outcome.');

    (await db.prepare(
      `UPDATE flags SET resolved_at = datetime('now'), resolved_by = ?, resolution_note = ? WHERE id = ?`
    ).run(req.user.id, note, req.params.id));

    await audit(req.user.id, 'flag.resolved', 'flag', Number(req.params.id), { note }, req.ip);
    res.json({ ok: true });
  })
);

/* ========================================================== sites & posts === */

adminRouter.get(
  '/sites',
  wrap(async (_req, res) => {
    const sites = (await db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM posts p WHERE p.site_id = s.id AND p.active = 1) AS post_count
         FROM sites s ORDER BY s.active DESC, s.name`
      )
      .all());
    const posts = (await db
      .prepare(`SELECT p.*, s.name AS site_name FROM posts p JOIN sites s ON s.id = p.site_id ORDER BY s.name, p.name`)
      .all());
    res.json({ sites, posts });
  })
);

const siteSchema = z.object({
  name: z.string().trim().min(2).max(160),
  clientName: z.string().trim().max(160).optional(),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(4).optional(),
  postalCode: z.string().trim().max(20).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  contactName: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  active: z.boolean().default(true),
});

adminRouter.post(
  '/sites',
  onlyAdmin,
  wrap(async (req, res) => {
    const b = parse(siteSchema, req.body);
    const info = (await db
      .prepare(
        `INSERT INTO sites (name, client_name, address, city, state, postal_code, latitude, longitude, contact_name, contact_phone, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(b.name, b.clientName ?? null, b.address ?? null, b.city ?? null, b.state ?? 'FL',
           b.postalCode ?? null, b.latitude ?? null, b.longitude ?? null,
           b.contactName ?? null, b.contactPhone ?? null, b.active ? 1 : 0));
    res.status(201).json({ site: (await db.prepare(`SELECT * FROM sites WHERE id = ?`).get(info.lastInsertRowid)) });
  })
);

const postSchema = z.object({
  siteId: z.number().int().positive(),
  name: z.string().trim().min(2).max(160),
  postCode: z.string().trim().max(40).optional(),
  instructions: z.string().max(5000).optional(),
  address: z.string().trim().max(300).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  geofenceRadiusM: z.number().int().min(25).max(5000).default(150),
  checkInIntervalMin: z.number().int().min(0).max(480).default(60),
  requiresGps: z.boolean().default(true),
  armed: z.boolean().default(false),
  active: z.boolean().default(true),
});

adminRouter.post(
  '/posts',
  onlyAdmin,
  wrap(async (req, res) => {
    const b = parse(postSchema, req.body);
    const info = (await db
      .prepare(
        `INSERT INTO posts (site_id, name, post_code, instructions, address, latitude, longitude,
                            geofence_radius_m, check_in_interval_min, requires_gps, armed, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(b.siteId, b.name, b.postCode ?? null, b.instructions ?? null, b.address ?? null,
           b.latitude ?? null, b.longitude ?? null,
           b.geofenceRadiusM, b.checkInIntervalMin, b.requiresGps ? 1 : 0, b.armed ? 1 : 0, b.active ? 1 : 0));
    res.status(201).json({ post: (await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(info.lastInsertRowid)) });
  })
);

adminRouter.patch(
  '/posts/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const b = parse(postSchema.partial(), req.body);
    const post = (await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(req.params.id));
    if (!post) throw new HttpError(404, 'Post not found.');

    const map = {
      name: 'name', postCode: 'post_code', instructions: 'instructions', address: 'address',
      latitude: 'latitude', longitude: 'longitude', geofenceRadiusM: 'geofence_radius_m',
      checkInIntervalMin: 'check_in_interval_min', siteId: 'site_id',
    };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) { sets.push(`${col} = ?`); params.push(b[k]); }
    }
    for (const [k, col] of Object.entries({ requiresGps: 'requires_gps', armed: 'armed', active: 'active' })) {
      if (b[k] !== undefined) { sets.push(`${col} = ?`); params.push(b[k] ? 1 : 0); }
    }
    if (sets.length) {
      params.push(post.id);
      (await db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...params));
    }
    res.json({ post: (await db.prepare(`SELECT * FROM posts WHERE id = ?`).get(post.id)) });
  })
);

/* =================================================================== tours === */

adminRouter.get(
  '/tours',
  wrap(async (_req, res) => {
    const tours = (await db
      .prepare(
        `SELECT t.*, s.name AS site_name,
                (SELECT COUNT(*) FROM checkpoints c WHERE c.tour_id = t.id) AS checkpoint_count
         FROM tours t JOIN sites s ON s.id = t.site_id ORDER BY s.name, t.name`
      )
      .all());
    res.json({ tours });
  })
);

adminRouter.get(
  '/tours/:id',
  wrap(async (req, res) => {
    const tour = (await db.prepare(`SELECT * FROM tours WHERE id = ?`).get(req.params.id));
    if (!tour) throw new HttpError(404, 'Tour not found.');
    const checkpoints = (await db.prepare(`SELECT * FROM checkpoints WHERE tour_id = ? ORDER BY sequence, id`).all(tour.id));
    const tasks = (await db
      .prepare(
        `SELECT ct.* FROM checkpoint_tasks ct
         JOIN checkpoints c ON c.id = ct.checkpoint_id
         WHERE c.tour_id = ? ORDER BY ct.sequence, ct.id`
      )
      .all(tour.id));
    res.json({
      tour,
      checkpoints: checkpoints.map((c) => ({ ...c, tasks: tasks.filter((t) => t.checkpoint_id === c.id) })),
    });
  })
);

const tourSchema = z.object({
  siteId: z.number().int().positive(),
  name: z.string().trim().min(2).max(160),
  description: z.string().max(2000).optional(),
  expectedMinutes: z.number().int().min(1).max(480).nullable().optional(),
  checkpoints: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(160),
        instructions: z.string().max(2000).optional(),
        nfcTagId: z.string().trim().max(120).optional(),
        qrCode: z.string().trim().max(120).optional(),
        latitude: z.number().nullable().optional(),
        longitude: z.number().nullable().optional(),
        required: z.boolean().default(true),
        tasks: z.array(z.object({
          label: z.string().trim().min(1).max(300),
          required: z.boolean().default(true),
        })).default([]),
      })
    )
    .default([]),
});

adminRouter.post(
  '/tours',
  onlyAdmin,
  wrap(async (req, res) => {
    const b = parse(tourSchema, req.body);
    const tourId = await db.transaction(async () => {
      const info = (await db
        .prepare(`INSERT INTO tours (site_id, name, description, expected_minutes) VALUES (?,?,?,?)`)
        .run(b.siteId, b.name, b.description ?? null, b.expectedMinutes ?? null));
      const id = Number(info.lastInsertRowid);

      // Sequential: an async callback handed to forEach would leave the
      // transaction to commit before the inserts had run.
      for (const [i, cp] of b.checkpoints.entries()) {
        const cpInfo = await db
          .prepare(
            `INSERT INTO checkpoints (tour_id, name, sequence, nfc_tag_id, qr_code, latitude, longitude, instructions, required)
             VALUES (?,?,?,?,?,?,?,?,?)`
          )
          .run(id, cp.name, i, cp.nfcTagId ?? null, cp.qrCode ?? null,
               cp.latitude ?? null, cp.longitude ?? null, cp.instructions ?? null, cp.required ? 1 : 0);

        for (const [ti, task] of cp.tasks.entries()) {
          await db
            .prepare(`INSERT INTO checkpoint_tasks (checkpoint_id, label, sequence, required) VALUES (?,?,?,?)`)
            .run(Number(cpInfo.lastInsertRowid), task.label, ti, task.required ? 1 : 0);
        }
      }
      return id;
    })();

    await audit(req.user.id, 'tour.created', 'tour', tourId, { name: b.name }, req.ip);
    res.status(201).json({ tourId });
  })
);

/** Completed walks, for proof-of-service reporting to the client. */
adminRouter.get(
  '/tour-runs',
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT tr.*, t.name AS tour_name, s.name AS site_name,
                u.first_name || ' ' || u.last_name AS officer,
                (SELECT COUNT(*) FROM tour_run_checkpoints x WHERE x.tour_run_id = tr.id) AS total,
                (SELECT COUNT(*) FROM tour_run_checkpoints x WHERE x.tour_run_id = tr.id AND x.status = 'done') AS done,
                (SELECT COUNT(*) FROM tour_run_checkpoints x WHERE x.tour_run_id = tr.id AND x.status = 'skipped') AS skipped
         FROM tour_runs tr
         JOIN tours t ON t.id = tr.tour_id
         JOIN sites s ON s.id = t.site_id
         JOIN users u ON u.id = tr.user_id
         WHERE tr.started_at >= ?
         ORDER BY tr.started_at DESC LIMIT 200`
      )
      .all(toSql(req.query.from ? new Date(req.query.from) : new Date(Date.now() - 14 * 86400000))));
    res.json({ runs: rows.map((r) => isoFields(r, ['started_at', 'completed_at'])) });
  })
);

/* =============================================================== audit log === */

adminRouter.get(
  '/audit',
  onlyAdmin,
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT a.*, u.employee_code, u.first_name || ' ' || u.last_name AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         ${req.query.action ? 'WHERE a.action LIKE ?' : ''}
         ORDER BY a.created_at DESC LIMIT 300`
      )
      .all(...(req.query.action ? [`${req.query.action}%`] : [])));
    res.json({ entries: rows.map((r) => isoFields(r, ['created_at'])) });
  })
);

/** CSV export for payroll. */
adminRouter.get(
  '/export/timesheets.csv',
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 14 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const rows = (await db
      .prepare(
        `SELECT u.employee_code, u.last_name, u.first_name, p.name AS post, s.name AS site,
                te.clock_in_at, te.clock_out_at, te.minutes_worked, te.late_minutes,
                te.clock_in_geofence, te.auto_closed, te.adjustment_reason
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.clock_in_at BETWEEN ? AND ?
         ORDER BY u.last_name, te.clock_in_at`
      )
      .all(toSql(from), toSql(to)));

    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'employee_code', 'last_name', 'first_name', 'site', 'post',
      'clock_in', 'clock_out', 'hours', 'late_minutes', 'geofence', 'auto_closed', 'adjustment_reason',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.employee_code, r.last_name, r.first_name, r.site, r.post,
        sqlToIso(r.clock_in_at), sqlToIso(r.clock_out_at), toHours(r.minutes_worked),
        r.late_minutes, r.clock_in_geofence, r.auto_closed, r.adjustment_reason,
      ].map(esc).join(','));
    }

    await audit(req.user.id, 'export.timesheets', null, null, { rows: rows.length }, req.ip);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usc-timesheets-${from.toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  })
);

/* ================================================================== email === */

/**
 * The outbox.
 *
 * Every message the system decided to send is recorded whether or not a
 * provider was configured to carry it, so "was the client told?" has an
 * answer. With no API key set, rows read 'skipped' and this screen is the
 * list of what somebody needs to send by hand.
 */
adminRouter.get(
  '/emails',
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const rows = (await db
      .prepare(
        `SELECT id, to_email, to_name, subject, kind, entity, entity_id,
                status, error, created_at, sent_at
         FROM emails ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(limit));

    const counts = (await db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'sent'    THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
           SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed
         FROM emails`
      )
      .get());

    res.json({
      emails: rows.map((r) => isoFields(r, ['created_at', 'sent_at'])),
      counts,
      delivery: emailKind,
    });
  })
);

/** One message in full, for when an admin has to send it by hand. */
adminRouter.get(
  '/emails/:id',
  wrap(async (req, res) => {
    const row = (await db.prepare(`SELECT * FROM emails WHERE id = ?`).get(req.params.id));
    if (!row) throw new HttpError(404, 'Message not found.');
    res.json({ email: isoFields(row, ['created_at', 'sent_at']) });
  })
);

/* ------------------------------------------------------------ quick search --- */

/**
 * The console's quick search (Ctrl+K): people by name, code or phone, sites by
 * name or city, and incidents by reference. A handful of each, best first -
 * it is for jumping somewhere, not for browsing.
 */
adminRouter.get(
  '/search',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return res.json({ employees: [], sites: [], incidents: [] });
    const like = `%${q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const starts = `${q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

    const employees = await db
      .prepare(
        `SELECT id, employee_code, first_name, last_name, role, status, employment_type
         FROM users
         WHERE lower(first_name || ' ' || last_name) LIKE ? OR employee_code LIKE ? OR lower(last_name) LIKE ?
            OR regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') LIKE ?
         ORDER BY CASE WHEN employee_code = ? THEN 0 WHEN lower(first_name) LIKE ? THEN 1 ELSE 2 END, last_name, first_name
         LIMIT 8`
      )
      .all(like, starts, starts, /\d{3,}/.test(q) ? `%${q.replace(/\D/g, '')}%` : '-', q, starts);

    const sites = await db
      .prepare(
        `SELECT id, name, city, state, client_name FROM sites
         WHERE lower(name) LIKE ? OR lower(coalesce(city, '')) LIKE ? OR lower(coalesce(client_name, '')) LIKE ?
         ORDER BY name LIMIT 6`
      )
      .all(like, starts, like);

    const incidents = await db
      .prepare(
        `SELECT i.id, i.ref_number, i.category, i.severity, i.occurred_at, s.name AS site_name
         FROM incidents i LEFT JOIN sites s ON s.id = i.site_id
         WHERE lower(i.ref_number) LIKE ?
         ORDER BY i.occurred_at DESC LIMIT 5`
      )
      .all(like);

    res.json({
      employees: employees.map((e) => ({ ...e, full_name: `${e.first_name} ${e.last_name}` })),
      sites,
      incidents: incidents.map((i) => isoFields(i, ['occurred_at'])),
    });
  })
);
