import { Router } from 'express';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, isoFields, toDateString, sqlToIso, dateParam, idParam } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { splitOvertime, toHours, CONFIRM_AHEAD_DAYS } from '../shared.js';
import { confirmationOf, confirmShift, confirmable, withConfirmation } from '../services/confirmations.js';
import { toSql } from '../services/compliance.js';
import { loadPricedEntries, personPay } from '../services/payroll.js';
import { dayString } from '../services/payPeriods.js';

export const scheduleRouter = Router();
scheduleRouter.use(requireAuth);

/** The signed-in officer's own roster. */
scheduleRouter.get(
  '/',
  wrap(async (req, res) => {
    const from = dateParam(req.query.from, new Date(Date.now() - 7 * 86400000));
    const to = dateParam(req.query.to, new Date(Date.now() + 21 * 86400000));

    const shifts = (await db
      .prepare(
        `SELECT sh.*, p.name AS post_name, p.post_code, p.instructions,
                s.name AS site_name, s.address, s.city, s.state,
                te.clock_in_at, te.clock_out_at, te.minutes_worked, te.late_minutes
         FROM shifts sh
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         LEFT JOIN time_entries te ON te.shift_id = sh.id
         WHERE sh.user_id = ? AND sh.starts_at BETWEEN ? AND ?
         ORDER BY sh.starts_at`
      )
      .all(req.user.id, toSql(from), toSql(to)));

    res.json({
      shifts: shifts.map((s) => ({
        ...isoFields(withConfirmation(s), ['starts_at', 'ends_at', 'clock_in_at', 'clock_out_at', 'created_at']),
        confirmable: confirmable(s),
      })),
      range: { from: from.toISOString(), to: to.toISOString() },
      confirmAheadDays: CONFIRM_AHEAD_DAYS,
    });
  })
);

/** The officer confirms they will work one of their upcoming shifts. */
scheduleRouter.post(
  '/:id/confirm',
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'shift');
    const shift = await db
      .prepare(
        `SELECT sh.*, te.clock_in_at FROM shifts sh LEFT JOIN time_entries te ON te.shift_id = sh.id
         WHERE sh.id = ? AND sh.user_id = ?`
      )
      .get(id, req.user.id);
    if (!shift) throw new HttpError(404, 'That shift is not on your schedule.');
    if (!confirmable(shift)) {
      const starts = new Date(sqlToIso(shift.starts_at)).getTime();
      if (shift.status !== 'scheduled') throw new HttpError(409, 'That shift is no longer scheduled.');
      if (shift.clock_in_at || starts <= Date.now()) throw new HttpError(409, 'That shift has already started.');
      throw new HttpError(409, `Shifts can be confirmed up to ${CONFIRM_AHEAD_DAYS} days ahead.`);
    }
    const updated = await confirmShift(shift, { byUserId: req.user.id, method: 'app' });
    await audit(req.user.id, 'shift.confirmed', 'shift', id, { method: 'app' }, req.ip);
    res.json({ shift: { id, ...confirmationOf(updated) } });
  })
);

/** Hours summary the officer sees on their own profile. */
scheduleRouter.get(
  '/hours',
  wrap(async (req, res) => {
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

    const prevWeekStart = new Date(weekStart.getTime() - 7 * 86400000);
    const payPeriodStart = new Date(weekStart.getTime() - 7 * 86400000);

    const sumSince = async (start, end) =>
      (await db
        .prepare(
          `SELECT COALESCE(SUM(minutes_worked),0) AS minutes, COUNT(*) AS shifts
           FROM time_entries
           WHERE user_id = ? AND clock_in_at >= ? ${end ? 'AND clock_in_at < ?' : ''}`
        )
        .get(...(end ? [req.user.id, toSql(start), toSql(end)] : [req.user.id, toSql(start)])));

    const thisWeek = await sumSince(weekStart);
    const lastWeek = await sumSince(prevWeekStart, weekStart);
    const { regularMinutes, overtimeMinutes } = splitOvertime(thisWeek.minutes);

    const byDay = (await db
      .prepare(
        `SELECT date(clock_in_at) AS day, COALESCE(SUM(minutes_worked),0) AS minutes
         FROM time_entries WHERE user_id = ? AND clock_in_at >= ?
         GROUP BY date(clock_in_at) ORDER BY day`
      )
      .all(req.user.id, toSql(payPeriodStart)));

    const openFlags = (await db
      .prepare(`SELECT COUNT(*) AS n FROM flags WHERE user_id = ? AND resolved_at IS NULL`)
      .get(req.user.id)).n;

    res.json({
      thisWeek: {
        minutes: thisWeek.minutes,
        hours: toHours(thisWeek.minutes),
        shifts: thisWeek.shifts,
        regularHours: toHours(regularMinutes),
        overtimeHours: toHours(overtimeMinutes),
      },
      lastWeek: { minutes: lastWeek.minutes, hours: toHours(lastWeek.minutes), shifts: lastWeek.shifts },
      byDay: byDay.map((d) => ({ ...d, hours: toHours(d.minutes) })),
      openFlags,
    });
  })
);

