/**
 * The report centre.
 *
 * Every report here is built from the same rows the officer app writes -
 * time entries, shifts, check-ins, pings and flags - so a number in a report
 * is the same number the timesheet, the invoice and the live board show.
 *
 * Each report returns typed columns, rows and totals rather than a bespoke
 * shape, so the web app renders, sorts, totals and exports all of them with
 * one component, and CSV export is the same code as the screen.
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { HttpError, wrap, parseDay, toDateString, sqlToIso } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, EMPLOYMENT_TYPES, toHours, RULES, VISIT_CHECKS, VISIT_DUE_DAYS, CALL_TARGET_MINUTES } from '../shared.js';
import { visitBoard } from './visits.js';
import { callSelect, presentCall } from '../services/dispatch.js';
import { toSql } from '../services/compliance.js';
import { milesBetween, trips as vehicleTrips } from '../services/vehicles.js';
import { scope, loadPricedEntries as loadEntries, personPay, groupBy } from '../services/payroll.js';

export const adminReportsRouter = Router();
adminReportsRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));

export const REPORTS = [
  {
    id: 'hours-by-officer',
    title: 'Hours & pay by officer',
    description: 'Hours worked, regular and overtime, gross pay, billing and margin for every officer.',
    group: 'Payroll',
  },
  {
    id: 'payroll',
    title: 'Payroll register (W-2 & 1099)',
    description: 'One line per person per payroll week: overtime decided week by week, contractors listed with their paperwork.',
    group: 'Payroll',
  },
  {
    id: 'overtime',
    title: 'Overtime watch',
    description: 'Every payroll week where a W-2 officer went past forty hours, or is close to it, and what the premium cost.',
    group: 'Payroll',
  },
  {
    id: 'hours-by-site',
    title: 'Hours & margin by site',
    description: 'Hours delivered at every site and post, what they bill, what they cost, and the margin left.',
    group: 'Clients',
  },
  {
    id: 'officer-site',
    title: 'Where officers worked',
    description: 'Every officer and every site they worked at, with shifts, hours and the first and last day there.',
    group: 'Clients',
  },
  {
    id: 'daily',
    title: 'Daily hours',
    description: 'Hours, shifts, officers and billing for each day in the range.',
    group: 'Clients',
  },
  {
    id: 'attendance',
    title: 'Attendance & punctuality',
    description: 'Scheduled against worked, no-shows, late arrivals, early departures and missed check-ins per officer.',
    group: 'Compliance',
  },
  {
    id: 'gps',
    title: 'GPS & geofence compliance',
    description: 'How much of each shift was spent inside the post geofence, clock-ins from outside, and walk-offs.',
    group: 'Compliance',
  },
  {
    id: 'visits-by-site',
    title: 'Supervisor visits by site',
    description: 'How often a field supervisor was at each site, what the visits found, and which sites have gone longest without one.',
    group: 'Compliance',
  },
  {
    id: 'incidents-by-site',
    title: 'Incidents by site',
    description: 'How many incidents each site had, how serious, how many brought the police, and how many are still open.',
    group: 'Incidents',
  },
  {
    id: 'incidents-by-category',
    title: 'Incidents by type',
    description: 'What kinds of incident happen, how serious they tend to be, and how long they take to close.',
    group: 'Incidents',
  },
  {
    id: 'incidents-daily',
    title: 'Incidents by day',
    description: 'Incidents reported each day in the range, and how many were serious, to spot a bad week or a pattern.',
    group: 'Incidents',
  },
  {
    id: 'agreement-hours',
    title: 'Hours against agreements',
    description: 'For each site with a service agreement: the hours it pays for over the range, the hours worked, and the difference.',
    group: 'Clients',
  },
  {
    id: 'calls-by-site',
    title: 'Call response times by site',
    description: 'Calls for service at each site, how fast an officer was on scene, and how many were inside the target for their priority.',
    group: 'Dispatch',
  },
  {
    id: 'vehicle-mileage',
    title: 'Patrol vehicle mileage',
    description: 'Miles each patrol vehicle covered over the range, from the odometer readings at each check, with trips, checks and defects raised.',
    group: 'Dispatch',
  },
];

const C = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const dollars = (cents) => (cents == null ? null : Math.round(cents) / 100);
const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
const classLabel = (t) => (t === '1099' ? '1099' : 'W-2');

/* --------------------------------------------------------------- filters -- */

function readFilters(query) {
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 13);

  const from = parseDay(query.from || toDateString(defaultFrom));
  const toDay = parseDay(query.to);
  if (!from || !toDay) throw new HttpError(422, 'Use dates like 2026-09-25.');
  const to = new Date(toDay);
  to.setDate(to.getDate() + 1);
  if (to <= from) throw new HttpError(422, 'The end date is before the start date.');
  if ((to - from) / 86400000 > 370) throw new HttpError(422, 'Pick at most a year at a time.');

  const int = (v, what) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(422, `Unknown ${what}.`);
    return n;
  };
  const employmentType = query.employmentType || null;
  if (employmentType && !EMPLOYMENT_TYPES.includes(employmentType)) {
    throw new HttpError(422, 'Classification must be w2 or 1099.');
  }

  return {
    from,
    to,
    toDay,
    siteId: int(query.siteId, 'site'),
    userId: int(query.userId, 'officer'),
    employmentType,
  };
}

function sumColumns(rows, columns) {
  const totals = {};
  for (const c of columns) {
    if (c.sum) totals[c.key] = Math.round(rows.reduce((n, r) => n + (Number(r[c.key]) || 0), 0) * 100) / 100;
  }
  return totals;
}

/* --------------------------------------------------------------- reports -- */

