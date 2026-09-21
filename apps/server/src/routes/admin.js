import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, sqlToIso } from '../lib/http.js';
import { requireAuth, requireRole, hashPin, generatePin, generateEmployeeCode, publicUser } from '../lib/auth.js';
import {
  ROLES,
  EMPLOYEE_STATUS,
  FLAG_LABEL,
  splitOvertime,
  toHours,
  minutesBetween,
} from '../shared.js';
import { toSql, sweep } from '../services/compliance.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

const onlyAdmin = requireRole(ROLES.ADMIN);

/* =============================================================== dashboard === */

adminRouter.get(
  '/dashboard',
  wrap(async (req, res) => {
    sweep(); // never show a supervisor stale compliance numbers

    const onDuty = db
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
      .all();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const counts = {
      openFlags: db.prepare(`SELECT COUNT(*) AS n FROM flags WHERE resolved_at IS NULL`).get().n,
      openIncidents: db.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE status != 'closed'`).get().n,
      onDuty: onDuty.length,
      activeStaff: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`).get().n,
      shiftsToday: db
        .prepare(`SELECT COUNT(*) AS n FROM shifts WHERE date(starts_at) = date('now')`)
        .get().n,
      hoursToday: toHours(
        db
          .prepare(`SELECT COALESCE(SUM(minutes_worked),0) AS m FROM time_entries WHERE clock_in_at >= ?`)
          .get(toSql(todayStart)).m
      ),
    };

    const recentFlags = db
      .prepare(
        `SELECT f.*, u.employee_code, u.first_name || ' ' || u.last_name AS officer
         FROM flags f JOIN users u ON u.id = f.user_id
         WHERE f.resolved_at IS NULL
         ORDER BY f.occurred_at DESC LIMIT 15`
      )
      .all();

    const upcoming = db
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
      .all();

    const unfilled = db
      .prepare(
        `SELECT COUNT(*) AS n FROM shifts
         WHERE user_id IS NULL AND starts_at > datetime('now') AND status = 'scheduled'`
      )
      .get().n;

    res.json({
      counts: { ...counts, unfilledShifts: unfilled },
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

    const rows = db
      .prepare(
        `SELECT u.*, s.name AS default_site_name,
                (SELECT COUNT(*) FROM flags f WHERE f.user_id = u.id AND f.resolved_at IS NULL) AS open_flags,
                (SELECT COALESCE(SUM(minutes_worked),0) FROM time_entries te
                   WHERE te.user_id = u.id
                     AND te.clock_in_at >= datetime('now', 'weekday 1', '-7 days')) AS week_minutes,
                EXISTS(SELECT 1 FROM time_entries te WHERE te.user_id = u.id AND te.clock_out_at IS NULL) AS on_duty
         FROM users u
         LEFT JOIN sites s ON s.id = u.default_site_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY u.status, u.last_name, u.first_name`
      )
      .all(...params);

    res.json({
      employees: rows.map((u) => ({
        ...publicUser(isoFields(u, ['created_at', 'updated_at', 'last_login_at', 'pin_set_at'])),
        week_hours: toHours(u.week_minutes),
        on_duty: Boolean(u.on_duty),
      })),
    });
  })
);

const employeeSchema = z.object({
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
  defaultSiteId: z.number().int().positive().nullable().optional(),
  payRate: z.number().nonnegative().max(500).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

adminRouter.post(
  '/employees',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(employeeSchema, req.body);
    const code = body.employeeCode || generateEmployeeCode();

    if (db.prepare(`SELECT 1 FROM users WHERE employee_code = ?`).get(code)) {
      throw new HttpError(409, `Employee code ${code} is already in use.`, [
        { field: 'employeeCode', message: 'Already taken.' },
      ]);
    }

    // The starting PIN is generated here and shown to the admin exactly once.
    const pin = generatePin(4);
    const { hash, salt } = hashPin(pin);

    const info = db
      .prepare(
        `INSERT INTO users
         (employee_code, first_name, last_name, email, phone, role, status, hire_date,
          license_number, license_type, license_expires_on, emergency_contact_name,
          emergency_contact_phone, default_site_id, pay_rate_cents, notes,
          pin_hash, pin_salt, pin_set_at, must_change_pin)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),1)`
      )
      .run(
        code,
        body.firstName,
        body.lastName,
        body.email || null,
        body.phone || null,
        body.role,
        body.status,
        body.hireDate || null,
        body.licenseNumber || null,
        body.licenseType || null,
        body.licenseExpiresOn || null,
        body.emergencyContactName || null,
        body.emergencyContactPhone || null,
        body.defaultSiteId ?? null,
        body.payRate != null ? Math.round(body.payRate * 100) : null,
        body.notes || null,
        hash,
        salt
      );

    audit(req.user.id, 'employee.created', 'user', Number(info.lastInsertRowid), { code, role: body.role }, req.ip);

    res.status(201).json({
      employee: publicUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid)),
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
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
    if (!user) throw new HttpError(404, 'Employee not found.');

    const entries = db
      .prepare(
        `SELECT te.*, p.name AS post_name, s.name AS site_name
         FROM time_entries te
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE te.user_id = ? ORDER BY te.clock_in_at DESC LIMIT 60`
      )
      .all(user.id);

    const flags = db
      .prepare(`SELECT * FROM flags WHERE user_id = ? ORDER BY occurred_at DESC LIMIT 40`)
      .all(user.id);

    const shifts = db
      .prepare(
        `SELECT sh.*, p.name AS post_name, s.name AS site_name
         FROM shifts sh JOIN posts p ON p.id = sh.post_id JOIN sites s ON s.id = p.site_id
         WHERE sh.user_id = ? AND sh.starts_at > datetime('now','-7 days')
         ORDER BY sh.starts_at LIMIT 40`
      )
      .all(user.id);

    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(minutes_worked),0) AS minutes, COUNT(*) AS shifts,
                COALESCE(SUM(late_minutes > 0),0) AS late_count
         FROM time_entries WHERE user_id = ? AND clock_in_at >= datetime('now','-30 days')`
      )
      .get(user.id);

    res.json({
      employee: publicUser(isoFields(user, ['created_at', 'updated_at', 'last_login_at', 'pin_set_at'])),
      entries: entries.map((e) => isoFields(e, ['clock_in_at', 'clock_out_at', 'created_at'])),
      flags: flags.map((f) => ({ ...isoFields(f, ['occurred_at', 'resolved_at']), label: FLAG_LABEL[f.type] || f.type })),
      shifts: shifts.map((s) => isoFields(s, ['starts_at', 'ends_at'])),
      last30Days: {
        hours: toHours(totals.minutes),
        shifts: totals.shifts,
        lateCount: totals.late_count,
      },
    });
  })
);

adminRouter.patch(
  '/employees/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const body = parse(employeeSchema.partial(), req.body);
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
    if (!user) throw new HttpError(404, 'Employee not found.');

    // Never let the last administrator demote or disable themselves out of the system.
    const losingAdmin =
      user.role === ROLES.ADMIN &&
      ((body.role && body.role !== ROLES.ADMIN) || (body.status && body.status !== 'active'));
    if (losingAdmin) {
      const admins = db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'`)
        .get().n;
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
      defaultSiteId: 'default_site_id',
      notes: 'notes',
      employeeCode: 'employee_code',
    };

    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(map)) {
      if (body[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(body[key] === '' ? null : body[key]);
      }
    }
    if (body.payRate !== undefined) {
      sets.push('pay_rate_cents = ?');
      params.push(body.payRate == null ? null : Math.round(body.payRate * 100));
    }
    if (!sets.length) return res.json({ employee: publicUser(user) });

    sets.push(`updated_at = datetime('now')`);
    params.push(user.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    audit(req.user.id, 'employee.updated', 'user', user.id, Object.keys(body), req.ip);
    res.json({ employee: publicUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id)) });
  })
);

