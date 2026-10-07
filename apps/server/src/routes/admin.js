import { Router } from 'express';
import { z } from 'zod';
import { db, audit, demoInstance } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, sqlToIso, parseDay, toDateString, idParam, limitParam, dateParam, sendCsv } from '../lib/http.js';
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
  VISIT_CHECKS,
  CALL_ACK_MINUTES,
  CALL_PRIORITY_LABEL,
  CALL_TYPE_LABEL,
  CONFIRM_ALERT_HOURS,
  CONFIRM_AHEAD_DAYS,
  EXPENSE_CATEGORY_LABEL,
  COMMENDATION_LABEL,
} from '../shared.js';
import { toSql, sweep } from '../services/compliance.js';
import { emailKind } from '../services/email.js';
import { recordPayHistory } from '../services/payHistory.js';
import { loadPricedEntries, personPay, groupBy } from '../services/payroll.js';
import { adjustEntry } from '../services/timeEntries.js';
import { currentOrders, reviseOrders } from '../services/postOrders.js';
import { siteMonth, monthKey } from '../services/siteMonth.js';
import { visitBoard } from './visits.js';
import { checkEligibility } from './shiftRequests.js';
import { pushAsync } from '../services/push.js';
import { OPEN_SQL } from '../services/dispatch.js';
import { agreementBoard } from '../services/agreements.js';
import { confirmationOf, confirmShift, unconfirmedSoon } from '../services/confirmations.js';
import { overtimeWatch } from '../services/overtime.js';
import { fleet } from '../services/vehicles.js';
import { holidaysForSpan, holidayOutlook, HOLIDAY_ALERT_DAYS } from '../services/holidays.js';
import { trainingStatesForPost, trainingAlerts } from '../services/training.js';
import { suspendedIds, unsignedOverdue } from '../services/conduct.js';
import { handovers } from '../services/handovers.js';

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

    const openIssues = Number((await db
      .prepare(`SELECT COUNT(*) AS n FROM site_issues WHERE status <> 'fixed'`)
      .get()).n);
    const foundHeld = Number((await db
      .prepare(`SELECT COUNT(*) AS n FROM lost_found WHERE status = 'held'`)
      .get()).n);

    // A client who scored us two or under and has not heard back.
    const unhappyClients = Number((await db
      .prepare(`SELECT COUNT(*) AS n FROM client_feedback WHERE rating <= 2 AND response IS NULL`)
      .get()).n);

    // Active sites no field supervisor has visited for too long.
    const visitsDue = (await visitBoard()).due;
    // Applications nobody has picked up yet.
    const newApplicants = Number((await db.prepare(`SELECT COUNT(*) AS n FROM applicants WHERE stage = 'applied'`).get()).n);
    // Calls for service still open, and how many of them nobody has been sent to.
    const callRows = await db.prepare(`SELECT status, COUNT(*) AS n FROM service_calls WHERE status IN (${OPEN_SQL}) GROUP BY status`).all();
    const activeCalls = callRows.reduce((n, r) => n + Number(r.n), 0);
    const waitingCalls = Number(callRows.find((r) => r.status === 'open')?.n || 0);
    // Officers' requests to fix a punch, waiting on an administrator.
    const pendingCorrections = Number((await db.prepare(`SELECT COUNT(*) AS n FROM time_corrections WHERE status = 'pending'`).get()).n);
    const signoffDisputes = Number((await db.prepare(`SELECT COUNT(*) AS n FROM hours_signoffs WHERE status = 'disputed' AND response IS NULL`).get()).n);
    // Officers rostered in the coming week at a post they are not trained at.
    const untrainedRostered = (await trainingAlerts()).length;
    // Posts changing hands soon with no relief assigned, or a relief who has not come.
    const handoversAtRisk = (await handovers()).counts.at_risk;
    // Coaching and warnings an officer has left unsigned for days.
    const conductUnsigned = (await unsignedOverdue()).filter((r) => r.officer_role === 'officer' || req.user.role === ROLES.ADMIN).length;
    // Expense claims waiting for an administrator.
    const pendingExpenses = Number((await db.prepare(`SELECT COUNT(*) AS n FROM expense_claims WHERE status = 'pending'`).get()).n);
    const overtimeRisk = (await overtimeWatch()).totals.avoidable;
    // Open shifts on a holiday coming up soon: the hardest days to fill.
    const holidayGaps = (await holidayOutlook({ withinDays: HOLIDAY_ALERT_DAYS })).reduce((n, h) => n + h.open, 0);
    // Sites rostered short of their agreement, or with one about to run out.
    const agreementSummary = (await agreementBoard()).summary;
    // Officers due on post soon who have not said they will be there.
    const unconfirmed = await unconfirmedSoon();
    // Patrol vehicles off the road, overdue a service, or driven without a check.
    const vehicles = await fleet();
    const fleetAttention = vehicles.filter((v) => v.off_road || v.uninspected_overdue || v.service.state === 'overdue').length;

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
        openIssues,
        foundHeld,
        unhappyClients,
        visitsDue,
        newApplicants,
        activeCalls,
        waitingCalls,
        pendingCorrections,
        signoffDisputes,
        untrainedRostered,
        handoversAtRisk,
        conductUnsigned,
        agreementsShort: agreementSummary.short,
        agreementRenewals: agreementSummary.renewals,
        unconfirmedShifts: unconfirmed.length,
        fleetAttention,
        pendingExpenses,
        overtimeRisk,
        holidayGaps,
      },
      unconfirmed,
      alerts: openAlerts.map((a) => isoFields(a, ['triggered_at', 'acknowledged_at'])),
      onDuty: onDuty.map((r) => ({
        ...isoFields(r, ['clock_in_at', 'next_check_due']),
        minutes_on_post: minutesBetween(sqlToIso(r.clock_in_at), new Date().toISOString()),
      })),
      recentFlags: recentFlags.map((f) => ({
        ...isoFields(f, ['occurred_at', 'created_at']),
        label: FLAG_LABEL[f.type] || f.type,
      })),
      upcoming: upcoming.map((s) => ({ ...isoFields(s, ['starts_at', 'ends_at']), ...confirmationOf(s) })),
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
    const postId = idParam(req.query.postId, 'post');
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

    const trainingOf = post.training_required ? await trainingStatesForPost(post.id) : null;
    const suspended = await suspendedIds(startsAt);

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
        training: trainingOf ? trainingOf(u.id) : null,
        suspended: suspended.has(u.id),
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
        training: trainingOf ? trainingOf(u.id) : null,
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
      post: { id: post.id, name: post.name, armed: Boolean(post.armed), training_required: Boolean(post.training_required), bill_rate: post.bill_rate_cents != null ? post.bill_rate_cents / 100 : null },
      shift_hours: toHours(shiftMinutes),
      candidates,
    });
  })
);

