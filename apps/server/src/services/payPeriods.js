/**
 * Pay periods: review, approve, close.
 *
 * A period is whole payroll weeks, Monday to Sunday, so the overtime worked
 * out for it is exactly the overtime the reports show - no week is ever split
 * between two periods.
 *
 * Approval is per officer and is pinned to a fingerprint of the entries and
 * rates it was given against. Anything that later changes an officer's pay for
 * the period - a corrected punch, the sweep closing a forgotten shift, a rate
 * change back-dated into it - changes the fingerprint, and the approval reads
 * as "changed since approved" until someone looks again. Nothing has to
 * remember to invalidate it.
 *
 * Closing snapshots every line and locks the period: entries in it cannot be
 * corrected and rates cannot be back-dated into it until it is reopened, with
 * a reason, on the audit log.
 */

import { createHash } from 'node:crypto';
import { db } from '../lib/db.js';
import { HttpError, parseDay, toDateString, sqlToIso } from '../lib/http.js';
import { toHours } from '../shared.js';
import { toSql } from './compliance.js';
import { loadPricedEntries, personPay, groupBy } from './payroll.js';

export const PERIOD_STATUS = { OPEN: 'open', CLOSED: 'closed' };
export const MAX_PERIOD_DAYS = 28;

const DAY = 86400000;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dollars = (cents) => (cents == null ? null : cents / 100);

/** A date column as YYYY-MM-DD, whichever form the driver handed back. */
export const dayString = (value) =>
  value instanceof Date ? toDateString(value) : String(value).slice(0, 10);

/** Local midnight at the start of the period, and at the start of the day after it. */
export function bounds(period) {
  const start = parseDay(dayString(period.period_start));
  const end = parseDay(dayString(period.period_end));
  return { start, end: addDays(end, 1) };
}

/**
 * Check a proposed period. Returns { start, end } as local-midnight dates, or
 * throws a 422 naming what is wrong.
 */
export function validatePeriod(periodStart, periodEnd) {
  const start = parseDay(periodStart);
  const end = parseDay(periodEnd);
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    throw new HttpError(422, 'Use dates like 2026-09-14.');
  }
  if (end < start) throw new HttpError(422, 'The period ends before it starts.');
  const days = Math.round((addDays(end, 1) - start) / DAY);
  if (start.getDay() !== 1 || end.getDay() !== 0 || days % 7 !== 0) {
    throw new HttpError(
      422,
      'Pay periods run in whole payroll weeks, Monday to Sunday, so overtime is never split between two periods.'
    );
  }
  if (days > MAX_PERIOD_DAYS) throw new HttpError(422, `A pay period can be at most ${MAX_PERIOD_DAYS / 7} weeks.`);
  return { start, end, days };
}

/** The period after the latest one, or the last two whole weeks when there is none. */
export async function suggestNext() {
  const latest = await db.prepare(`SELECT * FROM pay_periods ORDER BY period_start DESC LIMIT 1`).get();
  if (latest) {
    const { start, end } = bounds(latest);
    const days = Math.round((end - start) / DAY);
    const next = end;
    return { periodStart: toDateString(next), periodEnd: toDateString(addDays(next, days - 1)), days };
  }
  const today = parseDay();
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const start = addDays(monday, -14);
  return { periodStart: toDateString(start), periodEnd: toDateString(addDays(start, 13)), days: 14 };
}

/** The closed period a calendar day falls in, if any. */
export async function closedPeriodOn(day) {
  return db
    .prepare(
      `SELECT * FROM pay_periods WHERE status = 'closed' AND period_start <= ? AND period_end >= ?
       ORDER BY period_start LIMIT 1`
    )
    .get(day, day);
}

export const periodLabel = (p) => `${dayString(p.period_start)} to ${dayString(p.period_end)}`;

/** Refuse a change to hours worked at `instant` when payroll for that day is closed. */
export async function assertHoursOpen(instant, what = 'change hours') {
  const day = toDateString(new Date(sqlToIso(instant) ?? instant));
  const closed = await closedPeriodOn(day);
  if (closed) {
    throw new HttpError(
      409,
      `Payroll for ${periodLabel(closed)} is closed, so you cannot ${what} on ${day}. Reopen the period first.`,
      { code: 'period_closed', periodId: closed.id }
    );
  }
}

/** Refuse a rate that would take effect inside, or before, a closed period. */
export async function assertRateDateOpen(effectiveOn) {
  if (!effectiveOn) return;
  const closed = await db
    .prepare(
      `SELECT * FROM pay_periods WHERE status = 'closed' AND period_end >= ?
       ORDER BY period_end DESC LIMIT 1`
    )
    .get(effectiveOn);
  if (closed) {
    const after = toDateString(addDays(parseDay(dayString(closed.period_end)), 1));
    throw new HttpError(
      409,
      `Payroll for ${periodLabel(closed)} is closed. A rate change can take effect from ${after} onward, or reopen the period first.`,
      { code: 'period_closed', periodId: closed.id }
    );
  }
}

