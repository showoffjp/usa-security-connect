/**
 * Patrol vehicles: the walk-round check, the odometer and the defects.
 *
 * A vehicle is an equipment item, so who has it is still the chain of custody
 * in equipment.js. What this adds is the vehicle's condition and its miles:
 *
 *   * The officer who signs a vehicle out inspects it before driving and again
 *     when they hand it back, with an odometer reading each time. The miles of
 *     a stretch are the difference, and the readings are the only place the
 *     mileage comes from - nobody types a "miles driven" figure.
 *   * A reading can never go backwards, and a jump far past the last one is
 *     refused as a typo rather than recorded as a 9,000-mile night.
 *   * A failed critical check (brakes, tyres, lights...) opens a defect that
 *     takes the vehicle off the road: it cannot be signed out again, and goes
 *     into maintenance when it comes back, until a supervisor records the fix.
 *   * The next service is due at a mileage, so "due soon" follows the odometer.
 */

import { db } from '../lib/db.js';
import { HttpError, sqlToIso } from '../lib/http.js';
import {
  VEHICLE_CHECKS,
  VEHICLE_CHECK_LABEL,
  VEHICLE_MAX_TRIP_MILES,
  VEHICLE_SERVICE_MILES,
  VEHICLE_INSPECT_GRACE_MINUTES,
  serviceState,
} from '../shared.js';
import { toSql } from './compliance.js';
import { currentHolder } from './equipment.js';

const CRITICAL = new Set(VEHICLE_CHECKS.filter((c) => c.critical).map((c) => c.key));

export async function loadVehicle(id) {
  return db.prepare(`SELECT * FROM equipment WHERE id = ? AND category = 'vehicle'`).get(id);
}

export async function openDefects(equipmentId) {
  return db
    .prepare(
      `SELECT d.*, u.first_name || ' ' || u.last_name AS reported_by_name
       FROM vehicle_defects d LEFT JOIN users u ON u.id = d.reported_by
       WHERE d.equipment_id = ? AND d.resolved_at IS NULL
       ORDER BY d.critical DESC, d.reported_at`
    )
    .all(equipmentId);
}

/** The first open critical defect, which is the reason a vehicle is off the road. */
export async function offRoadReason(equipmentId) {
  const d = (await openDefects(equipmentId)).find((x) => x.critical);
  return d ? `Off the road: ${VEHICLE_CHECK_LABEL[d.item] || d.item} failed inspection.` : null;
}

export const presentDefect = (d) => ({
  id: d.id,
  item: d.item,
  label: VEHICLE_CHECK_LABEL[d.item] || d.item,
  critical: Boolean(d.critical),
  note: d.note,
  reported_by: d.reported_by_name || null,
  reported_at: sqlToIso(d.reported_at),
  resolved_at: sqlToIso(d.resolved_at),
  resolution: d.resolution || null,
});

export const presentInspection = (i) => {
  const checks = i.checks ? JSON.parse(i.checks) : null;
  return {
    id: i.id,
    kind: i.kind,
    odometer: i.odometer,
    fuel_level: i.fuel_level,
    checks,
    failed: checks ? Object.keys(checks).filter((k) => checks[k] === 'fail') : [],
    notes: i.notes,
    officer: i.officer || null,
    created_at: sqlToIso(i.created_at),
  };
};

/** The inspections on one stretch with the vehicle. */
async function onAssignment(assignmentId) {
  if (!assignmentId) return [];
  return db.prepare(`SELECT * FROM vehicle_inspections WHERE assignment_id = ? ORDER BY created_at`).all(assignmentId);
}

/**
 * Record a walk-round check (start or end) or a service.
 *
 * `checks` is {item: 'ok'|'fail'} for every item on the list; the route has
 * already insisted on all of them. Returns the inspection, the defects it
 * opened, and the miles since the start check when this is the end one.
 */