const builders = {
  async 'hours-by-officer'(f) {
    const entries = await loadEntries(f);
    const rows = [];
    for (const [, list] of groupBy(entries, 'user_id')) {
      const first = list[0];
      const pay = personPay(list);
      const billed = list.reduce((n, e) => n + e.billed_cents, 0);
      const sites = groupBy(list, 'site_name');
      const top = [...sites.entries()].sort(
        (a, b) => b[1].reduce((n, e) => n + e.paid_minutes, 0) - a[1].reduce((n, e) => n + e.paid_minutes, 0)
      )[0];
      rows.push({
        user_id: first.user_id,
        employee_code: first.employee_code,
        officer: first.officer,
        classification: classLabel(first.employment_type),
        pay_type: first.pay_type,
        pay_rate: dollars(list[list.length - 1].pay_rate_cents),
        shifts: list.length,
        hours: toHours(pay.minutes),
        regular_hours: toHours(pay.regularMinutes),
        overtime_hours: toHours(pay.overtimeMinutes),
        gross_pay: dollars(pay.payCents),
        billed: dollars(billed),
        margin: pay.payCents != null ? dollars(billed - pay.payCents) : null,
        margin_percent: pay.payCents != null ? pct(billed - pay.payCents, billed) : null,
        sites: sites.size,
        main_site: top?.[0] ?? null,
        late_arrivals: list.filter((e) => e.late_minutes > 0).length,
      });
    }
    rows.sort((a, b) => b.hours - a.hours);
    const columns = [
      C('employee_code', 'Code'),
      C('officer', 'Officer', 'text', { link: 'user_id' }),
      C('classification', 'Class'),
      C('pay_rate', 'Rate', 'rate'),
      C('shifts', 'Shifts', 'int', { sum: true }),
      C('hours', 'Hours', 'hours', { sum: true, bar: true }),
      C('regular_hours', 'Regular', 'hours', { sum: true }),
      C('overtime_hours', 'Overtime', 'hours', { sum: true, warnAbove: 0 }),
      C('gross_pay', 'Gross pay', 'money', { sum: true }),
      C('billed', 'Billed', 'money', { sum: true }),
      C('margin', 'Margin', 'money', { sum: true }),
      C('margin_percent', 'Margin %', 'percent'),
      C('sites', 'Sites', 'int'),
      C('main_site', 'Main site'),
      C('late_arrivals', 'Late', 'int', { sum: true, warnAbove: 0 }),
    ];
    const totals = sumColumns(rows, columns);
    totals.margin_percent = pct(totals.margin, totals.billed);
    const w2 = rows.filter((r) => r.classification === 'W-2');
    const c1099 = rows.filter((r) => r.classification === '1099');
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Hours worked', value: totals.hours, type: 'hours' },
        { label: 'Overtime hours', value: totals.overtime_hours, type: 'hours' },
        { label: 'W-2 gross pay', value: w2.reduce((n, r) => n + (r.gross_pay || 0), 0), type: 'money' },
        { label: '1099 payments', value: c1099.reduce((n, r) => n + (r.gross_pay || 0), 0), type: 'money' },
        { label: 'Billed', value: totals.billed, type: 'money' },
        { label: 'Margin', value: totals.margin_percent, type: 'percent' },
      ],
      chart: { label: 'officer', value: 'hours', type: 'hours' },
      notes: [
        'Overtime is decided per payroll week (Monday to Sunday). A range that starts or ends mid-week counts only the hours inside it.',
        'Each hour is paid at the rate in effect on the day it was worked, from the rate history - a raise does not reprice earlier weeks.',
        '1099 contractors are paid straight time for every hour; W-2 exempt and salaried staff earn no overtime.',
        'Unpaid meal breaks are deducted before pay and billing. Shifts still in progress are not included until the officer clocks out.',
      ],
    };
  },

  async payroll(f) {
    const entries = await loadEntries(f);
    const rows = [];
    for (const [, list] of groupBy(entries, (e) => `${e.user_id}|${e.week}`)) {
      const first = list[0];
      const pay = personPay(list);
      const w2 = first.employment_type === 'w2';
      rows.push({
        week: first.week,
        user_id: first.user_id,
        employee_code: first.employee_code,
        officer: first.officer,
        classification: classLabel(first.employment_type),
        pay_type: first.pay_type,
        shifts: list.length,
        regular_hours: toHours(pay.regularMinutes),
        overtime_hours: toHours(pay.overtimeMinutes),
        pay_rate: dollars(list[list.length - 1].pay_rate_cents),
        overtime_rate:
          pay.earnsOvertime && list[list.length - 1].pay_rate_cents != null
            ? dollars(list[list.length - 1].pay_rate_cents * (list[list.length - 1].overtime_multiplier || 1.5))
            : null,
        gross_pay: dollars(pay.payCents),
        payee: w2 ? null : first.business_name || first.officer,
        tax_id: w2 ? null : first.tax_id_last4 ? `***-**-${first.tax_id_last4}` : 'missing',
        w9: w2 ? null : first.w9_on_file ? 'On file' : 'MISSING',
      });
    }
    rows.sort((a, b) => a.week.localeCompare(b.week) || a.classification.localeCompare(b.classification) || a.officer.localeCompare(b.officer));
    const columns = [
      C('week', 'Week of', 'date'),
      C('employee_code', 'Code'),
      C('officer', 'Name', 'text', { link: 'user_id' }),
      C('classification', 'Class'),
      C('pay_type', 'Basis'),
      C('shifts', 'Shifts', 'int', { sum: true }),
      C('regular_hours', 'Regular hrs', 'hours', { sum: true }),
      C('overtime_hours', 'OT hrs', 'hours', { sum: true, warnAbove: 0 }),
      C('pay_rate', 'Rate', 'rate'),
      C('overtime_rate', 'OT rate', 'rate'),
      C('gross_pay', 'Gross', 'money', { sum: true }),
      C('payee', '1099 payee'),
      C('tax_id', 'TIN'),
      C('w9', 'W-9'),
    ];
    const w2Rows = rows.filter((r) => r.classification === 'W-2');
    const cRows = rows.filter((r) => r.classification === '1099');
    const otPremium = w2Rows.reduce(
      (n, r) => n + (r.overtime_rate != null ? r.overtime_hours * (r.overtime_rate - r.pay_rate) : 0),
      0
    );
    return {
      columns,
      rows,
      totals: sumColumns(rows, columns),
      summary: [
        { label: 'W-2 gross', value: w2Rows.reduce((n, r) => n + (r.gross_pay || 0), 0), type: 'money' },
        { label: 'W-2 people', value: new Set(w2Rows.map((r) => r.user_id)).size, type: 'int' },
        { label: '1099 payments', value: cRows.reduce((n, r) => n + (r.gross_pay || 0), 0), type: 'money' },
        { label: '1099 payees', value: new Set(cRows.map((r) => r.user_id)).size, type: 'int' },
        { label: 'Overtime hours', value: w2Rows.reduce((n, r) => n + r.overtime_hours, 0), type: 'hours' },
        { label: 'Overtime premium', value: Math.round(otPremium * 100) / 100, type: 'money' },
      ],
      notes: [
        'A planning figure: your payroll provider remains the source of truth for withholding and taxes.',
        'Contractors are paid against their invoice. A 1099 row with a missing W-9 should not be paid until one is on file.',
        'Salaried staff show their salary for the period once, not per week.',
      ],
    };
  },

  async overtime(f) {
    const entries = (await loadEntries(f)).filter((e) => e.employment_type === 'w2');
    const rows = [];
    const threshold = RULES.overtimeWeeklyHours * 60;
    for (const [, list] of groupBy(entries, (e) => `${e.user_id}|${e.week}`)) {
      const first = list[0];
      const minutes = list.reduce((n, e) => n + e.paid_minutes, 0);
      if (minutes < threshold - 4 * 60) continue;
      const pay = personPay(list);
      const premium =
        pay.earnsOvertime && list[list.length - 1].pay_rate_cents != null
          ? (pay.overtimeMinutes / 60) * list[list.length - 1].pay_rate_cents * ((list[list.length - 1].overtime_multiplier || 1.5) - 1)
          : 0;
      rows.push({
        week: first.week,
        user_id: first.user_id,
        officer: first.officer,
        employee_code: first.employee_code,
        shifts: list.length,
        hours: toHours(minutes),
        overtime_hours: toHours(pay.overtimeMinutes),
        status: pay.overtimeMinutes > 0 ? (pay.earnsOvertime ? 'Overtime' : 'Over 40 (exempt)') : 'Within 4h of 40',
        premium: dollars(premium),
        sites: [...new Set(list.map((e) => e.site_name))].join(', '),
      });
    }
    rows.sort((a, b) => b.overtime_hours - a.overtime_hours || b.hours - a.hours);
    const columns = [
      C('week', 'Week of', 'date'),
      C('officer', 'Officer', 'text', { link: 'user_id' }),
      C('employee_code', 'Code'),
      C('shifts', 'Shifts', 'int', { sum: true }),
      C('hours', 'Hours', 'hours', { sum: true, bar: true }),
      C('overtime_hours', 'Overtime', 'hours', { sum: true, warnAbove: 0 }),
      C('premium', 'OT premium', 'money', { sum: true }),
      C('status', 'Status'),
      C('sites', 'Sites worked'),
    ];
    const totals = sumColumns(rows, columns);
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Weeks over 40h', value: rows.filter((r) => r.overtime_hours > 0).length, type: 'int' },
        { label: 'Weeks within 4h', value: rows.filter((r) => r.overtime_hours === 0).length, type: 'int' },
        { label: 'Overtime hours', value: totals.overtime_hours, type: 'hours' },
        { label: 'Premium paid', value: totals.premium, type: 'money' },
      ],
      notes: [
        'The premium is only the extra half (or whatever the multiplier is) on overtime hours - the straight-time part is in the payroll register.',
        '1099 contractors are left out: they are not owed overtime.',
      ],
    };
  },

  async 'hours-by-site'(f) {
    const entries = await loadEntries(f);
    const rows = [];
    for (const [, list] of groupBy(entries, 'post_id')) {
      const first = list[0];
      const minutes = list.reduce((n, e) => n + e.paid_minutes, 0);
      const billed = list.reduce((n, e) => n + e.billed_cents, 0);
      const cost = list.reduce((n, e) => n + e.base_cost_cents, 0);
      rows.push({
        site_id: first.site_id,
        client: first.client_name,
        site: first.site_name,
        post: first.post_name,
        post_code: first.post_code,
        shifts: list.length,
        officers: new Set(list.map((e) => e.user_id)).size,
        hours: toHours(minutes),
        bill_rate: dollars(first.post_bill_cents),
        billed: dollars(billed),
        labor_cost: dollars(cost),
        margin: dollars(billed - cost),
        margin_percent: pct(billed - cost, billed),
      });
    }
    rows.sort((a, b) => a.site.localeCompare(b.site) || b.hours - a.hours);
    const columns = [
      C('client', 'Client'),
      C('site', 'Site'),
      C('post', 'Post'),
      C('post_code', 'Code'),
      C('shifts', 'Shifts', 'int', { sum: true }),
      C('officers', 'Officers', 'int'),
      C('hours', 'Hours', 'hours', { sum: true, bar: true }),
      C('bill_rate', 'Bill rate', 'rate'),
      C('billed', 'Billed', 'money', { sum: true }),
      C('labor_cost', 'Labor cost', 'money', { sum: true }),
      C('margin', 'Margin', 'money', { sum: true }),
      C('margin_percent', 'Margin %', 'percent'),
    ];
    const totals = sumColumns(rows, columns);
    totals.margin_percent = pct(totals.margin, totals.billed);
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Sites', value: new Set(rows.map((r) => r.site_id)).size, type: 'int' },
        { label: 'Hours delivered', value: totals.hours, type: 'hours' },
        { label: 'Billed', value: totals.billed, type: 'money' },
        { label: 'Labor cost', value: totals.labor_cost, type: 'money' },
        { label: 'Margin', value: totals.margin_percent, type: 'percent' },
      ],
      chart: { label: 'site', value: 'hours', type: 'hours', aggregate: true },
      notes: [
        'Labor cost is base pay only. The overtime premium belongs to the officer’s week rather than to any one site, so it appears in the payroll reports.',
        'Billing uses the shift’s own rate where one was agreed, then the post’s standing rate, then the officer’s.',
      ],
    };
  },

  async 'officer-site'(f) {
    const entries = await loadEntries(f);
    const rows = [];
    for (const [, list] of groupBy(entries, (e) => `${e.user_id}|${e.post_id}`)) {
      const first = list[0];
      rows.push({
        user_id: first.user_id,
        officer: first.officer,
        employee_code: first.employee_code,
        classification: classLabel(first.employment_type),
        site: first.site_name,
        city: first.city,
        post: first.post_name,
        shifts: list.length,
        hours: toHours(list.reduce((n, e) => n + e.paid_minutes, 0)),
        first_day: list[0].day,
        last_day: list[list.length - 1].day,
      });
    }
    rows.sort((a, b) => a.officer.localeCompare(b.officer) || b.hours - a.hours);
    const columns = [
      C('officer', 'Officer', 'text', { link: 'user_id' }),
      C('employee_code', 'Code'),
      C('classification', 'Class'),
      C('site', 'Site'),
      C('city', 'City'),
      C('post', 'Post'),
      C('shifts', 'Shifts', 'int', { sum: true }),
      C('hours', 'Hours', 'hours', { sum: true, bar: true }),
      C('first_day', 'First day', 'date'),
      C('last_day', 'Last day', 'date'),
    ];
    return {
      columns,
      rows,
      totals: sumColumns(rows, columns),
      summary: [
        { label: 'Officers', value: new Set(rows.map((r) => r.user_id)).size, type: 'int' },
        { label: 'Sites', value: new Set(rows.map((r) => r.site)).size, type: 'int' },
        {
          label: 'Worked 2+ sites',
          value: [...groupBy(rows, 'user_id').values()].filter((l) => new Set(l.map((r) => r.site)).size > 1).length,
          type: 'int',
        },
        { label: 'Hours', value: rows.reduce((n, r) => n + r.hours, 0), type: 'hours' },
      ],
      notes: ['One row per officer per post. Use the officer filter to see a single person’s footprint.'],
    };
  },

  async daily(f) {
    const entries = await loadEntries(f);
    const byDay = groupBy(entries, 'day');
    const rows = [];
    for (let d = new Date(f.from); d < f.to; d.setDate(d.getDate() + 1)) {
      const key = toDateString(d);
      const list = byDay.get(key) || [];
      rows.push({
        day: key,
        weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
        shifts: list.length,
        officers: new Set(list.map((e) => e.user_id)).size,
        sites: new Set(list.map((e) => e.site_id)).size,
        hours: toHours(list.reduce((n, e) => n + e.paid_minutes, 0)),
        billed: dollars(list.reduce((n, e) => n + e.billed_cents, 0)),
        labor_cost: dollars(list.reduce((n, e) => n + e.base_cost_cents, 0)),
        late: list.filter((e) => e.late_minutes > 0).length,
      });
    }
    const columns = [
      C('day', 'Date', 'date'),
      C('weekday', 'Day'),
      C('shifts', 'Shifts', 'int', { sum: true }),
      C('officers', 'Officers', 'int'),
      C('sites', 'Sites', 'int'),
      C('hours', 'Hours', 'hours', { sum: true, bar: true }),
      C('billed', 'Billed', 'money', { sum: true }),
      C('labor_cost', 'Labor cost', 'money', { sum: true }),
      C('late', 'Late arrivals', 'int', { sum: true, warnAbove: 0 }),
    ];
    const totals = sumColumns(rows, columns);
    const worked = rows.filter((r) => r.shifts > 0);
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Hours', value: totals.hours, type: 'hours' },
        { label: 'Average per day', value: worked.length ? Math.round((totals.hours / worked.length) * 100) / 100 : 0, type: 'hours' },
        { label: 'Busiest day', value: worked.length ? [...worked].sort((a, b) => b.hours - a.hours)[0].day : '--', type: 'date' },
        { label: 'Billed', value: totals.billed, type: 'money' },
      ],
      chart: { label: 'day', value: 'hours', type: 'hours', series: 'time' },
      notes: ['A shift is counted on the day it started, so an overnight shift sits on its first day.'],
    };
  },

  async attendance(f) {
    const sc = scope(f);
    const scheduled = await db
      .prepare(
        `SELECT sh.id, sh.user_id, sh.status, sh.starts_at,
                u.employee_code, u.first_name || ' ' || u.last_name AS officer, u.employment_type
         FROM shifts sh
         JOIN users u ON u.id = sh.user_id
         JOIN posts p ON p.id = sh.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE sh.starts_at >= ? AND sh.starts_at < ? AND sh.starts_at < now()
           AND sh.status != 'cancelled' ${sc.sql}`
      )
      .all(toSql(f.from), toSql(f.to), ...sc.params);

    const entries = await loadEntries(f);
    const flags = await db
      .prepare(
        `SELECT f.user_id, f.type, COUNT(*) AS n
         FROM flags f JOIN users u ON u.id = f.user_id
         WHERE f.occurred_at >= ? AND f.occurred_at < ?
           AND f.type IN ('early_departure','off_post','missed_clock_out')
           ${f.userId ? 'AND f.user_id = ?' : ''} ${f.employmentType ? 'AND u.employment_type = ?' : ''}
         GROUP BY f.user_id, f.type`
      )
      .all(
        toSql(f.from),
        toSql(f.to),
        ...(f.userId ? [f.userId] : []),
        ...(f.employmentType ? [f.employmentType] : [])
      );
    const flagCount = (uid, type) => Number(flags.find((x) => x.user_id === uid && x.type === type)?.n || 0);

    const checks = await db
      .prepare(
        `SELECT sc.user_id,
                SUM(CASE WHEN sc.status = 'missed' THEN 1 ELSE 0 END) AS missed,
                SUM(CASE WHEN sc.status IN ('ok','late') THEN 1 ELSE 0 END) AS answered
         FROM status_checks sc
         JOIN time_entries te ON te.id = sc.time_entry_id
         JOIN users u ON u.id = te.user_id
         JOIN posts p ON p.id = te.post_id
         JOIN sites s ON s.id = p.site_id
         WHERE sc.due_at >= ? AND sc.due_at < ? ${sc.sql}
         GROUP BY sc.user_id`
      )
      .all(toSql(f.from), toSql(f.to), ...sc.params);
    const checksBy = new Map(checks.map((c) => [c.user_id, c]));

    const people = new Map();
    const touch = (r) => {
      if (!people.has(r.user_id)) {
        people.set(r.user_id, {
          user_id: r.user_id,
          employee_code: r.employee_code,
          officer: r.officer,
          classification: classLabel(r.employment_type),
          scheduled: 0,
          worked: 0,
          no_shows: 0,
          late: 0,
          late_minutes: 0,
        });
      }
      return people.get(r.user_id);
    };
    for (const s of scheduled) {
      const p = touch(s);
      p.scheduled += 1;
      if (s.status === 'missed') p.no_shows += 1;
    }
    for (const e of entries) {
      const p = touch(e);
      p.worked += 1;
      if (e.late_minutes > 0) {
        p.late += 1;
        p.late_minutes += e.late_minutes;
      }
    }

    const rows = [...people.values()].map((p) => {
      const c = checksBy.get(p.user_id) || { missed: 0, answered: 0 };
      const missed = Number(c.missed) || 0;
      const answered = Number(c.answered) || 0;
      return {
        ...p,
        avg_late: p.late ? Math.round(p.late_minutes / p.late) : 0,
        early_departures: flagCount(p.user_id, 'early_departure'),
        missed_clock_outs: flagCount(p.user_id, 'missed_clock_out'),
        off_post: flagCount(p.user_id, 'off_post'),
        checks_answered: answered,
        checks_missed: missed,
        check_rate: pct(answered, answered + missed),
        punctuality: pct(p.worked - p.late, p.worked),
        attendance: pct(p.scheduled - p.no_shows, p.scheduled),
      };
    });
    rows.sort((a, b) => (a.punctuality ?? 101) - (b.punctuality ?? 101) || b.no_shows - a.no_shows);

    const columns = [
      C('employee_code', 'Code'),
      C('officer', 'Officer', 'text', { link: 'user_id' }),
      C('classification', 'Class'),
      C('scheduled', 'Scheduled', 'int', { sum: true }),
      C('worked', 'Worked', 'int', { sum: true }),
      C('no_shows', 'No-shows', 'int', { sum: true, warnAbove: 0 }),
      C('late', 'Late', 'int', { sum: true, warnAbove: 0 }),
      C('avg_late', 'Avg late (min)', 'int'),
      C('early_departures', 'Left early', 'int', { sum: true, warnAbove: 0 }),
      C('missed_clock_outs', 'No clock-out', 'int', { sum: true, warnAbove: 0 }),
      C('checks_missed', 'Missed checks', 'int', { sum: true, warnAbove: 0 }),
      C('check_rate', 'Check-in rate', 'percent'),
      C('punctuality', 'On time', 'percent'),
      C('attendance', 'Attendance', 'percent'),
    ];
    const totals = sumColumns(rows, columns);
    totals.punctuality = pct(totals.worked - totals.late, totals.worked);
    totals.attendance = pct(totals.scheduled - totals.no_shows, totals.scheduled);
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'On time', value: totals.punctuality, type: 'percent' },
        { label: 'Attendance', value: totals.attendance, type: 'percent' },
        { label: 'No-shows', value: totals.no_shows, type: 'int' },
        { label: 'Late arrivals', value: totals.late, type: 'int' },
        { label: 'Missed check-ins', value: totals.checks_missed, type: 'int' },
      ],
      notes: [
        `Late means clocked in more than ${RULES.lateGraceMinutes} minutes after the scheduled start. A no-show is a shift with no clock-in ${RULES.noShowMinutes} minutes after it started.`,
        'Sorted worst first, so the conversations that need having are at the top.',
      ],
    };
  },

  async gps(f) {
    const sc = scope(f);
    const pings = await db
      .prepare(
        `SELECT lp.user_id, u.employee_code, u.first_name || ' ' || u.last_name AS officer,
                COUNT(*) AS pings,
                SUM(CASE WHEN lp.geofence = 'inside' THEN 1 ELSE 0 END) AS inside,
                SUM(CASE WHEN lp.geofence = 'outside' THEN 1 ELSE 0 END) AS outside,
                MAX(lp.distance_m) AS max_distance,
                MAX(lp.recorded_at) AS last_ping
         FROM location_pings lp
         JOIN users u ON u.id = lp.user_id
         LEFT JOIN posts p ON p.id = lp.post_id
         LEFT JOIN sites s ON s.id = p.site_id
         WHERE lp.recorded_at >= ? AND lp.recorded_at < ? ${sc.sql}
         GROUP BY lp.user_id, u.employee_code, u.first_name, u.last_name`
      )
      .all(toSql(f.from), toSql(f.to), ...sc.params);
    const pingsBy = new Map(pings.map((p) => [p.user_id, p]));

    const entries = await loadEntries(f);
    const offPost = await db
      .prepare(
        `SELECT user_id, COUNT(*) AS n FROM flags
         WHERE type = 'off_post' AND occurred_at >= ? AND occurred_at < ? GROUP BY user_id`
      )
      .all(toSql(f.from), toSql(f.to));
    const offBy = new Map(offPost.map((o) => [o.user_id, Number(o.n)]));

    const ids = new Set([...pingsBy.keys(), ...entries.map((e) => e.user_id)]);
    const rows = [];
    for (const uid of ids) {
      const p = pingsBy.get(uid);
      const list = entries.filter((e) => e.user_id === uid);
      const first = list[0] || p;
      const judged = p ? Number(p.inside) + Number(p.outside) : 0;
      const measured = list.filter((e) => e.clock_in_distance_m != null);
      rows.push({
        user_id: uid,
        employee_code: first.employee_code,
        officer: first.officer,
        shifts: list.length,
        pings: p ? Number(p.pings) : 0,
        inside_percent: p ? pct(Number(p.inside), judged) : null,
        off_post_events: offBy.get(uid) || 0,
        clock_ins_outside: list.filter((e) => e.clock_in_geofence === 'outside').length,
        avg_clock_in_distance: measured.length
          ? Math.round(measured.reduce((n, e) => n + e.clock_in_distance_m, 0) / measured.length)
          : null,
        max_distance: p ? Number(p.max_distance) || 0 : null,
        last_ping: p ? sqlToIso(p.last_ping) : null,
      });
    }
    rows.sort((a, b) => (a.inside_percent ?? 101) - (b.inside_percent ?? 101));
    const columns = [
      C('employee_code', 'Code'),
      C('officer', 'Officer', 'text', { link: 'user_id' }),
      C('shifts', 'Shifts', 'int', { sum: true }),
      C('pings', 'GPS points', 'int', { sum: true }),
      C('inside_percent', 'Inside fence', 'percent'),
      C('off_post_events', 'Walk-offs', 'int', { sum: true, warnAbove: 0 }),
      C('clock_ins_outside', 'Clock-ins outside', 'int', { sum: true, warnAbove: 0 }),
      C('avg_clock_in_distance', 'Avg clock-in distance (m)', 'int'),
      C('max_distance', 'Furthest (m)', 'int'),
      C('last_ping', 'Last GPS point', 'datetime'),
    ];
    const totals = sumColumns(rows, columns);
    const allJudged = pings.reduce((n, p) => n + Number(p.inside) + Number(p.outside), 0);
    totals.inside_percent = pct(pings.reduce((n, p) => n + Number(p.inside), 0), allJudged);
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Time inside fence', value: totals.inside_percent, type: 'percent' },
        { label: 'GPS points', value: totals.pings, type: 'int' },
        { label: 'Walk-offs', value: totals.off_post_events, type: 'int' },
        { label: 'Clock-ins outside', value: totals.clock_ins_outside, type: 'int' },
      ],
      notes: [
        'Position is only recorded while an officer is clocked in. Readings with poor accuracy are not counted either way.',
        'A walk-off is counted once when the officer crosses out of the fence, not for every reading while outside.',
      ],
    };
  },
};


