/**
 * Keys, radios and firearms.
 *
 * The valuable behaviour here is nearly all refusal - two people cannot hold
 * one key ring, an unlicensed officer cannot draw a weapon, an item cannot be
 * quietly marked available while somebody still has it - so that is what most
 * of this asserts. The one positive case that matters is the chain of custody
 * surviving a full round trip with both conditions on it.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const officer = await signIn('1003', '4812');

log(Boolean(admin && supervisor && officer), 'signed in across all three tiers');

/* =============================================================== who sees */
section('who can see the equipment room');

const inv = await call('/equipment', { token: supervisor });
log(inv.status === 200 && inv.data.equipment.length > 0, 'a supervisor sees the inventory',
  `${inv.data?.equipment?.length} items`);
log(inv.data.summary.total > 0 && inv.data.summary.available > 0,
  'summarised by status', JSON.stringify(inv.data.summary));

log((await call('/equipment', { token: officer })).status === 403,
  'an officer cannot browse the inventory');

const mine = await call('/equipment/mine', { token: officer });
log(mine.status === 200 && Array.isArray(mine.data.held),
  'but an officer can see what they are holding', `${mine.data?.held?.length} items`);

/* ================================================================ issuing */
section('signing something out');

const items = inv.data.equipment;
const spare = items.find((e) => e.category === 'radio' && e.status === 'available');
const keys = items.find((e) => e.category === 'keys' && e.status === 'available');
const weapon = items.find((e) => e.armed_only);
const vehicle = items.find((e) => e.category === 'vehicle');

const people = (await call('/admin/employees', { token: admin })).data.employees;
const marcus = people.find((p) => p.employee_code === '1003');

const issued = await call(`/equipment/${spare.id}/issue`, {
  token: supervisor, method: 'POST',
  body: { userId: marcus.id, condition: 'good', note: 'Night shift' },
});
log(issued.status === 201, 'a supervisor signs a radio out to an officer', issued.data?.error);

const twice = await call(`/equipment/${spare.id}/issue`, {
  token: supervisor, method: 'POST', body: { userId: marcus.id },
});
log(twice.status === 409 && twice.data?.details?.code === 'already_out',
  'the same item cannot go to two people', twice.data?.error);

const nowMine = await call('/equipment/mine', { token: officer });
log(nowMine.data.held.some((h) => h.id === spare.id),
  'and the officer can now see it against their own name');
log(nowMine.data.mustReturnBeforeClockOut > 0,
  'flagged as something to hand back before clocking out',
  `${nowMine.data?.mustReturnBeforeClockOut}`);

log((await call(`/equipment/${keys.id}/issue`, { token: officer, method: 'POST', body: { userId: marcus.id } })).status === 403,
  'an officer cannot sign things out to themselves');

const ghost = await call('/equipment/99999/issue', {
  token: supervisor, method: 'POST', body: { userId: marcus.id },
});
log(ghost.status === 404, 'an item that is not on the inventory cannot be issued');

/* ================================================================== armed */
section('a firearm needs the licence');

const armedToMarcus = await call(`/equipment/${weapon.id}/issue`, {
  token: supervisor, method: 'POST', body: { userId: marcus.id },
});
log(armedToMarcus.status === 422 && /class g/i.test(armedToMarcus.data?.error || ''),
  'an officer without a current Class G is refused, and told why', armedToMarcus.data?.error);

const armedOfficer = people.find(
  (p) => p.status === 'active' && /class g/i.test(p.license_type || '')
);
if (armedOfficer) {
  const ok = await call(`/equipment/${weapon.id}/issue`, {
    token: supervisor, method: 'POST', body: { userId: armedOfficer.id },
  });
  log(ok.status === 201, 'a Class G holder can draw it',
    `${armedOfficer.first_name} ${armedOfficer.last_name}`);
  await call(`/equipment/${weapon.id}/return`, { token: supervisor, method: 'POST', body: {} });
} else {
  log(false, 'no active Class G officer in the seed to draw a weapon');
}

/* ================================================================ returns */
section('taking it back');

const damaged = await call(`/equipment/${spare.id}/return`, {
  token: supervisor, method: 'POST',
  body: { condition: 'damaged', note: 'Aerial snapped' },
});
log(damaged.status === 200 && damaged.data.status === 'maintenance',
  'an item handed back damaged goes to maintenance, not back on the shelf',
  damaged.data?.status);

