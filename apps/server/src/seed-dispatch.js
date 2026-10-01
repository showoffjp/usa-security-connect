/**
 * Demo calls for service: a month of cleared calls across the sites, each
 * one answered by an officer who really was on duty there at the time, and a
 * live board - a client's call nobody has been sent to yet, one waiting on
 * Marcus Bell to acknowledge, one on the way and one on scene.
 */

import { toSql } from './services/compliance.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const MIN = 60000;

const SCRIPTS = {
  alarm: [
    ['Intrusion alarm, loading dock door 3.', 'Door found secure; contact sensor misaligned. Reset the panel and told the property manager.', 'referred'],
    ['Fire panel trouble signal in the lobby.', 'Trouble signal from a low battery on panel 2. No fire. Logged for the alarm company.', 'referred'],
    ['Glass-break alarm, ground floor east.', 'Walked the floor and checked every window. Nothing broken; reset with the monitoring centre.', 'nothing_found'],
  ],
  suspicious: [
    ['Man trying car door handles in the north lot.', 'Located the subject, who left on foot when challenged. Description passed to police non-emergency.', 'police'],
    ['Someone sleeping in the stairwell B landing.', 'Woke the person and walked them off the property. No damage found.', 'resolved'],
    ['Unknown van parked at the gate for an hour.', 'Delivery driver waiting for a tenant. Logged the plate and moved them to the visitor bays.', 'resolved'],
  ],
  disturbance: [
    ['Loud argument outside unit 214.', 'Two residents arguing over parking. Separated them and logged both names. Calm on leaving.', 'report'],
    ['Group drinking by the pool after hours.', 'Asked the group to leave the pool area; they did. Gate re-locked.', 'resolved'],
  ],
  medical: [
    ['Visitor fainted in the main lobby.', 'Visitor conscious and talking on arrival. EMS called as a precaution and took over.', 'fire_ems'],
  ],
  lockout: [
    ['Tenant locked out of suite 410.', 'Checked ID against the tenant list and let them in.', 'resolved'],
    ['Staff badge not opening the side entrance.', 'Badge reader faulty. Let the staff member in and reported the reader.', 'referred'],
  ],
  escort: [
    ['Night nurse asked for an escort to the parking garage.', 'Escorted to level 2 and waited until the car left.', 'resolved'],
    ['Escort a contractor to the roof plant room.', 'Escorted, waited, and locked the plant room after them.', 'resolved'],
  ],
  parking: [
    ['Car blocking the fire lane at the front entrance.', 'Owner found in the lobby and moved the car.', 'resolved'],
    ['Truck parked across two loading bays.', 'Driver moved the truck. Warning notice issued.', 'resolved'],
  ],
  maintenance: [
    ['Water coming through the ceiling in corridor C.', 'Pipe leak above the ceiling tile. Shut off the valve and called maintenance on call.', 'referred'],
    ['Elevator 2 stuck between floors, nobody inside.', 'Confirmed empty. Elevator company called; put out of service signs.', 'referred'],
  ],
};
const WEIGHTED_TYPES = ['alarm', 'alarm', 'alarm', 'suspicious', 'suspicious', 'suspicious', 'lockout', 'lockout', 'escort', 'escort', 'parking', 'parking', 'maintenance', 'disturbance', 'medical'];
const PRIORITY_OF = { medical: 1, alarm: 2, suspicious: 2, disturbance: 2, lockout: 3, escort: 3, parking: 3, maintenance: 3 };
const ARRIVE_RANGE = { 1: [2, 7], 2: [4, 19], 3: [8, 55] };

