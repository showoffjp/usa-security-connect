/**
 * Coaching and discipline.
 *
 * Each record is one documented step on an officer's record: what happened,
 * what is expected from now on, and at what step (coaching, then verbal,
 * written and final warnings, then suspension). The officer reads it and
 * signs, with their side of it if they want; if they will not, a supervisor
 * records that, with a witness. A record counts towards the next step for
 * CONDUCT_ACTIVE_MONTHS, unless an administrator rescinds it. A suspension
 * keeps the officer off the roster for its dates.
 */

import { db } from '../lib/db.js';
import { isoFields, toDateString, sqlToIso } from '../lib/http.js';
import { toSql } from './compliance.js';
import {
  CONDUCT_LEVELS, CONDUCT_LEVEL_LABEL, CONDUCT_CATEGORIES, CONDUCT_CATEGORY_LABEL, CONDUCT_SIGN_DAYS,
  conductActive, suggestedConductLevel,
} from '../shared.js';

const DAY = 86400000;
/** A local calendar day: a DATE column as it comes back, a Date, or a stored timestamp. */
const day = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return toDateString(v);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : toDateString(new Date(sqlToIso(s)));
};

export const CONDUCT_SELECT = `
  SELECT c.*, u.first_name || ' ' || u.last_name AS officer, u.employee_code, u.role AS officer_role,
         ib.first_name || ' ' || ib.last_name AS issued_by_name,
         rb.first_name || ' ' || rb.last_name AS refused_by_name,
         xb.first_name || ' ' || xb.last_name AS rescinded_by_name
  FROM conduct_records c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN users ib ON ib.id = c.issued_by
  LEFT JOIN users rb ON rb.id = c.refused_by
  LEFT JOIN users xb ON xb.id = c.rescinded_by`;

/** A record as the API shows it: dates as days, labels, and whether it still counts. */
export function presentConduct(r, now = new Date()) {
  const row = isoFields(r, ['created_at', 'acknowledged_at', 'refused_at', 'rescinded_at']);
  const waiting = r.status === 'issued';
  return {
    ...row,
    occurred_on: day(r.occurred_on),
    suspension_starts_on: day(r.suspension_starts_on),
    suspension_ends_on: day(r.suspension_ends_on),
    level_label: CONDUCT_LEVEL_LABEL[r.level] || r.level,
    category_label: CONDUCT_CATEGORY_LABEL[r.category] || r.category,
    active: conductActive({ ...r, occurred_on: day(r.occurred_on) }, now),
    awaiting_signature: waiting,
    signature_overdue: waiting && now.getTime() - new Date(row.created_at).getTime() > CONDUCT_SIGN_DAYS * DAY,
  };
}

/** What the officer sees of their own record: no ids of who recorded what. */
export function presentForOfficer(r) {
  const { issued_by, refused_by, rescinded_by, refused_by_name, rescinded_by_name, employee_code, officer_role, ...rest } = presentConduct(r);
  return rest;
}

/** One record, presented, or null. */
export async function conductById(id) {
  const r = await db.prepare(`${CONDUCT_SELECT} WHERE c.id = ?`).get(id);
  return r ? presentConduct(r) : null;
}

/** All of one officer's records, newest first. */
export async function officerConduct(userId) {
  return (await db.prepare(`${CONDUCT_SELECT} WHERE c.user_id = ? ORDER BY c.occurred_on DESC, c.id DESC`).all(userId))
    .map((r) => presentConduct(r));
}

/**
 * Where an officer stands: their highest step still active, and for each kind
 * of problem the step a new record would usually be.
 */
export function standing(records) {
  const active = records.filter((r) => r.active);
  const top = active.reduce((best, r) => Math.max(best, CONDUCT_LEVELS.indexOf(r.level)), -1);
  return {
    level: top >= 0 ? CONDUCT_LEVELS[top] : null,
    level_label: top >= 0 ? CONDUCT_LEVEL_LABEL[CONDUCT_LEVELS[top]] : null,
    active: active.length,
    awaiting_signature: records.filter((r) => r.awaiting_signature).length,
    next: Object.fromEntries(CONDUCT_CATEGORIES.map((c) => [c, suggestedConductLevel(records, c)])),
  };
}

/** Whether an officer is suspended on a given day (YYYY-MM-DD or a Date). */
export async function suspendedOn(userId, when) {
  const d = day(when);
  const row = await db
    .prepare(
      `SELECT 1 FROM conduct_records
       WHERE user_id = ? AND level = 'suspension' AND status != 'rescinded'
         AND suspension_starts_on <= ?::date AND suspension_ends_on >= ?::date LIMIT 1`
    )
    .get(userId, d, d);
  return Boolean(row);
}

/** Everyone suspended on a given day, for ranking who could cover a shift. */
export async function suspendedIds(when) {
  const d = day(when);
  const rows = await db
    .prepare(
      `SELECT DISTINCT user_id FROM conduct_records
       WHERE level = 'suspension' AND status != 'rescinded'
         AND suspension_starts_on <= ?::date AND suspension_ends_on >= ?::date`
    )
    .all(d, d);
  return new Set(rows.map((r) => r.user_id));
}

/** Records the officer has had longer than CONDUCT_SIGN_DAYS without signing. */
export async function unsignedOverdue() {
  return (await db.prepare(`${CONDUCT_SELECT} WHERE c.status = 'issued' AND c.created_at < ? ORDER BY c.created_at`)
    .all(toSql(new Date(Date.now() - CONDUCT_SIGN_DAYS * DAY))))
    .map((r) => presentConduct(r));
}

/**
 * The office's view: every record from the last year and anything still
 * unsigned, with who stands where. Supervisors' own records are for
 * administrators only.
 */
export async function conductBoard({ includeSupervisors = false } = {}) {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const records = (await db
    .prepare(
      `${CONDUCT_SELECT} WHERE (c.occurred_on >= ?::date OR c.status = 'issued') ${includeSupervisors ? '' : "AND u.role = 'officer'"}
       ORDER BY c.occurred_on DESC, c.id DESC LIMIT 400`
    )
    .all(toDateString(since)))
    .map((r) => presentConduct(r));

  const byOfficer = new Map();
  for (const r of records) {
    if (!byOfficer.has(r.user_id)) byOfficer.set(r.user_id, { user_id: r.user_id, name: r.officer, employee_code: r.employee_code, records: [] });
    byOfficer.get(r.user_id).records.push(r);
  }
  const officers = [...byOfficer.values()]
    .map((o) => ({ user_id: o.user_id, name: o.name, employee_code: o.employee_code, ...standing(o.records) }))
    .filter((o) => o.active || o.awaiting_signature)
    .sort((a, b) => CONDUCT_LEVELS.indexOf(b.level) - CONDUCT_LEVELS.indexOf(a.level) || a.name.localeCompare(b.name));

  const today = toDateString(new Date());
  return {
    records,
    officers,
    counts: {
      active: records.filter((r) => r.active).length,
      awaiting_signature: records.filter((r) => r.awaiting_signature).length,
      overdue: records.filter((r) => r.signature_overdue).length,
      final_warnings: officers.filter((o) => o.level === 'final_warning' || o.level === 'suspension').length,
      suspended_now: records.filter((r) => r.level === 'suspension' && r.status !== 'rescinded'
        && r.suspension_starts_on <= today && r.suspension_ends_on >= today).length,
    },
  };
}