/** Issue a fresh PIN. Shown once, and the officer must change it at next sign-in. */
adminRouter.post(
  '/employees/:id/reset-pin',
  onlyAdmin,
  wrap(async (req, res) => {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
    if (!user) throw new HttpError(404, 'Employee not found.');

    const length = Number(req.body?.length) === 6 ? 6 : 4;
    const pin = generatePin(length);
    const { hash, salt } = hashPin(pin);

    db.prepare(
      `UPDATE users
       SET pin_hash = ?, pin_salt = ?, pin_set_at = datetime('now'),
           must_change_pin = 1, failed_attempts = 0, locked_until = NULL,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(hash, salt, user.id);

    audit(req.user.id, 'employee.pin_reset', 'user', user.id, null, req.ip);
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
    db.prepare(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?`).run(req.params.id);
    audit(req.user.id, 'employee.unlocked', 'user', Number(req.params.id), null, req.ip);
    res.json({ ok: true });
  })
);

/* ================================================================ schedule === */

adminRouter.get(
  '/shifts',
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 14 * 86400000);

    const rows = db
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
      );

    res.json({
      shifts: rows.map((s) => isoFields(s, ['starts_at', 'ends_at', 'clock_in_at', 'clock_out_at', 'created_at'])),
    });
  })
);

