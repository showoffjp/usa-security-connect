/**
 * Patrol vehicles.
 *
 *   * The officer holding a vehicle does its start and end walk-round checks,
 *     and can hand it back with the end one.
 *   * Supervisors see the fleet, record a service and sign defects off as
 *     fixed - which is what puts a vehicle back on the road.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam, sqlToIso } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, VEHICLE_CHECKS, VEHICLE_CHECK_LABEL, FUEL_LEVELS } from '../shared.js';
import { currentHolder, returnItem } from '../services/equipment.js';
import {
  loadVehicle,
  recordInspection,
  recordService,
  resolveDefect,
  vehicleStatus,
  vehiclesHeldBy,
  fleet,
  trips,
  presentInspection,
  presentDefect,
} from '../services/vehicles.js';
import { pushAsync, supervisorIds } from '../services/push.js';

export const vehiclesRouter = Router();
vehiclesRouter.use(requireAuth);

const onlySupervisor = requireRole(ROLES.SUPERVISOR);
const odometer = z.number({ invalid_type_error: 'Enter the odometer reading.' }).int('Whole miles.').min(0).max(2000000);

const inspectionSchema = z
  .object({
    kind: z.enum(['start', 'end']),
    odometer,
    fuelLevel: z.number().int().min(0).max(FUEL_LEVELS.length - 1),
    checks: z.record(z.enum(['ok', 'fail'])),
    notes: z.string().trim().max(500).optional(),
    returnVehicle: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    const missing = VEHICLE_CHECKS.filter((c) => !d.checks[c.key]);
    if (missing.length) {
      ctx.addIssue({ code: 'custom', path: ['checks'], message: `Check every item: ${missing.map((c) => c.label).join(', ')}.` });
    }
    const unknown = Object.keys(d.checks).filter((k) => !VEHICLE_CHECK_LABEL[k]);
    if (unknown.length) ctx.addIssue({ code: 'custom', path: ['checks'], message: 'Unknown check.' });
    const failed = Object.values(d.checks).includes('fail');
    if (failed && (d.notes || '').length < 5) {
      ctx.addIssue({ code: 'custom', path: ['notes'], message: 'Say what is wrong, so the workshop knows.' });
    }
    if (d.returnVehicle && d.kind !== 'end') {
      ctx.addIssue({ code: 'custom', path: ['returnVehicle'], message: 'A vehicle is handed back with the end check.' });
    }
  });

/* ------------------------------------------------------------ officer -- */

/** The vehicles I have signed out, with what each still needs from me. */
vehiclesRouter.get(
  '/mine',
  wrap(async (req, res) => {
    res.json({ vehicles: await vehiclesHeldBy(req.user.id), checks: VEHICLE_CHECKS, fuelLevels: FUEL_LEVELS });
  })
);

/** A start or end check by the officer holding the vehicle. */
vehiclesRouter.post(
  '/:id/inspections',
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'vehicle');
    const body = parse(inspectionSchema, req.body);
    const vehicle = await loadVehicle(id);
    if (!vehicle) throw new HttpError(404, 'Vehicle not found.');
    const holder = await currentHolder(id);
    if (!holder || holder.user_id !== req.user.id) throw new HttpError(404, 'You do not have that vehicle signed out.');

    const result = await recordInspection({
      vehicle,
      userId: req.user.id,
      kind: body.kind,
      odometer: body.odometer,
      fuelLevel: body.fuelLevel,
      checks: body.checks,
      notes: body.notes || null,
      assignmentId: holder.id,
    });
    await audit(req.user.id, `vehicle.inspected`, 'equipment', id, {
      kind: body.kind, odometer: body.odometer, failed: result.inspection.failed,
    }, req.ip);

    if (result.critical) {
      const what = result.opened.filter((d) => d.critical).map((d) => d.label).join(', ') || 'a safety check';
      pushAsync(await supervisorIds(), {
        title: `Vehicle off the road: ${vehicle.label}`,
        body: `${req.user.first_name} ${req.user.last_name}: ${what} failed inspection.`.slice(0, 160),
        data: { type: 'vehicle', id },
        priority: 'high',
      });
    }

    let returned = false;
    if (body.returnVehicle) {
      const back = await returnItem({
        equipmentId: id,
        returnedTo: req.user.id,
        // Only a critical fault sends it to the workshop; a missing extinguisher
        // pin is fixed at the depot without taking the car off the road.
        condition: result.critical ? 'damaged' : 'good',
        note: `Handed back after the end check at ${body.odometer.toLocaleString('en-US')} miles.`,
      });
      returned = back.ok;
      await audit(req.user.id, 'equipment.returned', 'equipment', id, { selfReturn: true, vehicle: true }, req.ip);
    }

    const fresh = await loadVehicle(id);
    res.status(201).json({ ...result, returned, vehicle: await vehicleStatus(fresh) });
  })
);