adminRouter.get(
  '/shifts',
  wrap(async (req, res) => {
    const from = dateParam(req.query.from, new Date(Date.now() - 86400000));
    const to = dateParam(req.query.to, new Date(Date.now() + 14 * 86400000));

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
        ...(req.query.siteId ? [idParam(req.query.siteId, 'site')] : []),
        ...(req.query.userId ? [idParam(req.query.userId, 'person')] : [])
      ));

    // The holidays in the range, so the schedule can mark the days that pay and bill more.
    const holidays = [...(await holidaysForSpan(from, to)).values()];
    res.json({
      shifts: rows.map((s) => ({
        ...isoFields(s, ['starts_at', 'ends_at', 'clock_in_at', 'clock_out_at', 'created_at']),
        ...confirmationOf(s),
      })),
      holidays,
    });
  })
);

/** Upcoming shifts whose officer has not confirmed, soonest first (`hours` ahead, 12 by default). */
adminRouter.get(
  '/confirmations',
  wrap(async (req, res) => {
    const hours = Math.min(Math.max(Number(req.query.hours) || CONFIRM_ALERT_HOURS, 1), CONFIRM_AHEAD_DAYS * 24);
    res.json({ hours, shifts: await unconfirmedSoon(hours) });
  })
);

/**
 * A supervisor records that the officer confirmed some other way - usually a
 * phone call after the reminder went unanswered.
 */
adminRouter.post(
  '/shifts/:id/confirm',
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'shift');
    const body = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body || {});
    const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(id);
    if (!shift) throw new HttpError(404, 'Shift not found.');
    if (!shift.user_id) throw new HttpError(409, 'Nobody is assigned to that shift yet.');
    if (shift.status !== 'scheduled') throw new HttpError(409, 'That shift is no longer scheduled.');
    if (new Date(sqlToIso(shift.ends_at)) <= new Date()) throw new HttpError(409, 'That shift is over.');
    const updated = await confirmShift(shift, { byUserId: req.user.id, method: 'phone', note: body.note || null });
    await audit(req.user.id, 'shift.confirmed', 'shift', id, { method: 'phone', note: body.note || null }, req.ip);
    res.json({ shift: { id, ...confirmationOf(updated) } });
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

    // A confirmation is for who, where and when it was given: the key already
    // stops it carrying over, and clearing it here means handing a shift away
    // and back again does not bring it back either.
    if (moved || reassigned) {
      await db.prepare(`UPDATE shifts SET confirmed_key = NULL, reminded_key = NULL WHERE id = ?`).run(shift.id);
    }
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
    const from = dateParam(req.query.from, new Date(Date.now() - 14 * 86400000));
    const to = dateParam(req.query.to, new Date());

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
          holiday_hours: 0,
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
        holiday_hours: toHours(pay.holidayMinutes || 0),
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
    const from = dateParam(req.query.from, new Date(Date.now() - 7 * 86400000));
    const to = dateParam(req.query.to, new Date());

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
      .all(toSql(from), toSql(to), ...(req.query.userId ? [idParam(req.query.userId, 'person')] : [])));

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

    // The same path an approved officer request takes: original times kept,
    // closed pay periods refused.
    const updated = await adjustEntry(entry, {
      clockInAt: body.clockInAt,
      clockOutAt: body.clockOutAt,
      reason: body.reason,
      userId: req.user.id,
      ip: req.ip,
    });
    res.json({ entry: isoFields(updated, ['clock_in_at', 'clock_out_at']) });
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
        ...(req.query.userId ? [idParam(req.query.userId, 'person')] : [])
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
  trainingRequired: z.boolean().default(false),
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
                            geofence_radius_m, check_in_interval_min, requires_gps, armed, training_required, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(b.siteId, b.name, b.postCode ?? null, b.instructions ?? null, b.address ?? null,
           b.latitude ?? null, b.longitude ?? null,
           b.geofenceRadiusM, b.checkInIntervalMin, b.requiresGps ? 1 : 0, b.armed ? 1 : 0, b.trainingRequired ? 1 : 0, b.active ? 1 : 0));
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
    for (const [k, col] of Object.entries({ requiresGps: 'requires_gps', armed: 'armed', trainingRequired: 'training_required', active: 'active' })) {
      if (b[k] !== undefined) { sets.push(`${col} = ?`); params.push(b[k] ? 1 : 0); }
    }
    // A change to the instructions is a new version of the post orders,
    // which the officers on the post then have to acknowledge. The text as it
    // stood is recorded as version 1 first, before the update replaces it.
    if (b.instructions !== undefined) await currentOrders(post.id);
    if (sets.length) {
      params.push(post.id);
      (await db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...params));
    }
    if (b.instructions !== undefined) {
      await reviseOrders(post.id, b.instructions, req.user.id, 'Edited on the Sites screen');
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
      .all(toSql(dateParam(req.query.from, new Date(Date.now() - 14 * 86400000)))));
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
    const from = dateParam(req.query.from, new Date(Date.now() - 14 * 86400000));
    const to = dateParam(req.query.to, new Date());

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
    const limit = limitParam(req.query.limit, 100, 300);
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

/* ------------------------------------------------------ overtime watch --- */

/** Who is heading past 40 hours this payroll week (or the week of ?week=). */
adminRouter.get(
  '/overtime',
  wrap(async (req, res) => {
    // A bare YYYY-MM-DD is a calendar day here, not midnight UTC: read as
    // UTC, Monday is still Sunday evening anywhere west of Greenwich and the
    // board would show the week before the one asked for.
    const day = req.query.week ? parseDay(String(req.query.week)) : new Date();
    if (!day) throw new HttpError(422, 'That date is not valid.');
    res.json(await overtimeWatch(day));
  })
);

/* -------------------------------------------------------- scorecards --- */

/**
 * Officer scorecards: how each officer has actually worked over a period,
 * from the records already kept - never a supervisor's impression.
 *
 * The score (0-100) weighs what a client notices first:
 *   35  punctuality   clocked in within the grace period of the shift start
 *   25  attendance    shifts worked out of shifts that should have been
 *   25  check-ins     answered in their window (a late answer counts half)
 *   15  clean record  fewer compliance flags per shift worked
 * A part with nothing to judge (no check-ins due, say) is left out and the
 * rest scaled up, so an officer is not marked down for what never came up.
 */