/** An officer's own compliance record - they can see what they have been flagged for. */
scheduleRouter.get(
  '/my-flags',
  wrap(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT * FROM flags WHERE user_id = ? ORDER BY occurred_at DESC LIMIT 50`
      )
      .all(req.user.id));
    res.json({ flags: rows.map((r) => isoFields(r, ['occurred_at', 'resolved_at', 'created_at'])) });
  })
);

/**
 * What the signed-in person has been paid, and is earning this week.
 *
 * Closed pay periods come straight from the payroll lines frozen at close, so
 * an officer sees exactly what was approved. This week is an estimate from the
 * shared pricing, and says so.
 */
scheduleRouter.get(
  '/my-pay',
  wrap(async (req, res) => {
    const stubs = await db
      .prepare(
        `SELECT l.minutes, l.regular_minutes, l.overtime_minutes, l.regular_pay_cents, l.overtime_pay_cents,
                l.gross_cents, l.entries, l.sites, l.employment_type, l.pay_type,
                p.id AS period_id, p.period_start, p.period_end, p.closed_at,
                (SELECT COALESCE(SUM(e.amount_cents), 0) FROM expense_claims e
                 WHERE e.pay_period_id = p.id AND e.user_id = l.user_id) AS reimbursement_cents
         FROM pay_period_lines l JOIN pay_periods p ON p.id = l.pay_period_id
         WHERE l.user_id = ? AND p.status = 'closed'
         ORDER BY p.period_start DESC LIMIT 26`
      )
      .all(req.user.id);

    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const entries = await loadPricedEntries({ from: monday, to: new Date(), userId: req.user.id });
    const week = entries.length ? personPay(entries) : null;

    const u = req.user;
    const dollars = (c) => (c == null ? null : c / 100);
    res.json({
      basis: {
        employment_type: u.employment_type,
        pay_type: u.pay_type,
        pay_rate: dollars(u.pay_rate_cents),
        salary: dollars(u.salary_cents),
        overtime_multiplier: u.overtime_multiplier,
        earns_overtime: u.employment_type === 'w2' && !u.exempt && u.pay_type === 'hourly',
      },
      thisWeek: {
        from: toDateString(monday),
        shifts: entries.length,
        hours: toHours(week?.minutes || 0),
        overtime_hours: toHours(week?.overtimeMinutes || 0),
        estimated_pay: dollars(week?.payCents ?? 0),
      },
      stubs: stubs.map((s) => ({
        period_id: s.period_id,
        period_start: dayString(s.period_start),
        period_end: dayString(s.period_end),
        closed_at: sqlToIso(s.closed_at),
        shifts: s.entries,
        hours: toHours(s.minutes),
        regular_hours: toHours(s.regular_minutes),
        overtime_hours: toHours(s.overtime_minutes),
        regular_pay: dollars(s.regular_pay_cents),
        overtime_pay: dollars(s.overtime_pay_cents),
        gross_pay: dollars(s.gross_cents),
        reimbursements: dollars(Number(s.reimbursement_cents) || 0),
        sites: s.sites ? JSON.parse(s.sites) : [],
        employment_type: s.employment_type,
      })),
    });
  })
);
