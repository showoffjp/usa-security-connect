/**
 * Demo patrol vehicles: two weeks of checks and miles, and the state a fleet
 * manager walks in to.
 *
 *   - A garage patrol truck at Riverfront and a campus patrol car at the
 *     research park join the two vehicles at the armed sites.
 *   - Each vehicle was signed out for shifts worked at its site, with a start
 *     and end check and the miles of each stretch.
 *   - One failed its brake check at its last hand-back and is off the road; one
 *     is past its service, with a minor fault noted; another is close to it.
 *   - Marcus Bell (1003, on duty now) has the Riverfront truck and has not done
 *     his start check yet, so the officer's home screen asks for one.
 */

import { toSql } from './services/compliance.js';
import { VEHICLE_CHECKS } from './shared.js';

const MIN = 60000;
const allOk = () => Object.fromEntries(VEHICLE_CHECKS.map((c) => [c.key, 'ok']));

export async function seedVehicles({ db }) {
  const site = async (name) => db.prepare(`SELECT id FROM sites WHERE name = ?`).get(name);
  const riverfront = await site('Riverfront Commerce Center');
  const campus = await site('Sunshine State University Research Park');
  for (const [s, label, id, note] of [
    [riverfront, 'Garage patrol truck', 'VEH-RF1', 'Ford Ranger. Garage levels P1-P4 and the loading dock. Keys in the console lockbox.'],
    [campus, 'Campus patrol car', 'VEH-RP1', 'Marked Ford Explorer for the campus mobile patrol. Fuel card in the glovebox.'],
  ]) {
    if (!s) continue;
    await db
      .prepare(
        `INSERT INTO equipment (site_id, category, label, identifier, notes, return_by_end_of_shift, armed_only, status)
         VALUES (?, 'vehicle', ?, ?, ?, false, false, 'available')`
      )
      .run(s.id, label, id, note);
  }

  const vehicles = await db.prepare(`SELECT * FROM equipment WHERE category = 'vehicle' ORDER BY id`).all();
  const sup = await db.prepare(`SELECT id FROM users WHERE employee_code = '1002'`).get();
  const now = Date.now();
  let inspections = 0;
  let tripCount = 0;
  const bases = [38214, 52870, 21460, 64105];

  for (const [n, v] of vehicles.entries()) {
    let odo = bases[n % bases.length];
    const offRoad = n === 0; // the first armed-site vehicle fails its brake check
    // Shifts worked at the vehicle's site in the last two weeks, one at a time.
    const entries = await db
      .prepare(
        `SELECT te.id, te.user_id, te.clock_in_at, te.clock_out_at FROM time_entries te JOIN posts p ON p.id = te.post_id
         WHERE p.site_id = ? AND te.clock_out_at IS NOT NULL AND te.clock_in_at >= ?
         ORDER BY te.clock_in_at`
      )
      .all(v.site_id, toSql(new Date(now - 14 * 86400000)));
    let free = 0;
    const used = [];
    for (const e of entries) {
      const inAt = new Date(e.clock_in_at).getTime();
      const outAt = new Date(e.clock_out_at).getTime();
      if (inAt < free || outAt - inAt < 3 * 60 * MIN) continue;
      used.push({ ...e, inAt, outAt });
      free = outAt;
    }

    // A service three weeks back, before the history starts.
    await db
      .prepare(`INSERT INTO vehicle_inspections (equipment_id, user_id, kind, odometer, notes, created_at) VALUES (?,?,?,?,?,?)`)
      .run(v.id, sup?.id ?? null, 'service', odo, 'Oil and filter, tyre rotation, wipers replaced.', toSql(new Date(now - 21 * 86400000)));
    inspections += 1;
    const servicedAt = odo;

    for (const [i, e] of used.entries()) {
      const failBrakes = offRoad && i === used.length - 1;
      // Patrol vehicles at a campus or a yard cover more ground than a garage truck.
      const miles = 18 + ((e.id * 37 + n * 11) % 70);
      const assign = await db
        .prepare(
          `INSERT INTO equipment_assignments (equipment_id, user_id, time_entry_id, issued_at, issued_by, issued_condition, returned_at, returned_to, returned_condition)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(v.id, e.user_id, e.id, toSql(new Date(e.inAt + 4 * MIN)), sup?.id ?? null, 'good',
          toSql(new Date(e.outAt - 4 * MIN)), e.user_id, failBrakes ? 'damaged' : 'good');
      const assignmentId = Number(assign.lastInsertRowid);
      await db
        .prepare(`INSERT INTO vehicle_inspections (equipment_id, user_id, assignment_id, kind, odometer, fuel_level, checks, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(v.id, e.user_id, assignmentId, 'start', odo, 3 + (i % 2), JSON.stringify(allOk()), null, toSql(new Date(e.inAt + 9 * MIN)));
      odo += miles;
      const endChecks = allOk();
      let note = null;
      if (failBrakes) {
        endChecks.brakes = 'fail';
        note = 'Brake pedal soft and the car pulls left under braking. Parked it in bay 2.';
      } else if (n === 1 && i === used.length - 2) {
        endChecks.kit = 'fail';
        note = 'Fire extinguisher has lost its safety pin and the gauge reads low.';
      } else if (n === 2 && i === 3) {
        endChecks.lights = 'fail';
        note = 'Rear left brake light out.';
      }
      const end = await db
        .prepare(`INSERT INTO vehicle_inspections (equipment_id, user_id, assignment_id, kind, odometer, fuel_level, checks, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(v.id, e.user_id, assignmentId, 'end', odo, 1 + (i % 3), JSON.stringify(endChecks), note, toSql(new Date(e.outAt - 8 * MIN)));
      inspections += 2;
      tripCount += 1;
      for (const [item, result] of Object.entries(endChecks)) {
        if (result !== 'fail') continue;
        const critical = VEHICLE_CHECKS.find((c) => c.key === item).critical;
        // The brake light was fixed the next morning; the rest are still open.
        const fixed = item === 'lights';
        await db
          .prepare(
            `INSERT INTO vehicle_defects (equipment_id, inspection_id, item, critical, note, reported_by, reported_at, resolved_at, resolved_by, resolution)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .run(v.id, Number(end.lastInsertRowid), item, critical, note, e.user_id, toSql(new Date(e.outAt - 8 * MIN)),
            fixed ? toSql(new Date(e.outAt + 14 * 60 * MIN)) : null, fixed ? sup?.id ?? null : null,
            fixed ? 'Bulb replaced at the depot.' : null);
      }
    }

    // Service due: past it for the second vehicle, close for the third, comfortable otherwise.
    const due = n === 1 ? odo - 140 : n === 2 ? odo + 210 : servicedAt + 5000;
    await db
      .prepare(`UPDATE equipment SET odometer = ?, service_due_miles = ?, status = ? WHERE id = ?`)
      .run(odo, due, offRoad && used.length ? 'maintenance' : 'available', v.id);
  }

  // Marcus has the Riverfront truck tonight and has not checked it yet.
  const truck = vehicles.find((v) => v.identifier === 'VEH-RF1');
  const marcus = await db
    .prepare(
      `SELECT te.id, te.user_id, te.clock_in_at FROM time_entries te JOIN users u ON u.id = te.user_id
       WHERE u.employee_code = '1003' AND te.clock_out_at IS NULL ORDER BY te.clock_in_at DESC LIMIT 1`
    )
    .get();
  if (truck && marcus) {
    await db
      .prepare(
        `INSERT INTO equipment_assignments (equipment_id, user_id, time_entry_id, issued_at, issued_by, issued_condition, issued_note)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(truck.id, marcus.user_id, marcus.id, toSql(new Date(new Date(marcus.clock_in_at).getTime() + 3 * MIN)), sup?.id ?? null, 'good', 'Garage patrol tonight.');
    await db.prepare(`UPDATE equipment SET status = 'issued' WHERE id = ?`).run(truck.id);
  }

  return { vehicles: vehicles.length, inspections, trips: tripCount };
}