/** What an approval is pinned to: every entry, its minutes and the rate it was priced at. */
function fingerprintOf(list, openEntries) {
  const parts = [...list]
    .sort((a, b) => a.id - b.id)
    .map((e) =>
      [
        e.id,
        e.clock_in_at,
        e.clock_out_at,
        e.paid_minutes,
        e.pay_rate_cents,
        e.overtime_multiplier,
        e.pay_type,
        e.employment_type,
        e.exempt ? 1 : 0,
        e.salary_cents,
      ].join('|')
    );
  parts.push(`open:${openEntries}`);
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 20);
}

const issue = (code, level, message) => ({ code, level, message });

/**
 * The live review of an open period: one line per officer with hours in it,
 * what they are owed, what needs a second look, and where their approval
 * stands.
 */
export async function reviewPeriod(period) {
  const { start, end } = bounds(period);
  const priced = groupBy(await loadPricedEntries({ from: start, to: end }), 'user_id');

  const extras = await db
    .prepare(
      `SELECT te.user_id,
              SUM(CASE WHEN te.clock_out_at IS NULL THEN 1 ELSE 0 END) AS open_entries,
              SUM(CASE WHEN te.adjusted_by IS NOT NULL THEN 1 ELSE 0 END) AS adjusted,
              SUM(CASE WHEN te.clock_in_geofence = 'outside' THEN 1 ELSE 0 END) AS outside
       FROM time_entries te
       WHERE te.clock_in_at >= ? AND te.clock_in_at < ?
       GROUP BY te.user_id`
    )
    .all(toSql(start), toSql(end));
  const extraBy = new Map(extras.map((x) => [x.user_id, x]));

  const flags = await db
    .prepare(
      `SELECT user_id, COUNT(*) AS n FROM flags
       WHERE resolved_at IS NULL AND occurred_at >= ? AND occurred_at < ?
       GROUP BY user_id`
    )
    .all(toSql(start), toSql(end));
  const flagsBy = new Map(flags.map((f) => [f.user_id, Number(f.n)]));

  // Officers waiting on an answer about hours in this period.
  const corrections = await db
    .prepare(
      `SELECT c.user_id, COUNT(*) AS n FROM time_corrections c JOIN time_entries te ON te.id = c.time_entry_id
       WHERE c.status = 'pending' AND te.clock_in_at >= ? AND te.clock_in_at < ?
       GROUP BY c.user_id`
    )
    .all(toSql(start), toSql(end));
  const correctionsBy = new Map(corrections.map((c) => [c.user_id, Number(c.n)]));

  const approvals = await db
    .prepare(
      `SELECT l.*, a.first_name || ' ' || a.last_name AS approved_by_name
       FROM pay_period_lines l LEFT JOIN users a ON a.id = l.approved_by
       WHERE l.pay_period_id = ?`
    )
    .all(period.id);
  const approvalBy = new Map(approvals.map((a) => [a.user_id, a]));

  // Everyone with a finished entry, plus anyone whose only entries are still open.
  const ids = new Set([...priced.keys()]);
  for (const x of extras) if (Number(x.open_entries) > 0) ids.add(x.user_id);
  const people = ids.size
    ? await db
        .prepare(
          `SELECT id, employee_code, first_name || ' ' || last_name AS officer, employment_type, pay_type,
                  exempt, w9_on_file, business_name
           FROM users WHERE id IN (${[...ids].map(() => '?').join(',')})`
        )
        .all(...ids)
    : [];

  const lines = people.map((person) => {
    const list = priced.get(person.id) || [];
    const extra = extraBy.get(person.id) || {};
    const openEntries = Number(extra.open_entries || 0);
    const pay = list.length
      ? personPay(list)
      : { minutes: 0, regularMinutes: 0, overtimeMinutes: 0, payCents: 0, regularPayCents: 0, overtimePayCents: 0 };

    const siteMinutes = new Map();
    for (const e of list) siteMinutes.set(e.site_name, (siteMinutes.get(e.site_name) || 0) + e.paid_minutes);
    const sites = [...siteMinutes]
      .sort((a, b) => b[1] - a[1])
      .map(([site, minutes]) => ({ site, minutes, hours: toHours(minutes) }));

    const issues = [];
    if (openEntries > 0) {
      issues.push(
        issue('open_entry', 'block', `${openEntries} shift${openEntries === 1 ? ' is' : 's are'} still clocked in.`)
      );
    }
    if (list.length && pay.payCents == null) issues.push(issue('no_rate', 'block', 'No pay rate on record.'));
    const autoClosed = list.filter((e) => e.auto_closed).length;
    if (autoClosed) {
      issues.push(issue('auto_closed', 'warn', `${autoClosed} shift${autoClosed === 1 ? '' : 's'} closed by the system, not the officer.`));
    }
    const adjusted = Number(extra.adjusted || 0);
    if (adjusted) issues.push(issue('adjusted', 'warn', `${adjusted} punch${adjusted === 1 ? '' : 'es'} corrected by an admin.`));
    const outside = Number(extra.outside || 0);
    if (outside) issues.push(issue('outside', 'warn', `${outside} clock-in${outside === 1 ? '' : 's'} outside the post's geofence.`));
    const openFlags = flagsBy.get(person.id) || 0;
    if (openFlags) issues.push(issue('flags', 'warn', `${openFlags} unresolved flag${openFlags === 1 ? '' : 's'} in this period.`));
    const pendingCorrections = correctionsBy.get(person.id) || 0;
    if (pendingCorrections) {
      issues.push(issue('correction', 'warn', `${pendingCorrections} time correction${pendingCorrections === 1 ? '' : 's'} asked for and not yet decided.`));
    }
    if (pay.overtimeMinutes > 0) issues.push(issue('overtime', 'info', `${toHours(pay.overtimeMinutes)} h of overtime.`));
    if (person.employment_type === '1099' && !person.w9_on_file) {
      issues.push(issue('no_w9', 'warn', 'Contractor with no W-9 on file.'));
    }

    const fingerprint = fingerprintOf(list, openEntries);
    const approval = approvalBy.get(person.id);
    const state = !approval ? 'pending' : approval.fingerprint === fingerprint ? 'approved' : 'changed';

    return {
      user_id: person.id,
      employee_code: person.employee_code,
      officer: person.officer,
      employment_type: person.employment_type,
      pay_type: person.pay_type,
      business_name: person.business_name,
      entries: list.length,
      open_entries: openEntries,
      minutes: pay.minutes,
      regular_minutes: pay.regularMinutes,
      overtime_minutes: pay.overtimeMinutes,
      hours: toHours(pay.minutes),
      regular_hours: toHours(pay.regularMinutes),
      overtime_hours: toHours(pay.overtimeMinutes),
      regular_pay_cents: pay.regularPayCents ?? null,
      overtime_pay_cents: pay.overtimePayCents ?? null,
      gross_cents: pay.payCents ?? null,
      regular_pay: dollars(pay.regularPayCents),
      overtime_pay: dollars(pay.overtimePayCents),
      gross_pay: dollars(pay.payCents),
      sites,
      issues,
      pending_corrections: pendingCorrections,
      blocked: issues.some((i) => i.level === 'block'),
      fingerprint,
      approval: {
        state,
        approved_at: approval ? sqlToIso(approval.approved_at) : null,
        approved_by_name: approval?.approved_by_name || null,
        approved_gross: approval ? dollars(approval.gross_cents) : null,
      },
    };
  });

  lines.sort((a, b) => a.officer.localeCompare(b.officer));
  return lines;
}