adminRouter.get(
  '/scorecards',
  wrap(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 180);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    const f = toSql(from);
    const t = toSql(to);
    const grace = RULES.lateGraceMinutes;

    const people = await db
      .prepare(
        `SELECT id, employee_code, first_name, last_name, role, employment_type, status
         FROM users WHERE role IN ('officer', 'supervisor') AND status = 'active' ORDER BY last_name, first_name`
      )
      .all();
    const byUser = (rows) => new Map(rows.map((r) => [r.user_id, r]));

    // Shifts that have ended (or begun) in the window, and whether they were worked.
    const shifts = byUser(
      await db
        .prepare(
          `SELECT sh.user_id,
                  COUNT(*) AS due,
                  SUM(CASE WHEN te.id IS NOT NULL THEN 1 ELSE 0 END) AS worked,
                  SUM(CASE WHEN te.id IS NULL AND sh.status IN ('missed', 'no_show') THEN 1 ELSE 0 END) AS missed,
                  SUM(CASE WHEN te.id IS NOT NULL
                            AND te.clock_in_at <= sh.starts_at + make_interval(mins => ?) THEN 1 ELSE 0 END) AS on_time,
                  AVG(CASE WHEN te.id IS NOT NULL AND te.clock_in_at > sh.starts_at + make_interval(mins => ?)
                           THEN EXTRACT(EPOCH FROM (te.clock_in_at - sh.starts_at)) / 60 END) AS avg_late
           FROM shifts sh
           LEFT JOIN LATERAL (
             SELECT id, clock_in_at FROM time_entries x WHERE x.shift_id = sh.id ORDER BY x.clock_in_at LIMIT 1
           ) te ON true
           WHERE sh.user_id IS NOT NULL AND sh.starts_at >= ? AND sh.starts_at < ? AND sh.status <> 'cancelled'
           GROUP BY sh.user_id`
        )
        .all(grace, grace, f, t)
    );
    const hours = byUser(
      await db
        .prepare(
          `SELECT user_id, COALESCE(SUM(minutes_worked), 0) AS minutes FROM time_entries
           WHERE clock_in_at >= ? AND clock_in_at < ? GROUP BY user_id`
        )
        .all(f, t)
    );
    const checks = byUser(
      await db
        .prepare(
          `SELECT user_id,
                  SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
                  SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late,
                  SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) AS missed
           FROM status_checks WHERE due_at >= ? AND due_at < ? GROUP BY user_id`
        )
        .all(f, t)
    );
    const tours = byUser(
      await db
        .prepare(
          `SELECT user_id, COUNT(*) AS runs,
                  SUM(CASE WHEN status LIKE 'completed%' THEN 1 ELSE 0 END) AS completed
           FROM tour_runs WHERE started_at >= ? AND started_at < ? GROUP BY user_id`
        )
        .all(f, t)
    );
    const incidents = byUser(
      await db.prepare(`SELECT user_id, COUNT(*) AS n FROM incidents WHERE occurred_at >= ? AND occurred_at < ? GROUP BY user_id`).all(f, t)
    );
    // Thanks from clients and supervisors: shown beside the score, never part of it.
    const commendations = byUser(
      await db
        .prepare(
          `SELECT user_id, COUNT(*) AS n, SUM(CASE WHEN client_user_id IS NOT NULL THEN 1 ELSE 0 END) AS from_clients
           FROM commendations WHERE created_at >= ? AND created_at < ? GROUP BY user_id`
        )
        .all(f, t)
    );
    const flags = byUser(
      await db
        .prepare(
          `SELECT user_id, COUNT(*) AS n, SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical
           FROM flags WHERE occurred_at >= ? AND occurred_at < ? GROUP BY user_id`
        )
        .all(f, t)
    );

    const n = (v) => Number(v || 0);
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

    const cards = people
      .map((p) => {
        const s = shifts.get(p.id) || {};
        const c = checks.get(p.id) || {};
        const tr = tours.get(p.id) || {};
        const fl = flags.get(p.id) || {};
        const worked = n(s.worked);
        const due = worked + n(s.missed);
        const checksDue = n(c.ok) + n(c.late) + n(c.missed);
        const parts = [
          [35, worked ? n(s.on_time) / worked : null],
          [25, due ? worked / due : null],
          [25, checksDue ? (n(c.ok) + n(c.late) * 0.5) / checksDue : null],
          [15, worked ? Math.max(0, 1 - n(fl.n) / worked / 2) : null],
        ].filter(([, v]) => v !== null);
        const weight = parts.reduce((a, [w]) => a + w, 0);
        const score = weight ? Math.round(parts.reduce((a, [w, v]) => a + w * v, 0) / weight * 100) : null;
        return {
          id: p.id,
          employee_code: p.employee_code,
          name: `${p.first_name} ${p.last_name}`,
          role: p.role,
          employment_type: p.employment_type,
          score,
          shifts: { due, worked, missed: n(s.missed), onTime: n(s.on_time), onTimePct: pct(n(s.on_time), worked), avgLateMin: s.avg_late ? Math.round(Number(s.avg_late)) : 0 },
          hours: toHours(n(hours.get(p.id)?.minutes)),
          checkIns: { ok: n(c.ok), late: n(c.late), missed: n(c.missed), answeredPct: pct(n(c.ok) + n(c.late), checksDue) },
          tours: { runs: n(tr.runs), completed: n(tr.completed) },
          incidents: n(incidents.get(p.id)?.n),
          flags: { total: n(fl.n), critical: n(fl.critical) },
          commendations: { total: n(commendations.get(p.id)?.n), fromClients: n(commendations.get(p.id)?.from_clients) },
        };
      })
      .filter((c) => c.shifts.due > 0 || c.hours > 0);

    cards.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name));
    if (req.query.format === 'csv') {
      return sendCsv(res, `officer-scorecards-${days}-days`, [
        ['Officer', 'name'], ['Code', 'employee_code'], ['Role', 'role'], ['Type', 'employment_type'], ['Score', 'score'],
        ['Shifts due', (c) => c.shifts.due], ['Worked', (c) => c.shifts.worked], ['Missed', (c) => c.shifts.missed],
        ['On time %', (c) => c.shifts.onTimePct], ['Avg minutes late', (c) => c.shifts.avgLateMin], ['Hours', 'hours'],
        ['Check-ins answered %', (c) => c.checkIns.answeredPct], ['Check-ins missed', (c) => c.checkIns.missed],
        ['Tours completed', (c) => c.tours.completed], ['Incidents', 'incidents'], ['Flags', (c) => c.flags.total],
        ['Commendations', (c) => c.commendations.total],
      ], cards);
    }
    const scored = cards.filter((c) => c.score !== null);
    res.json({
      days,
      from: from.toISOString(),
      to: to.toISOString(),
      graceMinutes: grace,
      averageScore: scored.length ? Math.round(scored.reduce((a, c) => a + c.score, 0) / scored.length) : null,
      cards,
    });
  })
);