const again = await call(`/equipment/${spare.id}/return`, { token: supervisor, method: 'POST', body: {} });
log(again.status === 409, 'and it cannot be returned twice', again.data?.error);

const chain = await call(`/equipment/${spare.id}/history`, { token: supervisor });
const last = chain.data.history[0];
log(chain.status === 200 && last.returned_at && last.issued_condition === 'good' && last.returned_condition === 'damaged',
  'the chain of custody keeps both ends and both conditions',
  `${last?.issued_condition} -> ${last?.returned_condition}`);
log(Boolean(last.first_name && last.issued_by_first),
  'and records who held it and who handed it over',
  `${last?.first_name} ${last?.last_name}, by ${last?.issued_by_first}`);

/* ============================================================ the officer */
section('an officer hands something back themselves');

const selfIssue = await call(`/equipment/${keys.id}/issue`, {
  token: supervisor, method: 'POST', body: { userId: marcus.id },
});
log(selfIssue.status === 201, 'keys signed out to the officer');

const notMine = items.find((e) => e.id !== keys.id && e.status === 'available' && !e.armed_only);
log((await call(`/equipment/mine/${notMine.id}/return`, { token: officer, method: 'POST', body: {} })).status === 404,
  'an officer cannot hand back something they never had');

const selfReturn = await call(`/equipment/mine/${keys.id}/return`, {
  token: officer, method: 'POST', body: { condition: 'good' },
});
log(selfReturn.status === 200, 'but can hand back what they do have', selfReturn.data?.error);

/* ============================================== what does not come back -- */
section('what goes home in a pocket');

// Issue to somebody who is definitively not on shift, then sweep.
const offDuty = people.find(
  (p) => p.status === 'active' && p.id !== marcus.id && !/class g/i.test(p.license_type || '')
);
const stray = await call(`/equipment/${keys.id}/issue`, {
  token: supervisor, method: 'POST', body: { userId: offDuty.id },
});
log(stray.status === 201, 'a key ring goes out to an officer who is not clocked in');

const sweep = await call('/cron/sweep', { token: process.env.CRON_SECRET || 'verify-only-cron-secret' });
log(sweep.status === 200 && sweep.data.equipmentOut >= 1,
  'the sweep counts what is still out after the shift', `${sweep.data?.equipmentOut} outstanding`);

const flags = (await call('/admin/flags', { token: admin })).data.flags;
const eq = flags.filter((f) => f.type === 'equipment_not_returned');
log(eq.length > 0, 'and raises a flag naming the item', eq[0] && JSON.stringify(eq[0].detail));
log(eq.every((f) => f.detail && f.detail.label), 'every such flag says which item it was about');

const before = eq.length;
await call('/cron/sweep', { token: process.env.CRON_SECRET || 'verify-only-cron-secret' });
const after = (await call('/admin/flags', { token: admin })).data.flags
  .filter((f) => f.type === 'equipment_not_returned').length;
log(after === before, 'sweeping twice does not raise it twice', `${before} then ${after}`);

/* =============================================================== the admin */
section('changing the inventory');

log((await call('/equipment', {
  token: supervisor, method: 'POST',
  body: { category: 'radio', label: 'Supervisor should not manage this' },
})).status === 403, 'a supervisor cannot add an item');

const created = await call('/equipment', {
  token: admin, method: 'POST',
  body: { category: 'keys', label: 'Test cabinet key', identifier: 'TEST-1', returnByEndOfShift: true },
});
log(created.status === 201, 'an administrator can', created.data?.error);

const stillOut = await call(`/equipment/${keys.id}`, {
  token: admin, method: 'PATCH', body: { status: 'available' },
});
log(stillOut.status === 409 && stillOut.data?.details?.code === 'still_out',
  'an item somebody is holding cannot be quietly marked available', stillOut.data?.error);

const lost = await call(`/equipment/${keys.id}`, { token: admin, method: 'PATCH', body: { status: 'lost' } });
log(lost.status === 200, 'but it can be recorded as missing while they still have it');

const retired = await call(`/equipment/${created.data.item.id}`, {
  token: admin, method: 'PATCH', body: { active: false },
});
log(retired.status === 200, 'and an item can be retired');
log(!(await call('/equipment', { token: supervisor })).data.equipment.some((e) => e.id === created.data.item.id),
  'after which it leaves the inventory');

finish('equipment');