/** A closed period's lines, exactly as they were when it closed. */
export async function closedLines(period) {
  const rows = await db
    .prepare(
      `SELECT l.*, a.first_name || ' ' || a.last_name AS approved_by_name
       FROM pay_period_lines l LEFT JOIN users a ON a.id = l.approved_by
       WHERE l.pay_period_id = ? ORDER BY l.officer`
    )
    .all(period.id);
  return rows.map((l) => ({
    user_id: l.user_id,
    employee_code: l.employee_code,
    officer: l.officer,
    employment_type: l.employment_type,
    pay_type: l.pay_type,
    entries: l.entries,
    open_entries: 0,
    minutes: l.minutes,
    regular_minutes: l.regular_minutes,
    overtime_minutes: l.overtime_minutes,
    hours: toHours(l.minutes),
    regular_hours: toHours(l.regular_minutes),
    overtime_hours: toHours(l.overtime_minutes),
    regular_pay_cents: l.regular_pay_cents,
    overtime_pay_cents: l.overtime_pay_cents,
    gross_cents: l.gross_cents,
    regular_pay: dollars(l.regular_pay_cents),
    overtime_pay: dollars(l.overtime_pay_cents),
    gross_pay: dollars(l.gross_cents),
    sites: l.sites ? JSON.parse(l.sites) : [],
    issues: [],
    blocked: false,
    fingerprint: l.fingerprint,
    approval: {
      state: 'closed',
      approved_at: sqlToIso(l.approved_at),
      approved_by_name: l.approved_by_name,
      approved_gross: dollars(l.gross_cents),
    },
  }));
}

