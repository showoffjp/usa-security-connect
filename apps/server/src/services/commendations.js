/**
 * Commendations: a word of thanks for an officer, from a client contact who
 * saw their work or a supervisor. The officer reads every one; staff see them
 * on the officer's record and the scorecards count them. They do not move
 * the score, which stays a measure of what the records show.
 */

import { db } from '../lib/db.js';
import { sqlToIso } from '../lib/http.js';
import { COMMENDATION_LABEL, COMMEND_WINDOW_DAYS } from '../shared.js';
import { toSql } from './compliance.js';

export const COMMENDATION_SELECT = `
  SELECT c.*, u.first_name || ' ' || u.last_name AS officer, u.first_name AS officer_first, u.employee_code,
         s.name AS site_name, cu.name AS client_name, cu.company AS client_company,
         st.first_name || ' ' || st.last_name AS staff_name
  FROM commendations c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN sites s ON s.id = c.site_id
  LEFT JOIN client_users cu ON cu.id = c.client_user_id
  LEFT JOIN users st ON st.id = c.staff_user_id`;

/** Who it came from, in words the officer recognises. */
export function fromLabel(c) {
  if (c.client_user_id) return c.client_company ? `${c.client_name}, ${c.client_company}` : c.client_name || 'A client';
  return c.staff_name || 'The office';
}

export function presentCommendation(c) {
  return {
    id: c.id,
    user_id: c.user_id,
    officer: c.officer,
    employee_code: c.employee_code,
    site_id: c.site_id,
    site_name: c.site_name || null,
    category: c.category,
    category_label: COMMENDATION_LABEL[c.category] || c.category,
    message: c.message,
    source: c.client_user_id ? 'client' : 'staff',
    from: fromLabel(c),
    seen: Boolean(c.seen_at),
    created_at: sqlToIso(c.created_at),
  };
}

/**
 * The officers a client contact can commend: everyone who worked one of their
 * properties in the window, with the property they were seen at most lately.
 */
export async function commendableOfficers(siteIds) {
  if (!siteIds.length) return [];
  const since = toSql(new Date(Date.now() - COMMEND_WINDOW_DAYS * 86400000));
  const rows = await db
    .prepare(
      `SELECT DISTINCT ON (te.user_id, p.site_id) te.user_id, p.site_id, s.name AS site_name,
              u.first_name, u.last_name, te.clock_in_at
       FROM time_entries te
       JOIN posts p ON p.id = te.post_id
       JOIN sites s ON s.id = p.site_id
       JOIN users u ON u.id = te.user_id
       WHERE p.site_id IN (${siteIds.map(() => '?').join(',')}) AND te.clock_in_at >= ?
       ORDER BY te.user_id, p.site_id, te.clock_in_at DESC`
    )
    .all(...siteIds, since);
  return rows
    .map((r) => ({
      id: r.user_id,
      name: `${r.first_name} ${r.last_name}`,
      site_id: r.site_id,
      site_name: r.site_name,
      last_seen: sqlToIso(r.clock_in_at),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.site_name.localeCompare(b.site_name));
}