const shiftSchema = z
  .object({
    userId: z.number().int().positive().nullable().optional(),
    postId: z.number().int().positive(),
    startsAt: z.string().min(1),
    endsAt: z.string().min(1),
    notes: z.string().max(1000).optional(),
  })
  .refine((d) => new Date(d.endsAt) > new Date(d.startsAt), {
    message: 'The shift must end after it starts.',
    path: ['endsAt'],
  });

/** Reject a shift that overlaps one the officer already has. */
function assertNoOverlap({ userId, startsAt, endsAt, excludeShiftId }) {
  if (!userId) return;
  const clash = db
    .prepare(
      `SELECT sh.id, sh.starts_at, sh.ends_at, p.name AS post_name
       FROM shifts sh JOIN posts p ON p.id = sh.post_id
       WHERE sh.user_id = ? AND sh.status != 'cancelled'
         AND sh.starts_at < ? AND sh.ends_at > ?
         ${excludeShiftId ? 'AND sh.id != ?' : ''}
       LIMIT 1`
    )
    .get(userId, toSql(new Date(endsAt)), toSql(new Date(startsAt)), ...(excludeShiftId ? [excludeShiftId] : []));

  if (clash) {
    throw new HttpError(409, `That officer already has a shift at ${clash.post_name} covering this time.`, {
      conflictingShiftId: clash.id,
    });
  }
}

