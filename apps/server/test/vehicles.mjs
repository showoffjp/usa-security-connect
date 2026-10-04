/**
 * Patrol vehicles: the walk-round checks, the odometer and the defects.
 *
 * Only the officer holding a vehicle checks it, and every item on the list has
 * to be answered; a failure needs a note. The odometer never goes backwards
 * and a wild jump is refused. A vehicle comes back with its end check, which
 * gives the miles of the stretch. A failed critical check takes the vehicle
 * off the road - it cannot be signed out again until a supervisor signs the
 * repair off - while a minor one is only noted. A service resets when the next
 * one is due. Supervisors get the fleet, the alerts and the mileage report;
 * officers get none of it.
 */

import { call, log, section, signIn, finish } from './harness.mjs';
import { VEHICLE_INSPECT_GRACE_MINUTES } from '../src/shared.js';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const marcus = await signIn('1003', '4812');
const alexis = await signIn('1042', '8598');
log(Boolean(admin && supervisor && marcus && alexis), 'signed in as administrator, supervisor and two officers');

const checks = (fail = []) => Object.fromEntries(
  ['lights', 'brakes', 'tyres', 'dash', 'glass', 'lightbar', 'kit', 'body', 'interior'].map((k) => [k, fail.includes(k) ? 'fail' : 'ok'])
);
const inspect = (id, body, token = marcus) => call(`/vehicles/${id}/inspections`, { token, method: 'POST', body });
const board = async () => (await call('/vehicles', { token: supervisor })).data;
const alerts = async () => (await call('/admin/alerts', { token: supervisor })).data.alerts.filter((a) => a.kind === 'vehicle');

/* =============================================================== fleet === */
section('the fleet');

let fleet = await board();
log(fleet.vehicles.length >= 4 && typeof fleet.summary.offRoad === 'number', 'supervisors see every patrol vehicle', `${fleet.vehicles.length} vehicles`);
log((await call('/vehicles', { token: marcus })).status === 403, 'officers do not');
log((await call('/vehicles')).status === 401, 'nor anyone signed out');
const truck = fleet.vehicles.find((v) => v.identifier === 'VEH-RF1');
const car = fleet.vehicles.find((v) => v.identifier === 'VEH-RP1');
log(Boolean(truck && car), 'the Riverfront truck and the campus car are on the books');
log(truck.holder?.employee_code === '1003' && truck.uninspected, 'Marcus has the truck and has not checked it yet');
// It is raised once the truck has been out half an hour unchecked. The demo signs it
// out just after Marcus clocks in, which is never before a quarter past midnight, so
// in the first minutes of the day it is not overdue yet - and must not be raised.
const outMinutes = (Date.now() - new Date(truck.holder?.issued_at).getTime()) / 60000;
const raised = (await alerts()).some((a) => a.key === `vehicle-uninspected:${truck.holder?.assignment_id}`);
log(Boolean(truck.holder) && raised === truck.uninspected_overdue && (outMinutes > VEHICLE_INSPECT_GRACE_MINUTES + 1 ? raised : outMinutes < VEHICLE_INSPECT_GRACE_MINUTES - 1 ? !raised : true),
  outMinutes > VEHICLE_INSPECT_GRACE_MINUTES ? 'which is in the alerts inbox' : 'not raised yet: it was signed out under half an hour ago', `${Math.round(outMinutes)} min`);
log(fleet.vehicles.some((v) => v.off_road) && (await alerts()).some((a) => a.severity === 'critical'), 'a vehicle that failed its brake check is off the road, and raised as critical');
log((await call(`/vehicles/${truck.id}`, { token: marcus })).status === 403, 'an officer cannot open a vehicle\'s record');

/* ======================================================= the officer === */
section('what the officer sees');

const held = (await call('/equipment/mine', { token: marcus })).data;
log(held.held.some((h) => h.id === truck.id) && held.vehicles.some((v) => v.id === truck.id && v.uninspected), 'the truck is among what Marcus holds, waiting for its start check');
const mine = (await call('/vehicles/mine', { token: marcus })).data;
log(mine.vehicles.length === 1 && mine.checks.length === 9 && mine.fuelLevels.length === 5, 'with the checklist and the fuel gauge to fill in');

/* =========================================================== checking === */
section('the start check');