/** Totals over a set of lines, split by classification the way a bookkeeper files them. */
export function totalsOf(lines) {
  const sum = (set, key) => set.reduce((n, l) => n + (l[key] || 0), 0);
  const w2 = lines.filter((l) => l.employment_type === 'w2');
  const contractors = lines.filter((l) => l.employment_type === '1099');
  return {
    people: lines.length,
    minutes: sum(lines, 'minutes'),
    hours: toHours(sum(lines, 'minutes')),
    overtime_hours: toHours(sum(lines, 'overtime_minutes')),
    overtime_minutes: sum(lines, 'overtime_minutes'),
    gross_cents: sum(lines, 'gross_cents'),
    gross_pay: dollars(sum(lines, 'gross_cents')),
    overtime_pay: dollars(sum(lines, 'overtime_pay_cents')),
    w2: { people: w2.length, hours: toHours(sum(w2, 'minutes')), pay: dollars(sum(w2, 'gross_cents')), cents: sum(w2, 'gross_cents') },
    contractor: {
      people: contractors.length,
      hours: toHours(sum(contractors, 'minutes')),
      pay: dollars(sum(contractors, 'gross_cents')),
      cents: sum(contractors, 'gross_cents'),
    },
    approved: lines.filter((l) => l.approval.state === 'approved' || l.approval.state === 'closed').length,
    changed: lines.filter((l) => l.approval.state === 'changed').length,
    pending: lines.filter((l) => l.approval.state === 'pending').length,
    blocked: lines.filter((l) => l.blocked).length,
  };
}

/** What stands between an open period and closing it. Empty means it can close. */
export function closeBlockers(period, lines) {
  const blockers = [];
  if (period.status !== PERIOD_STATUS.OPEN) return [{ code: 'closed', message: 'This period is already closed.' }];
  const { end } = bounds(period);
  if (end > parseDay()) {
    blockers.push({ code: 'not_ended', message: `The period runs until ${dayString(period.period_end)}; it can close the day after.` });
  }
  const blocked = lines.filter((l) => l.blocked);
  if (blocked.length) {
    blockers.push({
      code: 'blocked',
      message: `${blocked.length} officer${blocked.length === 1 ? ' has' : 's have'} hours that cannot be paid yet (open shifts or no pay rate).`,
    });
  }
  // An officer has asked for hours in this period to be changed; paying them
  // first would mean paying the wrong hours, or reopening the period.
  const corrections = lines.reduce((n, l) => n + (l.pending_corrections || 0), 0);
  if (corrections) {
    blockers.push({
      code: 'corrections',
      message: `${corrections} time correction${corrections === 1 ? ' is' : 's are'} waiting for a decision.`,
    });
  }
  const unapproved = lines.filter((l) => l.approval.state !== 'approved');
  if (unapproved.length) {
    const changed = unapproved.filter((l) => l.approval.state === 'changed').length;
    blockers.push({
      code: 'unapproved',
      message:
        `${unapproved.length} officer${unapproved.length === 1 ? ' is' : 's are'} not approved` +
        (changed ? `, ${changed} of them because their hours or rate changed after approval.` : '.'),
    });
  }
  return blockers;
}

/** Save an approval, or the final figures on close, for one line. */
export async function writeLine(periodId, line, approvedBy) {
  await db
    .prepare(
      `INSERT INTO pay_period_lines
       (pay_period_id, user_id, fingerprint, approved_by, approved_at, employee_code, officer,
        employment_type, pay_type, entries, minutes, regular_minutes, overtime_minutes,
        regular_pay_cents, overtime_pay_cents, gross_cents, sites)
       VALUES (?,?,?,?,now(),?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (pay_period_id, user_id) DO UPDATE SET
         fingerprint = excluded.fingerprint, approved_by = excluded.approved_by,
         approved_at = excluded.approved_at, employee_code = excluded.employee_code,
         officer = excluded.officer, employment_type = excluded.employment_type,
         pay_type = excluded.pay_type, entries = excluded.entries, minutes = excluded.minutes,
         regular_minutes = excluded.regular_minutes, overtime_minutes = excluded.overtime_minutes,
         regular_pay_cents = excluded.regular_pay_cents, overtime_pay_cents = excluded.overtime_pay_cents,
         gross_cents = excluded.gross_cents, sites = excluded.sites`
    )
    .run(
      periodId,
      line.user_id,
      line.fingerprint,
      approvedBy,
      line.employee_code,
      line.officer,
      line.employment_type,
      line.pay_type,
      line.entries,
      line.minutes,
      line.regular_minutes,
      line.overtime_minutes,
      line.regular_pay_cents,
      line.overtime_pay_cents,
      line.gross_cents,
      JSON.stringify(line.sites.map(({ site, minutes }) => ({ site, minutes, hours: toHours(minutes) })))
    );
}