export async function seedDispatch({ db }) {
  const rand = rng(20261001);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const now = new Date();
  const ts = (v) => (v instanceof Date ? v : new Date(v));

  const supervisors = await db.prepare(`SELECT id FROM users WHERE role IN ('supervisor','admin') AND status = 'active' ORDER BY id`).all();
  const contactsBySite = new Map();
  for (const r of await db.prepare(`SELECT cs.site_id, cs.client_user_id, c.name FROM client_sites cs JOIN client_users c ON c.id = cs.client_user_id ORDER BY c.id`).all()) {
    if (!contactsBySite.has(r.site_id)) contactsBySite.set(r.site_id, []);
    contactsBySite.get(r.site_id).push(r);
  }

  const insertCall = db.prepare(
    `INSERT INTO service_calls (site_id, post_id, call_type, priority, location, description, caller_name, caller_phone, source,
       client_user_id, created_by, status, assigned_to, assigned_by, assigned_at, acknowledged_at, arrived_at, cleared_at, cleared_by,
       disposition, outcome, incident_id, cancelled_at, cancel_reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertEvent = db.prepare(
    `INSERT INTO service_call_events (call_id, kind, user_id, client_user_id, note, created_at) VALUES (?,?,?,?,?,?)`
  );
  const userName = new Map(
    (await db.prepare(`SELECT id, first_name || ' ' || last_name AS name FROM users`).all()).map((u) => [u.id, u.name])
  );

  async function addCall(c) {
    const id = Number((await insertCall.run(
      c.siteId, c.postId ?? null, c.type, c.priority, c.location ?? null, c.description, c.callerName ?? null, c.callerPhone ?? null,
      c.clientUserId ? 'client' : 'office', c.clientUserId ?? null, c.clientUserId ? null : c.createdBy, c.status,
      c.assignedTo ?? null, c.assignedTo ? c.assignedBy : null, c.assignedAt ? toSql(c.assignedAt) : null,
      c.ackAt ? toSql(c.ackAt) : null, c.arriveAt ? toSql(c.arriveAt) : null, c.clearAt ? toSql(c.clearAt) : null,
      c.clearAt ? c.assignedTo : null, c.disposition ?? null, c.outcome ?? null, c.incidentId ?? null,
      c.cancelAt ? toSql(c.cancelAt) : null, c.cancelReason ?? null, toSql(c.created)
    )).lastInsertRowid);
    const ev = (kind, at, extra = {}) => insertEvent.run(id, kind, extra.userId ?? null, extra.clientUserId ?? null, extra.note ?? null, toSql(at));
    await ev('raised', c.created, c.clientUserId ? { clientUserId: c.clientUserId } : { userId: c.createdBy });
    if (c.declinedBy) {
      await ev('assigned', c.declinedAt0, { userId: c.assignedBy, note: userName.get(c.declinedBy) });
      await ev('declined', c.declinedAt, { userId: c.declinedBy, note: c.declineReason });
    }
    if (c.assignedAt) await ev('assigned', c.assignedAt, { userId: c.assignedBy, note: userName.get(c.assignedTo) });
    if (c.ackAt) await ev('acknowledged', c.ackAt, { userId: c.assignedTo });
    if (c.arriveAt) await ev('arrived', c.arriveAt, { userId: c.assignedTo });
    if (c.clearAt) await ev('cleared', c.clearAt, { userId: c.assignedTo, note: c.outcome });
    if (c.cancelAt) await ev('cancelled', c.cancelAt, c.clientUserId && c.cancelledByClient ? { clientUserId: c.clientUserId, note: c.cancelReason } : { userId: c.assignedBy, note: c.cancelReason });
    return id;
  }

  /* ------------------------------------------------- the last month --- */
  const entries = (await db
    .prepare(
      `SELECT te.id, te.user_id, te.post_id, te.clock_in_at, te.clock_out_at, p.site_id
       FROM time_entries te JOIN posts p ON p.id = te.post_id
       WHERE te.clock_in_at >= ? AND te.clock_out_at IS NOT NULL
       ORDER BY te.clock_in_at`
    )
    .all(toSql(new Date(now.getTime() - 30 * 86400000))))
    .map((e) => ({ ...e, in: ts(e.clock_in_at), out: ts(e.clock_out_at) }));

  let calls = 0;
  for (const e of entries) {
    // Roughly one shift in four takes a call.
    if (rand() > 0.26) continue;
    const span = e.out - e.in;
    if (span < 2 * 3600000) continue;
    const created = new Date(e.in.getTime() + between(0.1, 0.7) * span);
    const type = pick(WEIGHTED_TYPES);
    const [description, outcome, disp] = pick(SCRIPTS[type]);
    const priority = PRIORITY_OF[type];
    const contacts = contactsBySite.get(e.site_id) || [];
    const fromClient = contacts.length && rand() < 0.4 ? contacts[0] : null;
    const assignedAt = new Date(created.getTime() + between(0.5, priority === 1 ? 1.5 : 4) * MIN);
    const ackAt = new Date(assignedAt.getTime() + between(0.3, 2.2) * MIN);
    const [lo, hi] = ARRIVE_RANGE[priority];
    const arriveAt = new Date(created.getTime() + between(lo, hi) * MIN);
    const cancelled = rand() < 0.06;
    let incidentId = null;
    let disposition = disp;
    if (disp === 'report') {
      const inc = await db
        .prepare(`SELECT id FROM incidents WHERE site_id = ? AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at LIMIT 1`)
        .get(e.site_id, toSql(new Date(created.getTime() - 86400000)), toSql(new Date(created.getTime() + 86400000)));
      if (inc) incidentId = inc.id;
      else disposition = 'resolved';
    }
    const base = {
      siteId: e.site_id, postId: rand() < 0.5 ? e.post_id : null, type, priority, description, created,
      location: null, clientUserId: fromClient?.client_user_id ?? null, callerName: fromClient?.name ?? null,
      createdBy: pick(supervisors).id, assignedBy: pick(supervisors).id,
    };
    if (cancelled) {
      await addCall({ ...base, status: 'cancelled', cancelAt: new Date(created.getTime() + between(2, 9) * MIN),
        cancelReason: 'Caller rang back: no longer needed.', cancelledByClient: Boolean(fromClient) });
    } else {
      await addCall({
        ...base, status: 'cleared', assignedTo: e.user_id, assignedAt, ackAt: ackAt < arriveAt ? ackAt : arriveAt, arriveAt,
        clearAt: new Date(arriveAt.getTime() + between(4, 35) * MIN), disposition, outcome, incidentId,
      });
    }
    calls += 1;
  }

  /* ------------------------------------------------------- right now --- */
  const onDuty = await db
    .prepare(
      `SELECT te.user_id, te.post_id, p.site_id, u.employee_code FROM time_entries te
       JOIN posts p ON p.id = te.post_id JOIN users u ON u.id = te.user_id
       WHERE te.clock_out_at IS NULL ORDER BY te.clock_in_at`
    )
    .all();
  const marcus = onDuty.find((d) => d.employee_code === '1003');
  const others = onDuty.filter((d) => d.employee_code !== '1003' && d.site_id !== marcus?.site_id);
  const sup = supervisors.find((s) => s.id === supervisors[1]?.id) || supervisors[0];
  const ago = (m) => new Date(now.getTime() - m * MIN);
  let live = 0;

  // A client's urgent call nobody has been sent to yet.
  const dana = (await db.prepare(`SELECT id, name FROM client_users WHERE email = 'dana.whitfield@riverfrontholdings.com'`).get());
  const danaSite = dana ? (await db.prepare(`SELECT site_id FROM client_sites WHERE client_user_id = ? ORDER BY site_id LIMIT 1`).get(dana.id)) : null;
  if (dana && danaSite) {
    await addCall({
      siteId: danaSite.site_id, type: 'suspicious', priority: 2, created: ago(4), status: 'open',
      location: 'Parking garage, level P2 by the stairwell',
      description: 'Two people going car to car with a torch on P2. One of our staff saw them from the elevator.',
      clientUserId: dana.id, callerName: dana.name, callerPhone: '(904) 555-0110',
    });
    live += 1;
  }

  // Sent to Marcus Bell six minutes ago, not yet acknowledged.
  if (marcus) {
    await addCall({
      siteId: marcus.site_id, postId: marcus.post_id, type: 'lockout', priority: 3, created: ago(9), status: 'assigned',
      location: 'Suite 300 reception', description: 'Tenant locked out of suite 300 - says their badge stopped working at lunch.',
      callerName: 'Front desk', createdBy: sup.id, assignedTo: marcus.user_id, assignedBy: sup.id, assignedAt: ago(6),
    });
    live += 1;
  }

  // On the way, after another officer turned it down.
  if (others[0]) {
    const o = others[0];
    const declined = others[1];
    await addCall({
      siteId: o.site_id, type: 'alarm', priority: 2, created: ago(11), status: 'en_route', location: 'Warehouse door 7',
      description: 'Monitoring centre reports a door contact alarm on warehouse door 7.', callerName: 'Monitoring centre',
      createdBy: sup.id, assignedTo: o.user_id, assignedBy: sup.id, assignedAt: ago(7), ackAt: ago(6),
      ...(declined ? { declinedBy: declined.user_id, declinedAt0: ago(10), declinedAt: ago(8), declineReason: 'Mid-tour at the far end of the site, ten minutes away.' } : {}),
    });
    live += 1;
  }

  // On scene.
  if (others[2]) {
    const o = others[2];
    await addCall({
      siteId: o.site_id, postId: o.post_id, type: 'escort', priority: 3, created: ago(22), status: 'on_scene',
      location: 'Main entrance', description: 'Staff member finishing late asked for an escort to the staff lot.',
      callerName: 'Night manager', createdBy: sup.id, assignedTo: o.user_id, assignedBy: sup.id,
      assignedAt: ago(20), ackAt: ago(19), arriveAt: ago(12),
    });
    live += 1;
  }

  return { calls: calls + live, live };
}