const odo = truck.odometer;
const good = { kind: 'start', odometer: odo + 2, fuelLevel: 3, checks: checks() };
log((await inspect(truck.id, { ...good, checks: { lights: 'ok' } })).status === 422, 'every item on the list has to be answered');
log((await inspect(truck.id, { ...good, checks: checks(['body']) })).status === 422, 'a failure needs a note saying what is wrong');
const back = await inspect(truck.id, { ...good, odometer: odo - 10 });
log(back.status === 422 && back.data.details?.[0]?.field === 'odometer', 'the odometer cannot go backwards', back.data?.error);
log((await inspect(truck.id, { ...good, odometer: odo + 5000 })).status === 422, 'and a jump of 5,000 miles is taken for a typo');
log((await inspect(truck.id, { ...good, returnVehicle: true })).status === 422, 'a vehicle is handed back with the end check, not the start');
log((await inspect(truck.id, good, alexis)).status === 404, 'nobody else can check a vehicle Marcus is holding');
const started = await inspect(truck.id, good);
log(started.status === 201 && started.data.inspection.kind === 'start' && !started.data.critical, 'Marcus checks the truck before driving', started.data?.error);
log((await inspect(truck.id, good)).status === 409, 'once per sign-out');
log(!(await alerts()).some((a) => a.key.startsWith(`vehicle-uninspected:${truck.holder?.assignment_id}`)), 'and the alert clears');

/* ======================================================= handing back === */
section('the end check');

const selfReturn = await call(`/equipment/mine/${truck.id}/return`, { token: marcus, method: 'POST', body: { condition: 'good' } });
log(selfReturn.status === 409 && selfReturn.data.details?.code === 'end_check', 'a vehicle cannot just be handed back: it needs its end check');
const ended = await inspect(truck.id, {
  kind: 'end', odometer: odo + 2 + 37, fuelLevel: 2, checks: checks(['kit']),
  notes: 'Fire extinguisher pin missing.', returnVehicle: true,
});
log(ended.status === 201 && ended.data.miles === 37 && ended.data.returned, 'Marcus hands the truck back with its end check: 37 miles', ended.data?.error);
log(ended.data.opened.length === 1 && !ended.data.opened[0].critical, 'the missing pin is noted as a minor defect');
fleet = await board();
let now = fleet.vehicles.find((v) => v.id === truck.id);
log(now.status === 'available' && !now.off_road && now.odometer === odo + 39, 'a minor defect does not take the truck off the road', now.status);
log(!(await call('/equipment/mine', { token: marcus })).data.held.some((h) => h.id === truck.id), 'and it is no longer with Marcus');

const minor = now.defects.find((d) => d.item === 'kit');
const resolve = (id, body, token = supervisor) => call(`/vehicles/defects/${id}/resolve`, { token, method: 'POST', body });
log((await resolve(minor.id, { resolution: 'New pin.' }, marcus)).status === 403, 'only a supervisor signs a defect off');
log((await resolve(minor.id, {})).status === 422, 'saying what was done');
log((await resolve(minor.id, { resolution: 'New pin fitted, extinguisher recharged.' })).status === 200, 'a supervisor signs the repair off');
log((await resolve(minor.id, { resolution: 'Again.' })).status === 409, 'once');

/* ===================================================== off the road === */
section('a failed brake check');

const issued = await call(`/equipment/${car.id}/issue`, { token: supervisor, method: 'POST', body: { userId: (await call('/auth/me', { token: alexis })).data.user.id } });
log(issued.status === 201, 'a supervisor signs the campus car out to Alexis', issued.data?.error);
const carOdo = car.odometer;
const bad = await inspect(car.id, { kind: 'start', odometer: carOdo + 1, fuelLevel: 4, checks: checks(['brakes']), notes: 'Brake pedal goes nearly to the floor.' }, alexis);
log(bad.status === 201 && bad.data.critical && bad.data.opened[0]?.critical, 'Alexis fails the brakes at the start check');
fleet = await board();
now = fleet.vehicles.find((v) => v.id === car.id);
log(now.off_road, 'the car is off the road');
const brakeAlert = (await alerts()).find((a) => a.key === `vehicle-defect:${now.defects.find((d) => d.critical).id}`);
log(brakeAlert?.severity === 'critical', 'raised as a critical alert', brakeAlert?.title);
const handBack = await inspect(car.id, { kind: 'end', odometer: carOdo + 1, fuelLevel: 4, checks: checks(['brakes']), notes: 'Not driven.', returnVehicle: true }, alexis);
log(handBack.status === 201 && handBack.data.opened.length === 0, 'handing it straight back does not log the same fault twice');
fleet = await board();
now = fleet.vehicles.find((v) => v.id === car.id);
log(now.status === 'maintenance', 'it goes into maintenance, though she described nothing else wrong', now.status);
const again = await call(`/equipment/${car.id}/issue`, { token: supervisor, method: 'POST', body: { userId: issued.data.assignment.user_id } });
log(again.status === 409 && again.data.details?.code === 'off_road', 'and cannot be signed out again', again.data?.error);
const fix = await resolve(now.defects.find((d) => d.critical).id, { resolution: 'Brake fluid leak at the rear caliper repaired; road-tested.' });
log(fix.status === 200 && fix.data.status === 'available' && !fix.data.offRoad, 'signing the repair off puts it back on the road');

