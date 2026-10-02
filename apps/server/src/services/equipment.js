/**
 * Keys, radios, vehicles and weapons: who has them and who had them.
 *
 * The post orders on an armed post already instruct the officer to log the
 * weapon out at the start of the shift and back into the locker at the end.
 * This is the thing they log it into, and the reason the chain of custody is
 * append-only: an assignment row is closed when the item comes back, never
 * overwritten, so "who held key ring 4 on the night of the break-in" has an
 * answer months later.
 *
 * Two rules carry most of the value:
 *
 *   * An item is held by at most one person. That is enforced by looking for an
 *     open assignment rather than by trusting `equipment.status`, because a
 *     status column can drift and an open row cannot.
 *   * Anything marked return_by_end_of_shift that is still out when the officer
 *     clocks out raises a flag. A key ring going home in somebody's pocket is
 *     the single most common way a site's keys get lost, and it is invisible
 *     unless something notices at clock-out.
 */

import { db } from '../lib/db.js';
import { FLAG_TYPES, VEHICLE_CHECK_LABEL, equipmentEligibility } from '../shared.js';
import { toSql, raiseFlag } from './compliance.js';

/** A vehicle's open critical defect: the reason it is off the road, if it is. */
async function offRoadDefect(item) {
  if (item.category !== 'vehicle') return null;
  return db
    .prepare(`SELECT item FROM vehicle_defects WHERE equipment_id = ? AND resolved_at IS NULL AND critical = true ORDER BY reported_at LIMIT 1`)
    .get(item.id);
}

/** The open assignment for an item, if somebody currently holds it. */
export async function currentHolder(equipmentId) {
  return db
    .prepare(
      `SELECT ea.*, u.first_name, u.last_name, u.employee_code
       FROM equipment_assignments ea
       JOIN users u ON u.id = ea.user_id
       WHERE ea.equipment_id = ? AND ea.returned_at IS NULL
       ORDER BY ea.issued_at DESC LIMIT 1`
    )
    .get(equipmentId);
}

/** Everything one officer is holding right now. */
export async function heldBy(userId) {
  return db
    .prepare(
      `SELECT ea.id AS assignment_id, ea.issued_at, ea.issued_condition, ea.issued_note,
              e.id, e.category, e.label, e.identifier, e.return_by_end_of_shift,
              e.armed_only, s.name AS site_name
       FROM equipment_assignments ea
       JOIN equipment e ON e.id = ea.equipment_id
       LEFT JOIN sites s ON s.id = e.site_id
       WHERE ea.user_id = ? AND ea.returned_at IS NULL
       ORDER BY e.category, e.label`
    )
    .all(userId);
}

/**
 * Sign an item out to an officer.
 *
 * `issuedBy` is whoever is standing at the counter handing it over - usually a
 * supervisor, sometimes the officer themselves at an unstaffed site. Both are
 * recorded, because "who authorised this" is a different question from "who has
 * it" and an audit will ask both.
 */