/* ------------------------------------------------------------- incidents -- */

async function loadVisits(f) {
  const sc = scope(f);
  return db
    .prepare(
      `SELECT v.id, v.site_id, v.officer_id, v.visited_at, v.rating,
              v.uniform_ok, v.post_orders_reviewed, v.equipment_ok, v.site_secure
       FROM supervisor_visits v
       JOIN sites s ON s.id = v.site_id
       LEFT JOIN users u ON u.id = v.officer_id
       WHERE v.visited_at >= ? AND v.visited_at < ? ${sc.sql}
       ORDER BY v.visited_at`
    )
    .all(toSql(f.from), toSql(f.to), ...sc.params);
}

async function loadIncidents(f) {
  const sc = scope(f);
  return db
    .prepare(
      `SELECT i.id, i.category, i.severity, i.status, i.occurred_at, i.police_notified, i.reviewed_at,
              s.id AS site_id, s.name AS site_name
       FROM incidents i
       JOIN users u ON u.id = i.user_id
       LEFT JOIN sites s ON s.id = i.site_id
       WHERE i.occurred_at >= ? AND i.occurred_at < ? ${sc.sql}
       ORDER BY i.occurred_at`
    )
    .all(toSql(f.from), toSql(f.to), ...sc.params);
}

const SEVERITY_COLUMNS = [
  C('critical', 'Critical', 'int', { sum: true, warnAbove: 0 }),
  C('high', 'High', 'int', { sum: true, warnAbove: 0 }),
  C('medium', 'Medium', 'int', { sum: true }),
  C('low', 'Low', 'int', { sum: true }),
];
const bySeverity = (list) => Object.fromEntries(['critical', 'high', 'medium', 'low'].map((k) => [k, list.filter((i) => i.severity === k).length]));
const serious = (i) => i.severity === 'high' || i.severity === 'critical';
const policeOf = (i) => i.police_notified === true || i.police_notified === 1;