/* --------------------------------------------------------- supervisor -- */

vehiclesRouter.get(
  '/',
  onlySupervisor,
  wrap(async (_req, res) => {
    const vehicles = await fleet();
    res.json({
      vehicles,
      summary: {
        total: vehicles.length,
        out: vehicles.filter((v) => v.holder).length,
        offRoad: vehicles.filter((v) => v.off_road).length,
        serviceDue: vehicles.filter((v) => ['due', 'overdue'].includes(v.service.state)).length,
        uninspected: vehicles.filter((v) => v.uninspected_overdue).length,
      },
      checks: VEHICLE_CHECKS,
      fuelLevels: FUEL_LEVELS,
    });
  })
);

/** One vehicle: its checks and services, its defects, and the last month's trips. */
vehiclesRouter.get(
  '/:id',
  onlySupervisor,
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'vehicle');
    const vehicle = await loadVehicle(id);
    if (!vehicle) throw new HttpError(404, 'Vehicle not found.');
    const inspections = await db
      .prepare(
        `SELECT i.*, u.first_name || ' ' || u.last_name AS officer FROM vehicle_inspections i
         LEFT JOIN users u ON u.id = i.user_id WHERE i.equipment_id = ? ORDER BY i.created_at DESC LIMIT 60`
      )
      .all(id);
    const defects = await db
      .prepare(
        `SELECT d.*, u.first_name || ' ' || u.last_name AS reported_by_name, r.first_name || ' ' || r.last_name AS resolved_by_name
         FROM vehicle_defects d LEFT JOIN users u ON u.id = d.reported_by LEFT JOIN users r ON r.id = d.resolved_by
         WHERE d.equipment_id = ? ORDER BY d.resolved_at IS NULL DESC, d.reported_at DESC LIMIT 40`
      )
      .all(id);
    const now = new Date();
    const site = vehicle.site_id ? await db.prepare(`SELECT name FROM sites WHERE id = ?`).get(vehicle.site_id) : null;
    res.json({
      vehicle: { ...(await vehicleStatus(vehicle)), site_name: site?.name || null },
      inspections: inspections.map(presentInspection),
      defects: defects.map((d) => ({ ...presentDefect(d), resolved_by: d.resolved_by_name || null })),
      trips: await trips({ from: new Date(now - 30 * 86400000), to: now, equipmentId: id }),
      checks: VEHICLE_CHECKS,
      fuelLevels: FUEL_LEVELS,
    });
  })
);

vehiclesRouter.post(
  '/:id/service',
  onlySupervisor,
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'vehicle');
    const body = parse(
      z.object({
        odometer,
        notes: z.string().trim().min(3, 'Say what was done.').max(500),
        nextDueMiles: z.number().int().positive().max(2000000).optional(),
      }),
      req.body
    );
    const vehicle = await loadVehicle(id);
    if (!vehicle) throw new HttpError(404, 'Vehicle not found.');
    if (body.nextDueMiles != null && body.nextDueMiles <= body.odometer) {
      throw new HttpError(422, 'The next service has to be due after this one.', [{ field: 'nextDueMiles', message: 'Past the current odometer.' }]);
    }
    const result = await recordService({ vehicle, userId: req.user.id, odometer: body.odometer, notes: body.notes, nextDueMiles: body.nextDueMiles });
    await audit(req.user.id, 'vehicle.serviced', 'equipment', id, { odometer: body.odometer, next: result.service_due_miles }, req.ip);
    res.status(201).json({ ...result, vehicle: await vehicleStatus(await loadVehicle(id)) });
  })
);

vehiclesRouter.post(
  '/defects/:id/resolve',
  onlySupervisor,
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'defect');
    const body = parse(z.object({ resolution: z.string().trim().min(3, 'Say what was done about it.').max(500) }), req.body);
    const defect = await db.prepare(`SELECT * FROM vehicle_defects WHERE id = ?`).get(id);
    if (!defect) throw new HttpError(404, 'Defect not found.');
    if (defect.resolved_at) throw new HttpError(409, `That was already signed off on ${sqlToIso(defect.resolved_at).slice(0, 10)}.`);
    const result = await resolveDefect(defect, { userId: req.user.id, resolution: body.resolution });
    await audit(req.user.id, 'vehicle.defect_resolved', 'equipment', defect.equipment_id, { defect: id, item: defect.item }, req.ip);
    res.json({ ...result, vehicle: await vehicleStatus(await loadVehicle(defect.equipment_id)) });
  })
);