adminRouter.post(
  '/shifts',
  wrap(async (req, res) => {
    const body = parse(shiftSchema, req.body);
    assertNoOverlap(body);

    const info = db
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
      );

    audit(req.user.id, 'shift.created', 'shift', Number(info.lastInsertRowid), null, req.ip);
    res.status(201).json({ shift: isoFields(db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(info.lastInsertRowid), ['starts_at', 'ends_at']) });
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
        assertNoOverlap({ userId: body.userId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
      } catch (err) {
        if (body.skipConflicts) {
          skipped.push({ date: startsAt.toISOString().slice(0, 10), reason: err.message });
          continue;
        }
        throw err;
      }

      const info = db
        .prepare(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at, created_by) VALUES (?,?,?,?,?)`)
        .run(body.userId ?? null, body.postId, toSql(startsAt), toSql(endsAt), req.user.id);
      created.push(Number(info.lastInsertRowid));
    }

    audit(req.user.id, 'shift.bulk_created', 'shift', null, { count: created.length }, req.ip);
    res.status(201).json({ created: created.length, skipped });
  })
);

adminRouter.patch(
  '/shifts/:id',
  wrap(async (req, res) => {
    const body = parse(shiftSchema.partial(), req.body);
    const shift = db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(req.params.id);
    if (!shift) throw new HttpError(404, 'Shift not found.');

    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date(sqlToIso(shift.starts_at));
    const endsAt = body.endsAt ? new Date(body.endsAt) : new Date(sqlToIso(shift.ends_at));
    const userId = body.userId !== undefined ? body.userId : shift.user_id;

    if (endsAt <= startsAt) throw new HttpError(422, 'The shift must end after it starts.');
    assertNoOverlap({ userId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), excludeShiftId: shift.id });

    db.prepare(
      `UPDATE shifts SET user_id = ?, post_id = ?, starts_at = ?, ends_at = ?, notes = ?, status = ? WHERE id = ?`
    ).run(
      userId ?? null,
      body.postId ?? shift.post_id,
      toSql(startsAt),
      toSql(endsAt),
      body.notes !== undefined ? body.notes : shift.notes,
      req.body.status || shift.status,
      shift.id
    );

    audit(req.user.id, 'shift.updated', 'shift', shift.id, null, req.ip);
    res.json({ shift: isoFields(db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shift.id), ['starts_at', 'ends_at']) });
  })
);

adminRouter.delete(
  '/shifts/:id',
  wrap(async (req, res) => {
    const shift = db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(req.params.id);
    if (!shift) throw new HttpError(404, 'Shift not found.');
    // Keep any shift that has already been worked; cancel it instead of deleting.
    const worked = db.prepare(`SELECT 1 FROM time_entries WHERE shift_id = ?`).get(shift.id);
    if (worked) {
      db.prepare(`UPDATE shifts SET status = 'cancelled' WHERE id = ?`).run(shift.id);
      audit(req.user.id, 'shift.cancelled', 'shift', shift.id, null, req.ip);
      return res.json({ ok: true, cancelled: true });
    }
    db.prepare(`DELETE FROM shifts WHERE id = ?`).run(shift.id);
    audit(req.user.id, 'shift.deleted', 'shift', shift.id, null, req.ip);
    res.json({ ok: true, deleted: true });
  })
);

/* ============================================================== timesheets === */

adminRouter.get(
  '/timesheets',
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 14 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const rows = db
      .prepare(
        `SELECT u.id AS user_id, u.employee_code, u.first_name || ' ' || u.last_name AS officer,
                u.role, u.pay_rate_cents,
                COUNT(te.id) AS shifts,
                COALESCE(SUM(te.minutes_worked),0) AS minutes,
                COALESCE(SUM(CASE WHEN te.late_minutes > 0 THEN 1 ELSE 0 END),0) AS late_shifts,
                COALESCE(SUM(te.auto_closed),0) AS auto_closed,
                COALESCE(SUM(CASE WHEN te.clock_in_geofence = 'outside' THEN 1 ELSE 0 END),0) AS geofence_issues
         FROM users u
         LEFT JOIN time_entries te
           ON te.user_id = u.id AND te.clock_in_at BETWEEN ? AND ?
         WHERE u.status = 'active'
         GROUP BY u.id
         ORDER BY minutes DESC`
      )
      .all(toSql(from), toSql(to));

    const weeks = Math.max(1, Math.ceil((to - from) / (7 * 86400000)));

    res.json({
      range: { from: from.toISOString(), to: to.toISOString() },
      rows: rows.map((r) => {
        // Overtime is a weekly determination; for a multi-week range this is
        // the estimate shown in the summary, not a payroll-grade calculation.
        const { regularMinutes, overtimeMinutes } = splitOvertime(r.minutes, 40 * weeks);
        const hours = toHours(r.minutes);
        return {
          ...r,
          hours,
          regular_hours: toHours(regularMinutes),
          overtime_hours: toHours(overtimeMinutes),
          estimated_pay: r.pay_rate_cents
            ? Math.round(((regularMinutes / 60) * r.pay_rate_cents + (overtimeMinutes / 60) * r.pay_rate_cents * 1.5)) / 100
            : null,
        };
      }),
    });
  })
);

/** Every clock event in a range - the detail behind the timesheet totals. */
adminRouter.get(
  '/time-entries',
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const rows = db
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
      .all(toSql(from), toSql(to), ...(req.query.userId ? [Number(req.query.userId)] : []));

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
    const entry = db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(req.params.id);
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

    db.prepare(
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
    );

    audit(req.user.id, 'time_entry.adjusted', 'time_entry', entry.id, { reason: body.reason }, req.ip);
    res.json({ entry: isoFields(db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(entry.id), ['clock_in_at', 'clock_out_at']) });
  })
);

/* =================================================================== flags === */

adminRouter.get(
  '/flags',
  wrap(async (req, res) => {
    const resolved = req.query.resolved === 'true';
    const rows = db
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
      );

    res.json({
      flags: rows.map((f) => ({
        ...isoFields(f, ['occurred_at', 'resolved_at', 'created_at']),
        label: FLAG_LABEL[f.type] || f.type,
        detail: f.detail ? JSON.parse(f.detail) : null,
      })),
    });
  })
);

adminRouter.post(
  '/flags/:id/resolve',
  wrap(async (req, res) => {
    const note = String(req.body?.note || '').slice(0, 500);
    if (note.trim().length < 3) throw new HttpError(422, 'Add a short note explaining the outcome.');

    db.prepare(
      `UPDATE flags SET resolved_at = datetime('now'), resolved_by = ?, resolution_note = ? WHERE id = ?`
    ).run(req.user.id, note, req.params.id);

    audit(req.user.id, 'flag.resolved', 'flag', Number(req.params.id), { note }, req.ip);
    res.json({ ok: true });
  })
);

/* ========================================================== sites & posts === */

adminRouter.get(
  '/sites',
  wrap(async (_req, res) => {
    const sites = db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM posts p WHERE p.site_id = s.id AND p.active = 1) AS post_count
         FROM sites s ORDER BY s.active DESC, s.name`
      )
      .all();
    const posts = db
      .prepare(`SELECT p.*, s.name AS site_name FROM posts p JOIN sites s ON s.id = p.site_id ORDER BY s.name, p.name`)
      .all();
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
    const info = db
      .prepare(
        `INSERT INTO sites (name, client_name, address, city, state, postal_code, latitude, longitude, contact_name, contact_phone, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(b.name, b.clientName ?? null, b.address ?? null, b.city ?? null, b.state ?? 'FL',
           b.postalCode ?? null, b.latitude ?? null, b.longitude ?? null,
           b.contactName ?? null, b.contactPhone ?? null, b.active ? 1 : 0);
    res.status(201).json({ site: db.prepare(`SELECT * FROM sites WHERE id = ?`).get(info.lastInsertRowid) });
  })
);

const postSchema = z.object({
  siteId: z.number().int().positive(),
  name: z.string().trim().min(2).max(160),
  postCode: z.string().trim().max(40).optional(),
  instructions: z.string().max(5000).optional(),
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
    const info = db
      .prepare(
        `INSERT INTO posts (site_id, name, post_code, instructions, latitude, longitude,
                            geofence_radius_m, check_in_interval_min, requires_gps, armed, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(b.siteId, b.name, b.postCode ?? null, b.instructions ?? null, b.latitude ?? null, b.longitude ?? null,
           b.geofenceRadiusM, b.checkInIntervalMin, b.requiresGps ? 1 : 0, b.armed ? 1 : 0, b.active ? 1 : 0);
    res.status(201).json({ post: db.prepare(`SELECT * FROM posts WHERE id = ?`).get(info.lastInsertRowid) });
  })
);

adminRouter.patch(
  '/posts/:id',
  onlyAdmin,
  wrap(async (req, res) => {
    const b = parse(postSchema.partial(), req.body);
    const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(req.params.id);
    if (!post) throw new HttpError(404, 'Post not found.');

    const map = {
      name: 'name', postCode: 'post_code', instructions: 'instructions',
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
      db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    res.json({ post: db.prepare(`SELECT * FROM posts WHERE id = ?`).get(post.id) });
  })
);

/* =================================================================== tours === */

adminRouter.get(
  '/tours',
  wrap(async (_req, res) => {
    const tours = db
      .prepare(
        `SELECT t.*, s.name AS site_name,
                (SELECT COUNT(*) FROM checkpoints c WHERE c.tour_id = t.id) AS checkpoint_count
         FROM tours t JOIN sites s ON s.id = t.site_id ORDER BY s.name, t.name`
      )
      .all();
    res.json({ tours });
  })
);

adminRouter.get(
  '/tours/:id',
  wrap(async (req, res) => {
    const tour = db.prepare(`SELECT * FROM tours WHERE id = ?`).get(req.params.id);
    if (!tour) throw new HttpError(404, 'Tour not found.');
    const checkpoints = db.prepare(`SELECT * FROM checkpoints WHERE tour_id = ? ORDER BY sequence, id`).all(tour.id);
    const tasks = db
      .prepare(
        `SELECT ct.* FROM checkpoint_tasks ct
         JOIN checkpoints c ON c.id = ct.checkpoint_id
         WHERE c.tour_id = ? ORDER BY ct.sequence, ct.id`
      )
      .all(tour.id);
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
    const tourId = db.transaction(() => {
      const info = db
        .prepare(`INSERT INTO tours (site_id, name, description, expected_minutes) VALUES (?,?,?,?)`)
        .run(b.siteId, b.name, b.description ?? null, b.expectedMinutes ?? null);
      const id = Number(info.lastInsertRowid);

      b.checkpoints.forEach((cp, i) => {
        const cpInfo = db
          .prepare(
            `INSERT INTO checkpoints (tour_id, name, sequence, nfc_tag_id, qr_code, latitude, longitude, instructions, required)
             VALUES (?,?,?,?,?,?,?,?,?)`
          )
          .run(id, cp.name, i, cp.nfcTagId ?? null, cp.qrCode ?? null,
               cp.latitude ?? null, cp.longitude ?? null, cp.instructions ?? null, cp.required ? 1 : 0);
        cp.tasks.forEach((task, ti) => {
          db.prepare(`INSERT INTO checkpoint_tasks (checkpoint_id, label, sequence, required) VALUES (?,?,?,?)`)
            .run(Number(cpInfo.lastInsertRowid), task.label, ti, task.required ? 1 : 0);
        });
      });
      return id;
    })();

    audit(req.user.id, 'tour.created', 'tour', tourId, { name: b.name }, req.ip);
    res.status(201).json({ tourId });
  })
);

/** Completed walks, for proof-of-service reporting to the client. */
adminRouter.get(
  '/tour-runs',
  wrap(async (req, res) => {
    const rows = db
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
      .all(toSql(req.query.from ? new Date(req.query.from) : new Date(Date.now() - 14 * 86400000)));
    res.json({ runs: rows.map((r) => isoFields(r, ['started_at', 'completed_at'])) });
  })
);

/* =============================================================== audit log === */

adminRouter.get(
  '/audit',
  onlyAdmin,
  wrap(async (req, res) => {
    const rows = db
      .prepare(
        `SELECT a.*, u.employee_code, u.first_name || ' ' || u.last_name AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         ${req.query.action ? 'WHERE a.action LIKE ?' : ''}
         ORDER BY a.created_at DESC LIMIT 300`
      )
      .all(...(req.query.action ? [`${req.query.action}%`] : []));
    res.json({ entries: rows.map((r) => isoFields(r, ['created_at'])) });
  })
);

/** CSV export for payroll. */
adminRouter.get(
  '/export/timesheets.csv',
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 14 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const rows = db
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
      .all(toSql(from), toSql(to));

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

    audit(req.user.id, 'export.timesheets', null, null, { rows: rows.length }, req.ip);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usc-timesheets-${from.toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  })
);