/* ============================================================ service === */
section('servicing');

const overdue = fleet.vehicles.find((v) => v.service.state === 'overdue');
log(Boolean(overdue), 'a vehicle past its service is flagged', overdue?.label);
log((await alerts()).some((a) => a.key.startsWith(`vehicle-service:${overdue.id}:`)), 'in the alerts inbox');
const service = (body, token = supervisor) => call(`/vehicles/${overdue.id}/service`, { token, method: 'POST', body });
log((await service({ odometer: overdue.odometer + 4, notes: 'Oil change.' }, marcus)).status === 403, 'only a supervisor records a service');
log((await service({ odometer: overdue.odometer - 100, notes: 'Oil change.' })).status === 422, 'not at a lower mileage');
log((await service({ odometer: overdue.odometer + 4, notes: 'Oil change.', nextDueMiles: overdue.odometer })).status === 422, 'and the next one is due after this one');
const done = await service({ odometer: overdue.odometer + 4, notes: 'Oil and filter, brake pads checked.' });
log(done.status === 201 && done.data.service_due_miles === overdue.odometer + 4 + 5000 && done.data.vehicle.service.state === 'ok', 'a service sets the next one 5,000 miles on');
log(!(await alerts()).some((a) => a.key.startsWith(`vehicle-service:${overdue.id}:`)), 'and the alert clears');

/* ============================================================ history === */
section('the record and the miles');

const record = (await call(`/vehicles/${truck.id}`, { token: supervisor })).data;
log(record.inspections[0].kind === 'end' && record.inspections[0].odometer === odo + 39 && record.inspections[0].officer === 'Marcus Bell', 'the truck\'s record has Marcus\'s checks, newest first');
log(record.trips[0]?.miles === 37 && record.defects.some((d) => d.item === 'kit' && d.resolved_at), 'with the trip and the signed-off defect');
const report = await call('/admin/reports/vehicle-mileage', { token: admin });
const row = report.data.rows.find((r) => r.identifier === 'VEH-RF1');
log(report.status === 200 && row?.miles > 0 && row.trips >= 1, 'the mileage report counts each vehicle\'s miles from the readings', `${row?.miles} miles, ${row?.trips} trips`);
const csv = await fetch(`${process.env.USC_TEST_BASE || 'http://localhost:4000/api'}/admin/reports/vehicle-mileage/export.csv`, { headers: { Authorization: `Bearer ${admin}` } });
log(csv.status === 200 && (await csv.text()).startsWith('Vehicle,'), 'and exports to CSV');
const actions = (await call('/admin/audit?action=vehicle.', { token: admin })).data.entries.map((e) => e.action);
log(actions.includes('vehicle.inspected') && actions.includes('vehicle.defect_resolved') && actions.includes('vehicle.serviced'), 'every check, repair and service is audited');

const dana = (await call('/client/login', { method: 'POST', body: { email: 'dana.whitfield@riverfrontholdings.com', password: 'riverfront-portal-01' } })).data?.token;
const riverfrontId = (await call('/client/me', { token: dana })).data.sites.find((s) => /Riverfront/.test(s.name))?.id;
const month = (await call(`/client/monthly?siteId=${riverfrontId}`, { token: dana })).data;
log(month?.vehicles?.miles > 0 && month.vehicles.trips >= 1, 'Riverfront\'s monthly report shows the patrol truck\'s miles', `${month?.vehicles?.miles} miles`);
log(!JSON.stringify(month.vehicles).includes('Marcus'), 'without who drove');

finish('Patrol vehicles suite');