/* ------------------------------------------------------ client feedback --- */

/**
 * What clients think of the service: every rating from the last few months,
 * the average per property, and anything scored two or under without a reply
 * picked out, because that is a client thinking about leaving.
 */
adminRouter.get(
  '/feedback',
  wrap(async (req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
    const since = new Date();
    since.setMonth(since.getMonth() - months + 1);
    const from = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}`;
    const rows = await db
      .prepare(
        `SELECT f.*, s.name AS site_name, c.name AS client_name, c.company AS client_company,
                u.first_name || ' ' || u.last_name AS responded_by_name
         FROM client_feedback f
         JOIN sites s ON s.id = f.site_id
         JOIN client_users c ON c.id = f.client_user_id
         LEFT JOIN users u ON u.id = f.responded_by
         WHERE f.period >= ?
         ORDER BY f.period DESC, f.rating ASC, s.name`
      )
      .all(from);
    const bySite = new Map();
    for (const r of rows) {
      const e = bySite.get(r.site_id) || { site_id: r.site_id, site_name: r.site_name, ratings: [] };
      e.ratings.push(r.rating);
      bySite.set(r.site_id, e);
    }
    if (req.query.format === 'csv') {
      return sendCsv(res, `client-feedback-${months}-months`, [
        ['Month', 'period'], ['Site', 'site_name'], ['Client', 'client_name'], ['Company', 'client_company'], ['Rating', 'rating'],
        ['Comment', 'comment'], ['Our reply', 'response'], ['Replied by', 'responded_by_name'], ['Replied', 'responded_at'],
      ], rows);
    }
    const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const byMonth = [...new Set(rows.map((r) => r.period))].sort().map((p) => ({ period: p, average: avg(rows.filter((r) => r.period === p).map((r) => r.rating)), count: rows.filter((r) => r.period === p).length }));
    res.json({
      feedback: rows.map((r) => isoFields(r, ['responded_at', 'created_at', 'updated_at'])),
      sites: [...bySite.values()].map((e) => ({ site_id: e.site_id, site_name: e.site_name, average: avg(e.ratings), count: e.ratings.length })).sort((a, b) => a.average - b.average),
      byMonth,
      average: avg(rows.map((r) => r.rating)),
      needsReply: rows.filter((r) => r.rating <= 2 && !r.response).length,
    });
  })
);

adminRouter.post(
  '/feedback/:id/respond',
  wrap(async (req, res) => {
    const body = parse(z.object({ response: z.string().trim().min(5, 'Write a reply the client will read.').max(1000) }), req.body);
    const row = await db.prepare(`SELECT * FROM client_feedback WHERE id = ?`).get(idParam(req.params.id, 'feedback'));
    if (!row) throw new HttpError(404, 'Feedback not found.');
    await db
      .prepare(`UPDATE client_feedback SET response = ?, responded_by = ?, responded_at = now() WHERE id = ?`)
      .run(body.response, req.user.id, row.id);
    await audit(req.user.id, 'feedback.responded', 'client_feedback', row.id, null, req.ip);
    res.json({ ok: true });
  })
);

/* --------------------------------------------------------- alerts inbox --- */

/**
 * One inbox for everything waiting on a supervisor, worked out from the
 * records rather than stored: a duress button pressed, an officer who missed
 * a check-in or walked off post, a watchlisted person let in anyway, an
 * urgent building issue, an unhappy client, a request nobody has answered,
 * a licence about to lapse. Only the read marks are kept, per person, so the
 * list is always current and never needs clearing up.
 */
async function buildAlerts(userId) {
  const since = toSql(new Date(Date.now() - 72 * 3600000));
  const alerts = [];
  const push = (a) => alerts.push(a);

  for (const p of await db
    .prepare(
      `SELECT pa.id, pa.triggered_at, pa.status, u.first_name || ' ' || u.last_name AS officer, po.name AS post_name
       FROM panic_alerts pa JOIN users u ON u.id = pa.user_id LEFT JOIN posts po ON po.id = pa.post_id
       WHERE pa.status IN ('active', 'acknowledged') ORDER BY pa.triggered_at DESC`
    )
    .all()) {
    push({ key: `duress:${p.id}`, kind: 'duress', severity: 'critical', at: p.triggered_at, link: '/admin/safety',
      title: `Duress alert: ${p.officer}`, detail: `${p.post_name || 'Unknown post'} - ${p.status === 'active' ? 'not yet acknowledged' : 'acknowledged, still open'}` });
  }

  for (const f of await db
    .prepare(
      `SELECT f.id, f.type, f.severity, f.occurred_at, u.first_name || ' ' || u.last_name AS officer
       FROM flags f JOIN users u ON u.id = f.user_id
       WHERE f.resolved_at IS NULL AND f.occurred_at >= ? AND (f.severity = 'critical' OR f.type IN ('no_show', 'off_post', 'missed_check_in'))
       ORDER BY f.occurred_at DESC LIMIT 25`
    )
    .all(since)) {
    push({ key: `flag:${f.id}`, kind: 'flag', severity: f.severity === 'critical' ? 'critical' : 'warning', at: f.occurred_at, link: '/admin/flags',
      title: `${FLAG_LABEL[f.type] || f.type}: ${f.officer}`, detail: 'Open compliance flag, not yet resolved' });
  }

  // A call for service nobody has been sent to, or one sent and not acknowledged.
  for (const c of await db
    .prepare(
      `SELECT c.id, c.status, c.priority, c.call_type, c.created_at, c.assigned_at, c.description, s.name AS site_name,
              u.first_name || ' ' || u.last_name AS officer
       FROM service_calls c JOIN sites s ON s.id = c.site_id LEFT JOIN users u ON u.id = c.assigned_to
       WHERE c.status = 'open' OR (c.status = 'assigned' AND c.assigned_at < ?)
       ORDER BY c.priority, c.created_at`
    )
    .all(toSql(new Date(Date.now() - CALL_ACK_MINUTES * 60000)))) {
    const waiting = c.status === 'open';
    push({ key: `call:${c.id}:${waiting ? 'open' : `ack:${sqlToIso(c.assigned_at)}`}`, kind: 'call',
      severity: c.priority <= 2 ? 'critical' : 'warning', at: waiting ? c.created_at : c.assigned_at, link: `/admin/dispatch?call=${c.id}`,
      title: waiting
        ? `${CALL_PRIORITY_LABEL[c.priority]} call waiting: ${CALL_TYPE_LABEL[c.call_type] || c.call_type}`
        : `${c.officer} has not acknowledged a call`,
      detail: `${c.site_name} · ${String(c.description).slice(0, 80)}` });
  }

  for (const v of await db
    .prepare(
      `SELECT v.id, v.full_name, v.arrived_at, s.name AS site_name, w.action, u.first_name || ' ' || u.last_name AS officer
       FROM visitor_log v JOIN sites s ON s.id = v.site_id JOIN watchlist w ON w.id = v.watchlist_id
       LEFT JOIN users u ON u.id = v.logged_by
       WHERE v.arrived_at >= ? ORDER BY v.arrived_at DESC`
    )
    .all(since)) {
    push({ key: `override:${v.id}`, kind: 'watchlist', severity: 'warning', at: v.arrived_at, link: '/admin/post-logs?tab=watchlist',
      title: `Watchlist override: ${v.full_name}`, detail: `Let in at ${v.site_name} by ${v.officer || 'an officer'}` });
  }

  for (const i of await db
    .prepare(
      `SELECT i.id, i.category, i.location_text, i.created_at, s.name AS site_name
       FROM site_issues i JOIN sites s ON s.id = i.site_id
       WHERE i.priority = 'urgent' AND i.status <> 'fixed' ORDER BY i.created_at DESC`
    )
    .all()) {
    push({ key: `issue:${i.id}`, kind: 'issue', severity: 'warning', at: i.created_at, link: '/admin/post-logs?tab=issues',
      title: `Urgent building issue at ${i.site_name}`, detail: `${i.category.replace('_', ' ')}${i.location_text ? `, ${i.location_text}` : ''}` });
  }

  for (const f of await db
    .prepare(
      `SELECT f.id, f.rating, f.updated_at, s.name AS site_name, c.name AS client_name
       FROM client_feedback f JOIN sites s ON s.id = f.site_id JOIN client_users c ON c.id = f.client_user_id
       WHERE f.rating <= 2 AND f.response IS NULL ORDER BY f.updated_at DESC`
    )
    .all()) {
    push({ key: `feedback:${f.id}`, kind: 'feedback', severity: 'warning', at: f.updated_at, link: '/admin/feedback',
      title: `${f.client_name} rated ${f.site_name} ${f.rating} of 5`, detail: 'Waiting for a reply' });
  }

  for (const r of await db
    .prepare(
      `SELECT r.id, r.starts_at, r.officers, r.created_at, s.name AS site_name
       FROM coverage_requests r JOIN sites s ON s.id = r.site_id WHERE r.status = 'open' ORDER BY r.starts_at`
    )
    .all()) {
    push({ key: `coverage:${r.id}`, kind: 'coverage', severity: 'info', at: r.created_at, link: '/admin/coverage-requests',
      title: `${s(r.officers, 'officer')} requested at ${r.site_name}`, detail: 'Starts', detailAt: sqlToIso(r.starts_at) });
  }

  for (const c of await db
    .prepare(
      `SELECT c.id, c.type, c.expires_on, u.first_name || ' ' || u.last_name AS officer
       FROM certifications c JOIN users u ON u.id = c.user_id
       WHERE u.status = 'active' AND c.expires_on IS NOT NULL AND c.expires_on <= current_date + 14
       ORDER BY c.expires_on`
    )
    .all()) {
    const lapsed = new Date(c.expires_on) < new Date(new Date().toDateString());
    push({ key: `licence:${c.id}:${String(c.expires_on).slice(0, 10)}`, kind: 'licence', severity: lapsed ? 'warning' : 'info',
      at: c.expires_on, link: '/admin/compliance',
      title: `${c.officer}: ${c.type.replace(/_/g, ' ')} ${lapsed ? 'has lapsed' : 'expires soon'}`, detail: `Expires ${String(c.expires_on).slice(0, 10)}` });
  }

  // A patrol finished with required checkpoints skipped: the client pays for
  // those checkpoints, so each skip needs looking at.
  for (const r of await db
    .prepare(
      `SELECT tr.id, tr.completed_at, t.name AS tour_name, s.name AS site_name,
              u.first_name || ' ' || u.last_name AS officer, COUNT(*) AS skipped
       FROM tour_runs tr
       JOIN tours t ON t.id = tr.tour_id JOIN sites s ON s.id = t.site_id JOIN users u ON u.id = tr.user_id
       JOIN tour_run_checkpoints trc ON trc.tour_run_id = tr.id
       JOIN checkpoints c ON c.id = trc.checkpoint_id
       WHERE tr.completed_at >= ? AND trc.status = 'skipped' AND c.required = true
       GROUP BY tr.id, tr.completed_at, t.name, s.name, u.first_name, u.last_name
       ORDER BY tr.completed_at DESC LIMIT 25`
    )
    .all(since)) {
    push({ key: `tour:${r.id}`, kind: 'tour', severity: 'warning', at: r.completed_at, link: '/admin/tours',
      title: `${s(Number(r.skipped), 'required checkpoint')} skipped: ${r.tour_name}`, detail: `${r.officer} at ${r.site_name}` });
  }

  // A patrol started and never finished: abandoned, or still open hours after it began.
  for (const r of await db
    .prepare(
      `SELECT tr.id, tr.started_at, tr.status, t.name AS tour_name, s.name AS site_name,
              u.first_name || ' ' || u.last_name AS officer
       FROM tour_runs tr JOIN tours t ON t.id = tr.tour_id JOIN sites s ON s.id = t.site_id JOIN users u ON u.id = tr.user_id
       WHERE tr.started_at >= ? AND (tr.status = 'abandoned' OR (tr.status = 'in_progress' AND tr.started_at < ?))
       ORDER BY tr.started_at DESC LIMIT 25`
    )
    .all(since, toSql(new Date(Date.now() - 4 * 3600000)))) {
    push({ key: `tour-open:${r.id}`, kind: 'tour', severity: 'warning', at: r.started_at, link: '/admin/tours',
      title: `Tour not finished: ${r.tour_name}`, detail: `${r.officer} at ${r.site_name}, ${r.status === 'abandoned' ? 'abandoned' : 'still open after 4 hours'}` });
  }

  // Someone who applied to work for us and has not been picked up yet.
  for (const a of await db
    .prepare(
      `SELECT id, first_name, last_name, licence_class, city, created_at FROM applicants
       WHERE stage = 'applied' ORDER BY created_at LIMIT 25`
    )
    .all()) {
    push({ key: `applicant:${a.id}`, kind: 'applicant', severity: 'info', at: a.created_at, link: '/admin/hiring',
      title: `New applicant: ${a.first_name} ${a.last_name}`,
      detail: [a.licence_class === 'none' ? 'No licence yet' : `Class ${a.licence_class === 'DG' ? 'D and G' : a.licence_class}`, a.city].filter(Boolean).join(' · ') });
  }

  // A site rostered short of the hours its agreement pays for, next seven
  // days; and an agreement inside its notice period.
  const board = await agreementBoard();
  const weekKey = toDateString(new Date());
  for (const site of board.sites) {
    if (site.short) {
      push({ key: `agreement-short:${site.id}:${weekKey}`, kind: 'agreement', severity: 'warning', at: new Date().toISOString(),
        link: '/admin/agreements', title: `${site.name} is rostered ${site.shortfall_hours} h short of its agreement`,
        detail: `${site.rostered_hours} of ${site.agreement.weekly_hours} h a week in the next 7 days` });
    }
    if (site.agreement?.renewal_due) {
      const a = site.agreement;
      push({ key: `agreement-renewal:${site.id}:${a.ends_on}`, kind: 'agreement', severity: a.expired ? 'warning' : 'info', at: new Date().toISOString(),
        link: '/admin/agreements', title: a.expired ? `The agreement for ${site.name} has ended` : `The agreement for ${site.name} ends in ${a.days_left} days`,
        detail: `Ends ${a.ends_on} · ${site.client_name || ''}`.trim() });
    }
  }

  // An officer due on post within the next 12 hours who has not confirmed;
  // critical inside the last two. The key carries the urgency, so the alert
  // comes back unread when it turns critical.
  for (const c of await unconfirmedSoon()) {
    push({ key: `confirm:${c.id}:${c.starts_at}:${c.urgent ? 'urgent' : 'soon'}`, kind: 'confirm', severity: c.urgent ? 'critical' : 'warning',
      at: c.starts_at, link: '/admin#unconfirmed', title: `${c.officer} has not confirmed their shift`,
      detail: `${c.post_name} · ${c.site_name}` });
  }

  // Patrol vehicles: off the road, signed out and not checked, or due a service.
  for (const v of await fleet()) {
    const link = `/admin/fleet?vehicle=${v.id}`;
    for (const d of v.defects.filter((x) => x.critical)) {
      push({ key: `vehicle-defect:${d.id}`, kind: 'vehicle', severity: 'critical', at: d.reported_at, link,
        title: `${v.label} is off the road`, detail: `${d.label} failed inspection${d.reported_by ? ` · ${d.reported_by}` : ''}` });
    }
    if (v.uninspected_overdue) {
      push({ key: `vehicle-uninspected:${v.holder.assignment_id}`, kind: 'vehicle', severity: 'warning', at: v.holder.issued_at, link,
        title: `${v.holder.name} has not checked ${v.label}`, detail: 'Signed out with no start inspection' });
    }
    if (v.service.state === 'overdue' || v.service.state === 'due') {
      const overdue = v.service.state === 'overdue';
      push({ key: `vehicle-service:${v.id}:${v.service_due_miles}:${v.service.state}`, kind: 'vehicle', severity: overdue ? 'warning' : 'info',
        at: v.last_inspection?.created_at || new Date().toISOString(), link,
        title: overdue ? `${v.label} is overdue a service` : `${v.label} is due a service`,
        detail: overdue
          ? `${Math.abs(v.service.milesLeft).toLocaleString('en-US')} miles past the ${v.service_due_miles.toLocaleString('en-US')}-mile service`
          : `${v.service.milesLeft.toLocaleString('en-US')} miles to go` });
    }
  }

  // An officer on the roster at a post that needs site training, without it.
  // Usually a training shift: it wants a trained officer alongside, and a
  // sign-off afterwards.
  for (const t of await trainingAlerts()) {
    const lapsed = t.state === 'lapsed';
    push({ key: `training:${t.shift_id}:${t.user_id}`, kind: 'training', severity: t.hours_away <= 48 ? 'warning' : 'info',
      at: t.starts_at, link: '/admin/site-training',
      title: lapsed ? `${t.officer} needs a refresher at ${t.post_name}` : `${t.officer} is not trained at ${t.post_name}`,
      detail: `${t.site_name} · rostered ${new Date(t.starts_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` });
  }

  // A post about to change hands with nobody to take it, or an officer held
  // over because their relief has not come. The key carries the state, so the
  // alert comes back unread when an open post turns into a late one.
  for (const h of (await handovers()).handovers.filter((x) => x.state === 'late' || x.state === 'open')) {
    const late = h.state === 'late';
    push({ key: `handover:${h.shift_id}:${h.state}`, kind: 'handover', severity: h.severity === 'critical' ? 'critical' : 'warning',
      at: h.ends_at, link: `/admin/handovers?shift=${h.shift_id}`,
      title: late ? `${h.relief.officer} has not arrived to relieve ${h.officer}` : `Nobody is assigned to relieve ${h.officer}`,
      detail: `${h.post_name} · ${h.site_name}${h.held_over_minutes ? ` · held over ${h.held_over_minutes} min` : ''}` });
  }

  // A coaching or warning the officer has not signed after a few days.
  // Supervisors' own records are for administrators only.
  const viewer = await db.prepare(`SELECT role FROM users WHERE id = ?`).get(userId);
  for (const r of (await unsignedOverdue()).filter((x) => x.officer_role === 'officer' || viewer?.role === ROLES.ADMIN)) {
    push({ key: `conduct:${r.id}`, kind: 'conduct', severity: 'info', at: r.created_at, link: `/admin/conduct?record=${r.id}`,
      title: `${r.officer} has not signed a ${r.level_label.toLowerCase()}`,
      detail: `${r.category_label} · issued ${r.occurred_on}. Go through it with them, or record that they refused.` });
  }

  // Money an officer spent and has claimed back.
  for (const c of await db
    .prepare(
      `SELECT c.id, c.created_at, c.amount_cents, c.category, u.first_name || ' ' || u.last_name AS officer
       FROM expense_claims c JOIN users u ON u.id = c.user_id
       WHERE c.status = 'pending' ORDER BY c.created_at LIMIT 25`
    )
    .all()) {
    push({ key: `expense:${c.id}`, kind: 'expense', severity: 'info', at: c.created_at, link: '/admin/expenses',
      title: `${c.officer} claimed $${(c.amount_cents / 100).toFixed(2)}`, detail: EXPENSE_CATEGORY_LABEL[c.category] || c.category });
  }

  // Overtime that reassigning a shift still to come could prevent.
  for (const o of (await overtimeWatch()).officers) {
    const t = o.tipping_shift;
    if (o.status !== 'over' || !t || t.already_over || new Date(t.starts_at) <= new Date()) continue;
    push({ key: `overtime:${o.user_id}:${t.shift_id}`, kind: 'overtime', severity: 'warning', at: new Date().toISOString(), link: '/admin/overtime',
      title: `${o.name} is heading into overtime`, detail: `${o.projected_hours}h this week · ${o.overtime_hours}h over from ${t.post_name}` });
  }

  // A holiday coming up with shifts nobody is booked on.
  for (const h of await holidayOutlook({ withinDays: HOLIDAY_ALERT_DAYS })) {
    if (h.open === 0) continue;
    const monday = parseDay(h.day);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    push({ key: `holiday-open:${h.day}`, kind: 'holiday', severity: h.days_away <= 3 ? 'critical' : 'warning', at: new Date().toISOString(),
      link: `/admin/schedule?week=${toDateString(monday)}`,
      title: `${h.open} open shift${h.open === 1 ? '' : 's'} on ${h.name}`,
      detail: `${h.days_away === 0 ? 'Today' : h.days_away === 1 ? 'Tomorrow' : `In ${h.days_away} days`} · ${h.assigned} of ${h.shifts} booked · pays ${h.pay_multiplier}x` });
  }

  // A client contact thanking an officer: worth passing on, so it is in the inbox for a week.
  for (const c of await db
    .prepare(
      `SELECT c.id, c.user_id, c.created_at, c.category, u.first_name || ' ' || u.last_name AS officer, cu.name AS client_name, s.name AS site_name
       FROM commendations c JOIN users u ON u.id = c.user_id JOIN client_users cu ON cu.id = c.client_user_id
       LEFT JOIN sites s ON s.id = c.site_id
       WHERE c.created_at > now() - interval '7 days'`
    )
    .all()) {
    push({ key: `commendation:${c.id}`, kind: 'commendation', severity: 'info', at: c.created_at, link: `/admin/employees/${c.user_id}#commendations`,
      title: `${c.client_name} commended ${c.officer}`, detail: `${COMMENDATION_LABEL[c.category] || c.category}${c.site_name ? ` · ${c.site_name}` : ''}` });
  }

  // An officer asking for one of their punches to be fixed.
  for (const c of await db
    .prepare(
      `SELECT c.id, c.created_at, c.proposed_clock_in_at, c.proposed_clock_out_at, u.first_name || ' ' || u.last_name AS officer,
              p.name AS post_name
       FROM time_corrections c JOIN users u ON u.id = c.user_id JOIN time_entries te ON te.id = c.time_entry_id
       JOIN posts p ON p.id = te.post_id
       WHERE c.status = 'pending' ORDER BY c.created_at LIMIT 25`
    )
    .all()) {
    const what = c.proposed_clock_in_at && c.proposed_clock_out_at ? 'clock-in and clock-out' : c.proposed_clock_in_at ? 'clock-in' : 'clock-out';
    push({ key: `correction:${c.id}`, kind: 'correction', severity: 'warning', at: c.created_at, link: '/admin/timesheets?view=corrections',
      title: `${c.officer} asked to correct a ${what}`, detail: c.post_name });
  }

  // A client's question about an invoice, waiting on us.
  for (const q of await db
    .prepare(
      `SELECT q.id, q.question, q.created_at, i.number, s.name AS site_name, c.name AS asked_by
       FROM invoice_queries q JOIN invoices i ON i.id = q.invoice_id JOIN sites s ON s.id = i.site_id
       LEFT JOIN client_users c ON c.id = q.client_user_id
       WHERE q.status = 'open' ORDER BY q.created_at LIMIT 25`
    )
    .all()) {
    push({ key: `invoice-query:${q.id}`, kind: 'invoice_query', severity: 'warning', at: q.created_at, link: '/admin/invoices?tab=questions',
      title: `Invoice question: ${q.number}`,
      detail: `${q.asked_by || 'Client'}, ${q.site_name} - ${q.question.length > 80 ? `${q.question.slice(0, 77)}...` : q.question}` });
  }

  // A client disputed a week's hours and has not had a reply.
  for (const d of await db
    .prepare(
      `SELECT h.id, h.week_start, h.note, h.decided_at, s.name AS site_name, c.name AS client_name
       FROM hours_signoffs h JOIN sites s ON s.id = h.site_id LEFT JOIN client_users c ON c.id = h.client_user_id
       WHERE h.status = 'disputed' AND h.response IS NULL ORDER BY h.decided_at LIMIT 25`
    )
    .all()) {
    const weekOf = String(d.week_start).slice(0, 10);
    push({ key: `signoff:${d.id}:${sqlToIso(d.decided_at)}`, kind: 'signoff', severity: 'warning', at: d.decided_at, link: '/admin/invoices?tab=signoff',
      title: `Hours disputed: ${d.site_name}, week of ${weekOf}`,
      detail: `${d.client_name || 'Client'} - ${d.note && d.note.length > 80 ? `${d.note.slice(0, 77)}...` : d.note || ''}` });
  }

  // A supervisor visit that found something wrong at the post.
  for (const v of await db
    .prepare(
      `SELECT v.id, v.visited_at, v.rating, v.uniform_ok, v.post_orders_reviewed, v.equipment_ok, v.site_secure,
              s.name AS site_name, p.name AS post_name, o.first_name || ' ' || o.last_name AS officer
       FROM supervisor_visits v LEFT JOIN sites s ON s.id = v.site_id LEFT JOIN posts p ON p.id = v.post_id
       LEFT JOIN users o ON o.id = v.officer_id
       WHERE v.visited_at >= ? AND (v.uniform_ok = false OR v.post_orders_reviewed = false OR v.equipment_ok = false
         OR v.site_secure = false OR v.rating <= 2)
       ORDER BY v.visited_at DESC LIMIT 25`
    )
    .all(since)) {
    const failed = VISIT_CHECKS.filter((c) => v[c.key] === false).map((c) => c.label.toLowerCase());
    push({ key: `visit:${v.id}`, kind: 'visit', severity: 'warning', at: v.visited_at, link: '/admin/visits?issues=1',
      title: `Visit found a problem: ${v.site_name || 'site'}`,
      detail: [v.post_name, v.officer, failed.length ? `failed: ${failed.join(', ')}` : `rated ${v.rating} of 5`].filter(Boolean).join(' · ') });
  }

  // A site nobody has visited for too long. The key carries the last visit, so
  // a new visit clears it and a later lapse raises it afresh.
  for (const site of (await visitBoard()).sites.filter((x) => x.due)) {
    push({ key: `visit-due:${site.id}:${site.last_visit ? site.last_visit.slice(0, 10) : 'never'}`, kind: 'visit_due', severity: 'info',
      at: site.last_visit || new Date().toISOString(), link: '/admin/visits',
      title: `Visit due: ${site.name}`,
      detail: site.last_visit ? `No supervisor visit for ${site.days_since} days` : 'No supervisor visit on record' });
  }

  // A follow-up on an incident that has gone past its due date.
  for (const a of await db
    .prepare(
      `SELECT a.id, a.title, a.due_on, i.ref_number, s.name AS site_name, o.first_name || ' ' || o.last_name AS owner
       FROM incident_actions a JOIN incidents i ON i.id = a.incident_id LEFT JOIN sites s ON s.id = i.site_id
       LEFT JOIN users o ON o.id = a.owner_id
       WHERE a.status = 'open' AND a.due_on < current_date ORDER BY a.due_on LIMIT 25`
    )
    .all()) {
    push({ key: `followup:${a.id}:${String(a.due_on).slice(0, 10)}`, kind: 'followup', severity: 'warning', at: a.due_on,
      link: '/admin/incidents?tab=follow-ups',
      title: `Follow-up overdue: ${a.title}`, detail: `${a.ref_number}${a.site_name ? `, ${a.site_name}` : ''}${a.owner ? ` · ${a.owner}` : ''}` });
  }

  // A client asking to change a post's orders.
  for (const r of await db
    .prepare(
      `SELECT r.id, r.created_at, p.name AS post_name, s.name AS site_name, c.name AS client_name
       FROM post_order_requests r JOIN posts p ON p.id = r.post_id JOIN sites s ON s.id = p.site_id
       LEFT JOIN client_users c ON c.id = r.client_user_id
       WHERE r.status = 'open' ORDER BY r.created_at`
    )
    .all()) {
    push({ key: `order-request:${r.id}`, kind: 'orders', severity: 'warning', at: r.created_at, link: '/admin/post-logs?tab=orders',
      title: `${r.client_name || 'A client'} asked to change the orders for ${r.post_name}`, detail: r.site_name });
  }

  const read = new Set(
    (await db.prepare(`SELECT alert_key FROM alert_reads WHERE user_id = ?`).all(userId)).map((r) => r.alert_key)
  );
  const rank = { critical: 0, warning: 1, info: 2 };
  return alerts
    .map((a) => ({ ...a, at: sqlToIso(a.at), read: read.has(a.key) }))
    .sort((a, b) => Number(a.read) - Number(b.read) || rank[a.severity] - rank[b.severity] || String(b.at).localeCompare(String(a.at)));
}
const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