export async function recordInspection({ vehicle, userId, kind, odometer, fuelLevel = null, checks = null, notes = null, assignmentId = null, allowJump = false }) {
  const last = vehicle.odometer;
  if (last != null && odometer < last) {
    throw new HttpError(422, `The odometer cannot go backwards: the last reading was ${last.toLocaleString('en-US')} miles.`, [
      { field: 'odometer', message: `At least ${last.toLocaleString('en-US')}.` },
    ]);
  }
  if (last != null && !allowJump && odometer - last > VEHICLE_MAX_TRIP_MILES) {
    throw new HttpError(422, `That is ${(odometer - last).toLocaleString('en-US')} miles since the last reading of ${last.toLocaleString('en-US')}. Check the odometer and try again.`, [
      { field: 'odometer', message: 'Check the reading.' },
    ]);
  }

  const earlier = await onAssignment(assignmentId);
  if (kind === 'start' && earlier.some((i) => i.kind === 'start')) {
    throw new HttpError(409, 'This vehicle was already inspected when you took it. Do the end check when you hand it back.');
  }
  if (kind === 'end' && earlier.some((i) => i.kind === 'end')) {
    throw new HttpError(409, 'The end check for this vehicle is already done.');
  }

  const info = await db
    .prepare(
      `INSERT INTO vehicle_inspections (equipment_id, user_id, assignment_id, kind, odometer, fuel_level, checks, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(vehicle.id, userId, assignmentId, kind, odometer, fuelLevel, checks ? JSON.stringify(checks) : null, notes, toSql(new Date()));
  const inspectionId = Number(info.lastInsertRowid);
  await db.prepare(`UPDATE equipment SET odometer = ? WHERE id = ?`).run(odometer, vehicle.id);

  // One open defect per item: a brake fault reported at the start and again
  // at the end of the same night is one fault.
  const failed = checks ? Object.keys(checks).filter((k) => checks[k] === 'fail') : [];
  const open = new Set((await openDefects(vehicle.id)).map((d) => d.item));
  const opened = [];
  for (const item of failed) {
    if (open.has(item)) continue;
    const d = await db
      .prepare(
        `INSERT INTO vehicle_defects (equipment_id, inspection_id, item, critical, note, reported_by, reported_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(vehicle.id, inspectionId, item, CRITICAL.has(item), notes, userId, toSql(new Date()));
    opened.push({ id: Number(d.lastInsertRowid), item, label: VEHICLE_CHECK_LABEL[item] || item, critical: CRITICAL.has(item) });
  }

  const critical = failed.some((k) => CRITICAL.has(k));
  // Sitting in the yard, it goes straight into maintenance. With an officer,
  // it does when they hand it back (equipment.returnItem looks at the defects).
  if (critical && !(await currentHolder(vehicle.id))) {
    await db.prepare(`UPDATE equipment SET status = 'maintenance' WHERE id = ?`).run(vehicle.id);
  }

  const start = earlier.find((i) => i.kind === 'start');
  return {
    inspection: presentInspection(await db.prepare(`SELECT * FROM vehicle_inspections WHERE id = ?`).get(inspectionId)),
    opened,
    critical,
    miles: kind === 'end' && start ? odometer - start.odometer : null,
  };
}

/** A service: an odometer reading, what was done, and when the next one is due. */
export async function recordService({ vehicle, userId, odometer, notes, nextDueMiles = null }) {
  const result = await recordInspection({ vehicle, userId, kind: 'service', odometer, notes, allowJump: true });
  const due = nextDueMiles ?? odometer + VEHICLE_SERVICE_MILES;
  await db.prepare(`UPDATE equipment SET service_due_miles = ? WHERE id = ?`).run(due, vehicle.id);
  return { ...result, service_due_miles: due };
}

/** Close a defect; the last critical one closed puts a vehicle in maintenance back on the road. */
export async function resolveDefect(defect, { userId, resolution }) {
  await db
    .prepare(`UPDATE vehicle_defects SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?`)
    .run(toSql(new Date()), userId, resolution, defect.id);
  const vehicle = await db.prepare(`SELECT * FROM equipment WHERE id = ?`).get(defect.equipment_id);
  const stillOff = (await openDefects(vehicle.id)).some((d) => d.critical);
  let status = vehicle.status;
  if (!stillOff && vehicle.status === 'maintenance' && !(await currentHolder(vehicle.id))) {
    status = 'available';
    await db.prepare(`UPDATE equipment SET status = 'available' WHERE id = ?`).run(vehicle.id);
  }
  return { status, offRoad: stillOff };
}

/**
 * Miles a vehicle covered between two moments: the last reading by the end,
 * less the last reading before the start (or the first one inside it, for a
 * vehicle with no history before then).
 */
export async function milesBetween(equipmentId, from, to) {
  const end = await db
    .prepare(`SELECT odometer FROM vehicle_inspections WHERE equipment_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`)
    .get(equipmentId, toSql(to));
  if (!end) return 0;
  const before = await db
    .prepare(`SELECT odometer FROM vehicle_inspections WHERE equipment_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`)
    .get(equipmentId, toSql(from));
  const first = before || (await db
    .prepare(`SELECT odometer FROM vehicle_inspections WHERE equipment_id = ? AND created_at >= ? ORDER BY created_at LIMIT 1`)
    .get(equipmentId, toSql(from)));
  return Math.max(0, end.odometer - (first?.odometer ?? end.odometer));
}

/**
 * Each completed stretch with a vehicle: start check to end check on the same
 * sign-out, with who drove and how far.
 */
export async function trips({ from, to, equipmentId = null, userId = null, siteId = null }) {
  const rows = await db
    .prepare(
      `SELECT en.id, en.equipment_id, en.user_id, en.created_at AS ended_at, en.odometer AS end_odometer,
              st.created_at AS started_at, st.odometer AS start_odometer,
              e.label AS vehicle, e.identifier, s.id AS site_id, s.name AS site_name,
              u.first_name || ' ' || u.last_name AS officer
       FROM vehicle_inspections en
       JOIN vehicle_inspections st ON st.assignment_id = en.assignment_id AND st.kind = 'start'
       JOIN equipment e ON e.id = en.equipment_id
       LEFT JOIN sites s ON s.id = e.site_id
       LEFT JOIN users u ON u.id = en.user_id
       WHERE en.kind = 'end' AND en.created_at >= ? AND en.created_at < ?
         ${equipmentId ? 'AND en.equipment_id = ?' : ''}
         ${userId ? 'AND en.user_id = ?' : ''}
         ${siteId ? 'AND e.site_id = ?' : ''}
       ORDER BY en.created_at DESC`
    )
    .all(toSql(from), toSql(to), ...[equipmentId, userId, siteId].filter(Boolean));
  return rows.map((r) => ({
    id: r.id,
    equipment_id: r.equipment_id,
    vehicle: r.vehicle,
    identifier: r.identifier,
    site_id: r.site_id,
    site_name: r.site_name,
    officer: r.officer,
    user_id: r.user_id,
    started_at: sqlToIso(r.started_at),
    ended_at: sqlToIso(r.ended_at),
    start_odometer: r.start_odometer,
    end_odometer: r.end_odometer,
    miles: r.end_odometer - r.start_odometer,
  }));
}

/** Where one vehicle stands: who has it, whether it is checked, its defects and its service. */
export async function vehicleStatus(vehicle, now = new Date()) {
  const holder = await currentHolder(vehicle.id);
  const defects = await openDefects(vehicle.id);
  const last = await db
    .prepare(
      `SELECT i.*, u.first_name || ' ' || u.last_name AS officer FROM vehicle_inspections i
       LEFT JOIN users u ON u.id = i.user_id WHERE i.equipment_id = ? ORDER BY i.created_at DESC LIMIT 1`
    )
    .get(vehicle.id);
  const onThis = holder ? await onAssignment(holder.id) : [];
  const started = onThis.find((i) => i.kind === 'start');
  const issuedAt = holder ? new Date(sqlToIso(holder.issued_at)) : null;
  const uninspected = Boolean(holder && !started);
  return {
    id: vehicle.id,
    label: vehicle.label,
    identifier: vehicle.identifier,
    site_id: vehicle.site_id,
    status: vehicle.status,
    odometer: vehicle.odometer,
    service_due_miles: vehicle.service_due_miles,
    service: serviceState(vehicle.odometer, vehicle.service_due_miles),
    holder: holder
      ? { id: holder.user_id, name: `${holder.first_name} ${holder.last_name}`, employee_code: holder.employee_code, assignment_id: holder.id, issued_at: sqlToIso(holder.issued_at) }
      : null,
    start_inspection: started ? presentInspection(started) : null,
    uninspected,
    uninspected_overdue: uninspected && now - issuedAt > VEHICLE_INSPECT_GRACE_MINUTES * 60000,
    off_road: defects.some((d) => d.critical),
    defects: defects.map(presentDefect),
    last_inspection: last ? presentInspection(last) : null,
  };
}

/** Every vehicle on the books, with its status and the miles of the last 7 and 30 days. */
export async function fleet(now = new Date()) {
  const vehicles = await db
    .prepare(
      `SELECT e.*, s.name AS site_name FROM equipment e LEFT JOIN sites s ON s.id = e.site_id
       WHERE e.category = 'vehicle' AND e.active = true ORDER BY s.name NULLS FIRST, e.label`
    )
    .all();
  const out = [];
  for (const v of vehicles) {
    out.push({
      ...(await vehicleStatus(v, now)),
      site_name: v.site_name,
      miles_7d: await milesBetween(v.id, new Date(now - 7 * 86400000), now),
      miles_30d: await milesBetween(v.id, new Date(now - 30 * 86400000), now),
    });
  }
  return out;
}

/** The vehicles an officer has signed out, as their home screen shows them. */
export async function vehiclesHeldBy(userId) {
  const rows = await db
    .prepare(
      `SELECT e.* FROM equipment_assignments ea JOIN equipment e ON e.id = ea.equipment_id
       WHERE ea.user_id = ? AND ea.returned_at IS NULL AND e.category = 'vehicle'`
    )
    .all(userId);
  return Promise.all(rows.map((v) => vehicleStatus(v)));
}
