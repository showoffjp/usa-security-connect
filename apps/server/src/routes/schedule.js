import { Router } from 'express';
import { db } from '../lib/db.js';
import { wrap, isoFields } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { splitOvertime, toHours } from '../shared.js';
import { toSql } from '../services/compliance.js';

export const scheduleRouter = Router();
scheduleRouter.use(requireAuth);

/** The signed-in officer's own roster. */
scheduleRouter.get(
  '/',
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 21 * 86400000);

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
      shifts: shifts.map((s) =>
        isoFields(s, ['starts_at', 'ends_at', 'clock_in_at', 'clock_out_at', 'created_at'])
      ),
      range: { from: from.toISOString(), to: to.toISOString() },
    });
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