adminRouter.get(
  '/alerts',
  wrap(async (req, res) => {
    const alerts = await buildAlerts(req.user.id);
    res.json({ alerts, unread: alerts.filter((a) => !a.read).length });
  })
);

adminRouter.post(
  '/alerts/read',
  wrap(async (req, res) => {
    const body = parse(
      z.object({ keys: z.array(z.string().max(120)).max(500).optional(), all: z.boolean().optional() }),
      req.body
    );
    const keys = body.all ? (await buildAlerts(req.user.id)).map((a) => a.key) : body.keys || [];
    if (!keys.length) throw new HttpError(422, 'Say which alerts to mark read.');
    for (const key of keys) {
      await db.prepare(`INSERT INTO alert_reads (user_id, alert_key) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(req.user.id, key);
    }
    const alerts = await buildAlerts(req.user.id);
    res.json({ unread: alerts.filter((a) => !a.read).length });
  })
);

/* ------------------------------------------------------- site health --- */

/**
 * Every site's month side by side, worst first, with the reasons spelled
 * out: shifts that went uncovered, checkpoints not scanned, serious
 * incidents, building issues left open and an unhappy client. The numbers
 * are the same ones the client sees in their monthly report.
 */
adminRouter.get(
  '/site-health',
  wrap(async (req, res) => {
    const month = req.query.month ? String(req.query.month) : monthKey();
    const sites = await db.prepare(`SELECT id, client_name FROM sites WHERE active = true ORDER BY name`).all();
    const visits = new Map((await visitBoard()).sites.map((v) => [v.id, v]));
    const rows = [];
    for (const site of sites) {
      const m = await siteMonth(site.id, month);
      const visit = visits.get(site.id);
      const serious = (m.incidents.bySeverity.high || 0) + (m.incidents.bySeverity.critical || 0);
      const concerns = [];
      if (m.coverage.pct !== null && m.coverage.pct < 95) concerns.push(`${m.coverage.scheduled - m.coverage.covered} shift${m.coverage.scheduled - m.coverage.covered === 1 ? '' : 's'} not covered`);
      if (m.patrols.pct !== null && m.patrols.pct < 90) concerns.push(`only ${m.patrols.pct}% of checkpoints scanned`);
      if (serious) concerns.push(`${serious} serious incident${serious === 1 ? '' : 's'}`);
      if (m.issues.open) concerns.push(`${m.issues.open} building issue${m.issues.open === 1 ? '' : 's'} open`);
      if (m.rating && m.rating.average <= 3) concerns.push(`client rated us ${m.rating.average} of 5`);
      if (visit?.due) concerns.push(visit.last_visit ? `no supervisor visit for ${visit.days_since} days` : 'never visited by a supervisor');
      // Out of 100: coverage and patrols carry most of it, the rest comes off for what went wrong.
      let score = 100;
      if (m.coverage.pct !== null) score -= Math.min(40, (100 - m.coverage.pct) * 2);
      if (m.patrols.pct !== null) score -= Math.min(25, (100 - m.patrols.pct));
      score -= Math.min(15, serious * 5) + Math.min(10, m.issues.open * 2);
      if (m.rating) score -= Math.min(10, Math.max(0, (4 - m.rating.average) * 5));
      rows.push({
        id: site.id, name: m.site.name, client_name: site.client_name, city: m.site.city,
        score: Math.max(0, Math.round(score)),
        coverage: m.coverage, patrols: m.patrols, incidents: { total: m.incidents.total, serious },
        issuesOpen: m.issues.open, visitors: m.visitors, rating: m.rating, concerns,
        supervisorVisits: m.supervisorVisits, lastVisit: visit?.last_visit ?? null, visitDue: Boolean(visit?.due),
      });
    }
    rows.sort((a, b) => a.score - b.score || b.concerns.length - a.concerns.length || a.name.localeCompare(b.name));
    res.json({ month, sites: rows, needAttention: rows.filter((r) => r.concerns.length).length });
  })
);

/** One site's month in full, as the client sees it. */
adminRouter.get(
  '/sites/:id/monthly',
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'site');
    res.json(await siteMonth(id, req.query.month ? String(req.query.month) : monthKey()));
  })
);