export async function issue({ equipmentId, userId, issuedBy, condition = 'good', note = null, timeEntryId = null }) {
  const item = await db.prepare(`SELECT * FROM equipment WHERE id = ?`).get(equipmentId);
  if (!item) return { ok: false, code: 'not_found', reason: 'That item is not on the inventory.' };

  // The open assignment, not the status column, is the truth about who holds it.
  const held = await currentHolder(equipmentId);
  if (held) {
    return {
      ok: false,
      code: 'already_out',
      reason: `${held.first_name} ${held.last_name} already has that item.`,
      holder: held,
    };
  }

  const officer = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!officer) return { ok: false, code: 'no_officer', reason: 'Employee not found.' };

  // A failed brake check is not overridden by somebody needing a car tonight.
  const defect = await offRoadDefect(item);
  if (defect) {
    return {
      ok: false,
      code: 'off_road',
      reason: `That vehicle is off the road: ${VEHICLE_CHECK_LABEL[defect.item] || defect.item} failed inspection. Record the repair on the Fleet page first.`,
    };
  }

  const certifications = await db
    .prepare(`SELECT type, expires_on FROM certifications WHERE user_id = ?`)
    .all(userId);

  const eligible = equipmentEligibility({ item, officer, certifications });
  if (!eligible.ok) return { ok: false, code: 'not_eligible', reason: eligible.reason };

  const info = await db
    .prepare(
      `INSERT INTO equipment_assignments
         (equipment_id, user_id, time_entry_id, issued_at, issued_by, issued_condition, issued_note)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(equipmentId, userId, timeEntryId, toSql(new Date()), issuedBy, condition, note);

  await db.prepare(`UPDATE equipment SET status = 'issued' WHERE id = ?`).run(equipmentId);

  return {
    ok: true,
    assignment: await db.prepare(`SELECT * FROM equipment_assignments WHERE id = ?`).get(info.lastInsertRowid),
    item,
  };
}

/**
 * Take an item back.
 *
 * A condition of anything but `good` puts the item into maintenance rather than
 * straight back on the shelf, so a damaged radio is not handed to the next
 * officer by a system that considers it returned and therefore fine.
 */
export async function returnItem({ equipmentId, returnedTo, condition = 'good', note = null }) {
  const held = await currentHolder(equipmentId);
  if (!held) return { ok: false, code: 'not_out', reason: 'Nobody has that item signed out.' };

  await db
    .prepare(
      `UPDATE equipment_assignments
       SET returned_at = ?, returned_to = ?, returned_condition = ?, returned_note = ?
       WHERE id = ?`
    )
    .run(toSql(new Date()), returnedTo, condition, note, held.id);

  // A vehicle with an open critical defect goes to the workshop however it
  // was described at the counter.
  const item = await db.prepare(`SELECT * FROM equipment WHERE id = ?`).get(equipmentId);
  const nextStatus = condition === 'good' && !(await offRoadDefect(item)) ? 'available' : 'maintenance';
  await db.prepare(`UPDATE equipment SET status = ? WHERE id = ?`).run(nextStatus, equipmentId);

  return {
    ok: true,
    status: nextStatus,
    assignment: await db.prepare(`SELECT * FROM equipment_assignments WHERE id = ?`).get(held.id),
  };
}

/**
 * Anything that should have come back at the end of a shift and did not.
 *
 * Read by the compliance sweep, and by the clock-out path so the officer is told
 * before they walk away rather than after.
 */
export async function outstandingForShift(userId) {
  // Deliberately not filtered by the current shift: an item signed out
  // yesterday and never returned is still outstanding today, and an officer
  // being told about it at this clock-out is better than nobody being told.
  return db
    .prepare(
      `SELECT ea.id AS assignment_id, ea.issued_at, ea.time_entry_id,
              e.id, e.category, e.label, e.identifier, s.name AS site_name
       FROM equipment_assignments ea
       JOIN equipment e ON e.id = ea.equipment_id
       LEFT JOIN sites s ON s.id = e.site_id
       WHERE ea.user_id = ? AND ea.returned_at IS NULL
         AND e.return_by_end_of_shift = true`
    )
    .all(userId);
}

/**
 * Raise a flag for each item an officer took home.
 *
 * Keyed on the assignment rather than the officer, so two key rings produce two
 * flags and the uniqueness constraint stops the sweep raising the same one twice
 * on every pass.
 */
export async function flagOutstanding(userId, { occurredAt = new Date() } = {}) {
  const outstanding = await outstandingForShift(userId);
  for (const item of outstanding) {
    await raiseFlag({
      userId,
      type: FLAG_TYPES.EQUIPMENT_NOT_RETURNED,
      occurredAt,
      refType: 'equipment_assignment',
      refId: item.assignment_id,
      detail: {
        category: item.category,
        label: item.label,
        identifier: item.identifier,
        site: item.site_name,
        issued_at: new Date(item.issued_at).toISOString(),
      },
    });
  }
  return outstanding.length;
}

/** The inventory, with whoever currently holds each item. */
export async function inventory({ siteId = null, category = null, status = null } = {}) {
  const where = ['e.active = true'];
  const params = [];
  if (siteId) {
    where.push('e.site_id = ?');
    params.push(siteId);
  }
  if (category) {
    where.push('e.category = ?');
    params.push(category);
  }
  if (status) {
    where.push('e.status = ?');
    params.push(status);
  }

  return db
    .prepare(
      `SELECT e.*, s.name AS site_name,
              ea.id AS assignment_id, ea.issued_at, ea.issued_condition,
              u.id AS holder_id, u.first_name AS holder_first, u.last_name AS holder_last,
              u.employee_code AS holder_code, u.phone AS holder_phone
       FROM equipment e
       LEFT JOIN sites s ON s.id = e.site_id
       LEFT JOIN LATERAL (
         SELECT * FROM equipment_assignments
         WHERE equipment_id = e.id AND returned_at IS NULL
         ORDER BY issued_at DESC LIMIT 1
       ) ea ON true
       LEFT JOIN users u ON u.id = ea.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY s.name NULLS FIRST, e.category, e.label`
    )
    .all(...params);
}

/** Everything that has happened to one item, newest first. */
export async function history(equipmentId, { limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT ea.*, u.first_name, u.last_name, u.employee_code,
              i.first_name AS issued_by_first, i.last_name AS issued_by_last,
              r.first_name AS returned_to_first, r.last_name AS returned_to_last
       FROM equipment_assignments ea
       JOIN users u ON u.id = ea.user_id
       LEFT JOIN users i ON i.id = ea.issued_by
       LEFT JOIN users r ON r.id = ea.returned_to
       WHERE ea.equipment_id = ?
       ORDER BY ea.issued_at DESC
       LIMIT ?`
    )
    .all(equipmentId, limit);
}