Object.assign(builders, {
  async 'visits-by-site'(f) {
    const visits = await loadVisits(f);
    const board = await visitBoard();
    const bySite = groupBy(visits, 'site_id');
    const rows = board.sites
      .filter((s) => !f.siteId || s.id === f.siteId)
      .map((s) => {
        const g = bySite.get(s.id) || [];
        const rated = g.filter((v) => v.rating != null);
        return {
          site: s.name,
          visits: g.length,
          officers: new Set(g.map((v) => v.officer_id).filter(Boolean)).size,
          rating: rated.length ? Math.round((rated.reduce((n, v) => n + v.rating, 0) / rated.length) * 10) / 10 : null,
          problems: g.filter((v) => VISIT_CHECKS.some((c) => v[c.key] === false) || (v.rating != null && v.rating <= 2)).length,
          last_visit: s.last_visit,
          days_since: s.days_since,
        };
      });
    rows.sort((a, b) => (b.days_since ?? Infinity) - (a.days_since ?? Infinity) || a.site.localeCompare(b.site));
    const columns = [
      C('site', 'Site'),
      C('visits', 'Visits', 'int', { sum: true, bar: true }),
      C('officers', 'Officers seen', 'int'),
      C('rating', 'Average rating', 'decimal'),
      C('problems', 'Visits with a problem', 'int', { sum: true, warnAbove: 0 }),
      C('last_visit', 'Last visit', 'datetime'),
      C('days_since', 'Days since', 'int', { warnAbove: VISIT_DUE_DAYS - 1 }),
    ];
    const totals = sumColumns(rows, columns);
    const rated = visits.filter((v) => v.rating != null);
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Visits', value: totals.visits || 0, type: 'int' },
        { label: 'Average rating', value: rated.length ? Math.round((rated.reduce((n, v) => n + v.rating, 0) / rated.length) * 10) / 10 : '--' },
        { label: 'Found a problem', value: totals.problems || 0, type: 'int' },
        { label: 'Sites due a visit', value: rows.filter((r) => r.days_since == null || r.days_since >= VISIT_DUE_DAYS).length, type: 'int' },
      ],
      chart: { label: 'site', value: 'visits', type: 'int' },
      notes: [
        `A site is due a visit after ${VISIT_DUE_DAYS} days without one. Last visit and days since count from any date, not just this range.`,
        'A problem is a failed check (uniform, post orders, equipment, site secure) or a rating of 2 or less.',
      ],
    };
  },

  async 'agreement-hours'(f) {
    const days = Math.round((f.to - f.from) / 86400000);
    const agreements = await db
      .prepare(
        `SELECT a.*, s.name AS site, s.client_name FROM site_agreements a JOIN sites s ON s.id = a.site_id
         ${f.siteId ? 'WHERE a.site_id = ?' : ''} ORDER BY s.name`
      )
      .all(...(f.siteId ? [f.siteId] : []));
    const worked = new Map(
      (await db
        .prepare(
          `SELECT p.site_id, SUM(te.minutes_worked) AS minutes FROM time_entries te JOIN posts p ON p.id = te.post_id
           WHERE te.clock_in_at >= ? AND te.clock_in_at < ? AND te.clock_out_at IS NOT NULL GROUP BY p.site_id`
        )
        .all(toSql(f.from), toSql(f.to))).map((r) => [r.site_id, Number(r.minutes) || 0])
    );
    const rows = agreements.map((a) => {
      const contracted = Math.round(Number(a.weekly_hours) * (days / 7) * 10) / 10;
      const delivered = Math.round((worked.get(a.site_id) || 0) / 6) / 10;
      return {
        site: a.site,
        client: a.client_name,
        weekly_hours: Number(a.weekly_hours),
        contracted,
        delivered,
        difference: Math.round((delivered - contracted) * 10) / 10,
        pct: pct(delivered, contracted),
        ends_on: a.ends_on ? String(a.ends_on).slice(0, 10) : null,
      };
    });
    rows.sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0));
    const columns = [
      C('site', 'Site'),
      C('client', 'Client'),
      C('weekly_hours', 'Hours a week', 'decimal'),
      C('contracted', 'Contracted hours', 'decimal', { sum: true }),
      C('delivered', 'Hours worked', 'decimal', { sum: true, bar: true }),
      C('difference', 'Difference', 'decimal', { sum: true }),
      C('pct', 'Delivered', 'percent'),
      C('ends_on', 'Agreement ends', 'date'),
    ];
    const totals = sumColumns(rows, columns);
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Sites with an agreement', value: rows.length, type: 'int' },
        { label: 'Contracted hours', value: totals.contracted || 0 },
        { label: 'Hours worked', value: totals.delivered || 0 },
        { label: 'Delivered', value: totals.contracted ? `${pct(totals.delivered, totals.contracted)}%` : '--' },
      ],
      chart: { label: 'site', value: 'delivered', type: 'decimal' },
      notes: [
        `Contracted hours are the weekly figure spread over the ${days} days in the range. Worked hours are finished shifts that started in the range.`,
        'Sites without a service agreement are left out; set one under Billing → Service agreements.',
      ],
    };
  },

  async 'calls-by-site'(f) {
    const params = [toSql(f.from), toSql(f.to)];
    if (f.siteId) params.push(f.siteId);
    if (f.userId) params.push(f.userId);
    const calls = (await db
      .prepare(
        `${callSelect} WHERE c.created_at >= ? AND c.created_at < ?
         ${f.siteId ? 'AND c.site_id = ?' : ''} ${f.userId ? 'AND c.assigned_to = ?' : ''}`
      )
      .all(...params)).map((c) => presentCall(c));
    const median = (xs) => {
      if (!xs.length) return null;
      const a = [...xs].sort((x, y) => x - y);
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10) / 10;
    };
    const avg = (xs) => (xs.length ? Math.round((xs.reduce((n, x) => n + x, 0) / xs.length) * 10) / 10 : null);
    const rows = [...groupBy(calls, 'site_id').values()].map((g) => {
      const timed = g.map((c) => c.timings.toArrive).filter((m) => m != null);
      return {
        site: g[0].site_name,
        calls: g.length,
        urgent: g.filter((c) => c.priority <= 2).length,
        from_client: g.filter((c) => c.source === 'client').length,
        cleared: g.filter((c) => c.status === 'cleared').length,
        cancelled: g.filter((c) => c.status === 'cancelled').length,
        avg_arrive: avg(timed),
        median_arrive: median(timed),
        within_target: pct(g.filter((c) => c.timings.withinTarget).length, timed.length),
      };
    });
    rows.sort((a, b) => b.calls - a.calls || a.site.localeCompare(b.site));
    const columns = [
      C('site', 'Site'),
      C('calls', 'Calls', 'int', { sum: true, bar: true }),
      C('urgent', 'Emergency or urgent', 'int', { sum: true }),
      C('from_client', 'Raised by the client', 'int', { sum: true }),
      C('cleared', 'Cleared', 'int', { sum: true }),
      C('cancelled', 'Cancelled', 'int', { sum: true }),
      C('avg_arrive', 'Average minutes to on scene', 'decimal'),
      C('median_arrive', 'Median minutes', 'decimal'),
      C('within_target', 'Within target', 'percent'),
    ];
    const timed = calls.map((c) => c.timings.toArrive).filter((m) => m != null);
    return {
      columns,
      rows,
      totals: sumColumns(rows, columns),
      summary: [
        { label: 'Calls', value: calls.length, type: 'int' },
        { label: 'Average minutes to on scene', value: avg(timed) ?? '--' },
        { label: 'Within target', value: timed.length ? `${pct(calls.filter((c) => c.timings.withinTarget).length, timed.length)}%` : '--' },
        { label: 'Raised by clients', value: calls.filter((c) => c.source === 'client').length, type: 'int' },
      ],
      chart: { label: 'site', value: 'calls', type: 'int' },
      notes: [
        `Targets from the call to an officer on scene: emergency ${CALL_TARGET_MINUTES[1]} minutes, urgent ${CALL_TARGET_MINUTES[2]}, routine ${CALL_TARGET_MINUTES[3]}.`,
        'Times count only calls an officer reached; a call cancelled or closed by phone has no on-scene time.',
      ],
    };
  },

  async 'vehicle-mileage'(f) {
    const vehicles = await db
      .prepare(
        `SELECT e.id, e.label, e.identifier, e.odometer, s.name AS site FROM equipment e LEFT JOIN sites s ON s.id = e.site_id
         WHERE e.category = 'vehicle' ${f.siteId ? 'AND e.site_id = ?' : ''} ORDER BY s.name NULLS FIRST, e.label`
      )
      .all(...(f.siteId ? [f.siteId] : []));
    const trips = await vehicleTrips({ from: f.from, to: f.to, siteId: f.siteId, userId: f.userId });
    const rows = [];
    for (const v of vehicles) {
      const counts = await db
        .prepare(
          `SELECT COUNT(*) FILTER (WHERE kind <> 'service') AS checks,
                  COUNT(*) FILTER (WHERE kind = 'service') AS services
           FROM vehicle_inspections WHERE equipment_id = ? AND created_at >= ? AND created_at < ?`
        )
        .get(v.id, toSql(f.from), toSql(f.to));
      const defects = await db
        .prepare(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE critical) AS critical FROM vehicle_defects WHERE equipment_id = ? AND reported_at >= ? AND reported_at < ?`)
        .get(v.id, toSql(f.from), toSql(f.to));
      const mine = trips.filter((t) => t.equipment_id === v.id);
      rows.push({
        vehicle: v.label,
        identifier: v.identifier,
        site: v.site || 'Company pool',
        miles: f.userId ? mine.reduce((n, t) => n + t.miles, 0) : await milesBetween(v.id, f.from, f.to),
        trips: mine.length,
        avg_trip: mine.length ? Math.round(mine.reduce((n, t) => n + t.miles, 0) / mine.length) : null,
        checks: Number(counts.checks) || 0,
        services: Number(counts.services) || 0,
        defects: Number(defects.n) || 0,
        critical: Number(defects.critical) || 0,
        odometer: v.odometer,
      });
    }
    const columns = [
      C('vehicle', 'Vehicle'),
      C('identifier', 'Fleet number'),
      C('site', 'Site'),
      C('miles', 'Miles', 'int', { sum: true, bar: true }),
      C('trips', 'Trips', 'int', { sum: true }),
      C('avg_trip', 'Miles a trip', 'int'),
      C('checks', 'Checks', 'int', { sum: true }),
      C('defects', 'Defects raised', 'int', { sum: true }),
      C('critical', 'Off the road', 'int', { sum: true }),
      C('services', 'Services', 'int', { sum: true }),
      C('odometer', 'Odometer now', 'int'),
    ];
    const byOfficer = new Map();
    for (const t of trips) {
      const o = byOfficer.get(t.officer) || { miles: 0, trips: 0 };
      o.miles += t.miles;
      o.trips += 1;
      byOfficer.set(t.officer, o);
    }
    const top = [...byOfficer.entries()].sort((a, b) => b[1].miles - a[1].miles)[0];
    const totals = sumColumns(rows, columns);
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Vehicles', value: rows.length, type: 'int' },
        { label: 'Miles', value: totals.miles || 0, type: 'int' },
        { label: 'Trips', value: totals.trips || 0, type: 'int' },
        { label: 'Most miles', value: top ? `${top[0]} (${top[1].miles.toLocaleString('en-US')})` : '--' },
      ],
      chart: { label: 'vehicle', value: 'miles', type: 'int' },
      notes: [
        'Miles come from the odometer readings officers enter at the start and end checks, and at services: nobody types a mileage.',
        f.userId ? 'Filtered to one officer: miles are the trips they drove.' : 'A trip is one sign-out, from its start check to its end check.',
      ],
    };
  },

  async 'incidents-by-site'(f) {
    const list = await loadIncidents(f);
    const groups = groupBy(list, 'site_id');
    const rows = [...groups.values()].map((g) => ({
      site: g[0].site_name || 'No site recorded',
      total: g.length,
      ...bySeverity(g),
      police: g.filter(policeOf).length,
      open: g.filter((i) => i.status !== 'closed').length,
    }));
    rows.sort((a, b) => b.total - a.total || a.site.localeCompare(b.site));
    const columns = [
      C('site', 'Site'),
      C('total', 'Incidents', 'int', { sum: true, bar: true }),
      ...SEVERITY_COLUMNS,
      C('police', 'Police notified', 'int', { sum: true }),
      C('open', 'Still open', 'int', { sum: true, warnAbove: 0 }),
    ];
    const totals = sumColumns(rows, columns);
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Incidents', value: totals.total || 0, type: 'int' },
        { label: 'Serious (high or critical)', value: (totals.critical || 0) + (totals.high || 0), type: 'int' },
        { label: 'Police notified', value: totals.police || 0, type: 'int' },
        { label: 'Still open', value: totals.open || 0, type: 'int' },
      ],
      chart: { label: 'site', value: 'total', type: 'int' },
      notes: ['An incident is counted at the site it happened at, on the day it happened.'],
    };
  },

  async 'incidents-by-category'(f) {
    const list = await loadIncidents(f);
    const groups = groupBy(list, 'category');
    const rows = [...groups.values()].map((g) => {
      const closed = g.filter((i) => i.status === 'closed' && i.reviewed_at);
      const hours = closed.map((i) => (new Date(sqlToIso(i.reviewed_at)) - new Date(sqlToIso(i.occurred_at))) / 3600000).filter((h) => h >= 0);
      return {
        category: g[0].category || 'Uncategorised',
        total: g.length,
        serious: g.filter(serious).length,
        serious_pct: pct(g.filter(serious).length, g.length),
        police: g.filter(policeOf).length,
        hours_to_close: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
      };
    });
    rows.sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
    const columns = [
      C('category', 'Type'),
      C('total', 'Incidents', 'int', { sum: true, bar: true }),
      C('serious', 'Serious', 'int', { sum: true, warnAbove: 0 }),
      C('serious_pct', 'Serious share', 'percent'),
      C('police', 'Police notified', 'int', { sum: true }),
      C('hours_to_close', 'Hours to close (avg)', 'hours'),
    ];
    const totals = sumColumns(rows, columns);
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Incidents', value: totals.total || 0, type: 'int' },
        { label: 'Most common', value: rows[0]?.category || '--' },
        { label: 'Serious', value: totals.serious || 0, type: 'int' },
        { label: 'Types seen', value: rows.length, type: 'int' },
      ],
      chart: { label: 'category', value: 'total', type: 'int' },
      notes: ['Hours to close runs from when the incident happened to the review that closed it.'],
    };
  },

  async 'incidents-daily'(f) {
    const list = await loadIncidents(f);
    const byDay = groupBy(list.map((i) => ({ ...i, day: toDateString(new Date(sqlToIso(i.occurred_at))) })), 'day');
    const rows = [];
    for (let d = new Date(f.from); d < f.to; d.setDate(d.getDate() + 1)) {
      const key = toDateString(d);
      const g = byDay.get(key) || [];
      rows.push({
        day: key,
        weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
        total: g.length,
        serious: g.filter(serious).length,
        police: g.filter(policeOf).length,
        sites: new Set(g.map((i) => i.site_id)).size,
      });
    }
    const columns = [
      C('day', 'Date', 'date'),
      C('weekday', 'Day'),
      C('total', 'Incidents', 'int', { sum: true, bar: true }),
      C('serious', 'Serious', 'int', { sum: true, warnAbove: 0 }),
      C('police', 'Police notified', 'int', { sum: true }),
      C('sites', 'Sites', 'int'),
    ];
    const totals = sumColumns(rows, columns);
    const busiest = [...rows].sort((a, b) => b.total - a.total)[0];
    const weekdays = groupBy(rows, 'weekday');
    const worstWeekday = [...weekdays.entries()]
      .map(([day, g]) => [day, g.reduce((n, r) => n + r.total, 0)])
      .sort((a, b) => b[1] - a[1])[0];
    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Incidents', value: totals.total || 0, type: 'int' },
        { label: 'Average per day', value: rows.length ? Math.round(((totals.total || 0) / rows.length) * 100) / 100 : 0 },
        { label: 'Busiest day', value: busiest?.total ? busiest.day : '--', type: busiest?.total ? 'date' : undefined },
        { label: 'Worst weekday', value: worstWeekday && worstWeekday[1] ? worstWeekday[0] : '--' },
      ],
      chart: { label: 'day', value: 'total', type: 'int', series: 'time' },
      notes: ['An incident is counted on the day it happened, which may be before the day it was filed.'],
    };
  },
});

/* ---------------------------------------------------------------- routes -- */

adminReportsRouter.get('/', (_req, res) => res.json({ reports: REPORTS }));

export async function buildReport(kind, query) {
  const meta = REPORTS.find((r) => r.id === kind);
  if (!meta) throw new HttpError(404, 'No such report.');
  const f = readFilters(query);
  const result = await builders[kind](f);
  // Sums of floats drift (38242.130000000005); every summary figure is money,
  // hours or a percentage, all of which read to two places.
  result.summary = (result.summary || []).map((x) =>
    typeof x.value === 'number' ? { ...x, value: Math.round(x.value * 100) / 100 } : x
  );
  return {
    report: meta,
    filters: {
      from: toDateString(f.from),
      to: toDateString(f.toDay),
      siteId: f.siteId,
      userId: f.userId,
      employmentType: f.employmentType,
    },
    generated_at: new Date().toISOString(),
    ...result,
  };
}

adminReportsRouter.get(
  '/:kind',
  wrap(async (req, res) => {
    res.json(await buildReport(req.params.kind, req.query));
  })
);

const csvCell = (v) => {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

adminReportsRouter.get(
  '/:kind/export.csv',
  wrap(async (req, res) => {
    const r = await buildReport(req.params.kind, req.query);
    const lines = [r.columns.map((c) => csvCell(c.label)).join(',')];
    for (const row of r.rows) lines.push(r.columns.map((c) => csvCell(row[c.key])).join(','));
    if (Object.keys(r.totals || {}).length) {
      lines.push(r.columns.map((c, i) => csvCell(i === 0 ? 'TOTAL' : r.totals[c.key] ?? '')).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${r.report.id}-${r.filters.from}-to-${r.filters.to}.csv"`
    );
    res.send(lines.join('\n'));
  })
);
