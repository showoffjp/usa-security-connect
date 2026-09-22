/**
 * Demo data for USA Security Connect.
 *
 *   npm run seed            -> fills an empty database, leaves existing data alone
 *   npm run reset           -> wipes everything first
 *
 * Every account below uses a fixed PIN so the demo is reproducible. Real
 * accounts get a random PIN from the admin screen instead.
 */

import { db, migrate } from './lib/db.js';
import { hashPin } from './lib/auth.js';
import { toSql, sweep, raiseFlag } from './services/compliance.js';

const RESET = process.argv.includes('--reset');

await migrate();

if (RESET) {
  // TRUNCATE ... RESTART IDENTITY CASCADE empties every table and resets the id
  // sequences in one statement. CASCADE means the order does not matter, which
  // is one less thing to keep in step with the schema.
  const tables = [
    'audit_log', 'flags', 'messages', 'thread_participants', 'threads',
    'training_progress', 'trainings', 'broadcast_receipts', 'broadcasts',
    'tour_run_tasks', 'tour_run_checkpoints', 'tour_runs', 'checkpoint_tasks',
    'checkpoints', 'tours', 'supervisor_visits', 'incident_photos', 'incidents',
    'panic_alerts', 'breaks', 'status_checks', 'time_entries', 'shifts',
    'time_off_requests', 'availability', 'certifications', 'device_tokens',
    'shift_requests', 'invoice_lines', 'invoices', 'client_sites', 'client_users',
    'users', 'posts', 'sites',
  ];
  await db.exec(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  console.log('Cleared existing data.');
}

if ((await db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).n > 0) {
  console.log('Database already has users. Use `npm run reset` to start over.');
  process.exit(0);
}

const at = (daysFromNow, hour, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d;
};

/* ------------------------------------------------------------------ sites -- */

const insertSite = db.prepare(
  `INSERT INTO sites (name, client_name, address, city, state, postal_code, latitude, longitude, contact_name, contact_phone)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);

const siteIds = {
  riverfront: Number((await insertSite.run(
    'Riverfront Commerce Center', 'Riverfront Holdings LLC', '1200 Riverside Ave',
    'Jacksonville', 'FL', '32204', 30.3196, -81.6795, 'Dana Whitfield', '(904) 555-0142'
  )).lastInsertRowid),

  palmetto: Number((await insertSite.run(
    'Palmetto Ridge Residences', 'Palmetto Ridge HOA', '8455 Palmetto Ridge Dr',
    'Orlando', 'FL', '32819', 28.4515, -81.4720, 'Marcus Reyes', '(407) 555-0188'
  )).lastInsertRowid),

  gulfport: Number((await insertSite.run(
    'Gulfport Logistics Yard', 'Gulfport Freight Co', '3301 Industrial Pkwy',
    'Tampa', 'FL', '33605', 27.9589, -82.4298, 'Alicia Grant', '(813) 555-0173'
  )).lastInsertRowid),

  coral: Number((await insertSite.run(
    'Coral Bay Retail Plaza', 'Coral Bay Property Group', '790 Ocean Blvd',
    'Fort Lauderdale', 'FL', '33301', 26.1224, -80.1373, 'Nina Alvarez', '(954) 555-0119'
  )).lastInsertRowid),
};

/* ------------------------------------------------------------------ posts -- */

const insertPost = db.prepare(
  `INSERT INTO posts (site_id, name, post_code, instructions, latitude, longitude,
                      geofence_radius_m, check_in_interval_min, requires_gps, armed)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);

const postIds = {
  riverfrontLobby: Number((await insertPost.run(
    siteIds.riverfront, 'Main Lobby Console', 'RF-01',
    ['Verify photo ID for every visitor and issue a badge.',
     'Monitor lobby cameras 1-8; report any camera offline more than 10 minutes.',
     'Lock the north doors at 19:00 and confirm the loading dock is secured.',
     'Escalate any alarm to dispatch at (904) 555-0100 before responding.'].join('\n'),
    30.3196, -81.6795, 120, 60, 1, 0
  )).lastInsertRowid),

  riverfrontPatrol: Number((await insertPost.run(
    siteIds.riverfront, 'Exterior Patrol', 'RF-02',
    'Walk the perimeter and both parking decks. Complete the exterior tour once per hour.',
    30.3199, -81.6801, 250, 45, 1, 0
  )).lastInsertRowid),

  palmettoGate: Number((await insertPost.run(
    siteIds.palmetto, 'North Gatehouse', 'PR-01',
    ['Residents enter by transponder; guests must be on the approved list.',
     'Log every contractor vehicle with plate and company name.',
     'Gate arm stays down between 22:00 and 06:00.'].join('\n'),
    28.4515, -81.4720, 100, 90, 1, 0
  )).lastInsertRowid),

  gulfportYard: Number((await insertPost.run(
    siteIds.gulfport, 'Yard Security - Armed', 'GP-01',
    ['Armed post. Weapon check at start and end of every shift.',
     'Inspect all trailer seals on arrival and departure.',
     'No driver enters the yard without a bill of lading.'].join('\n'),
    27.9589, -82.4298, 300, 30, 1, 1
  )).lastInsertRowid),

  coralRetail: Number((await insertPost.run(
    siteIds.coral, 'Retail Floor Patrol', 'CB-01',
    'High-visibility patrol during mall hours. Coordinate with store managers on shoplifting stops.',
    26.1224, -80.1373, 180, 60, 1, 0
  )).lastInsertRowid),
};

/* ------------------------------------------------------------------ users -- */

const insertUser = db.prepare(
  `INSERT INTO users
   (employee_code, first_name, last_name, email, phone, role, status, hire_date,
    license_number, license_type, license_expires_on, emergency_contact_name,
    emergency_contact_phone, emergency_contact_relation, default_site_id,
    pay_rate_cents, bill_rate_cents, employment_type, pay_type, exempt,
    overtime_multiplier, business_name, tax_id_last4, w9_on_file,
    contractor_agreement_on_file, insurance_expires_on,
    address_line1, city, state, postal_code, uniform_size,
    pin_hash, pin_salt, pin_set_at, must_change_pin)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)`
);

async function addUser(u) {
  const { hash, salt } = hashPin(u.pin);
  const contractor = u.employmentType === '1099';
  return Number((await insertUser.run(
    u.code, u.first, u.last, u.email, u.phone, u.role, u.status || 'active', u.hireDate,
    u.license || null, u.licenseType || null, u.licenseExpires || null,
    u.ecName || null, u.ecPhone || null, u.ecRelation || null, u.siteId || null,
    u.rate ? Math.round(u.rate * 100) : null,
    u.billRate ? Math.round(u.billRate * 100) : null,
    u.employmentType || 'w2', u.payType || 'hourly', u.exempt ? 1 : 0,
    u.overtimeMultiplier ?? 1.5,
    u.businessName || null, u.taxIdLast4 || null,
    contractor ? 1 : 0, contractor ? 1 : 0, u.insuranceExpires || null,
    u.address || null, u.city || null, u.state || 'FL', u.zip || null, u.uniform || null,
    hash, salt, u.mustChange ? 1 : 0
  )).lastInsertRowid);
}

const users = {
  admin: await addUser({
    code: '1001', first: 'Vince', last: 'Ortega', email: 'vince@usasecuritygroup.com',
    phone: '(904) 555-0100', role: 'admin', hireDate: '2019-02-04',
    rate: 42, payType: 'salary', exempt: true, employmentType: 'w2',
    address: '383 Main Ave', city: 'Jacksonville', zip: '32204', uniform: 'L',
    pin: '2468', mustChange: false,
  }),
  supervisor: await addUser({
    code: '1002', first: 'Renata', last: 'Diaz', email: 'r.diaz@usasecuritygroup.com',
    phone: '(904) 555-0121', role: 'supervisor', hireDate: '2021-06-14',
    rate: 28, billRate: 46, employmentType: 'w2',
    license: 'D-2214778', licenseType: 'Class D', licenseExpires: '2027-06-30',
    siteId: siteIds.riverfront, ecName: 'Luis Diaz', ecPhone: '(904) 555-0131', ecRelation: 'Spouse',
    address: '1140 Oak St', city: 'Jacksonville', zip: '32204', uniform: 'M',
    pin: '3571', mustChange: false,
  }),
  marcus: await addUser({
    code: '1003', first: 'Marcus', last: 'Bell', email: 'm.bell@usasecuritygroup.com',
    phone: '(904) 555-0155', role: 'officer', hireDate: '2023-03-20',
    rate: 21, billRate: 34, employmentType: 'w2',
    license: 'D-3391204', licenseType: 'Class D', licenseExpires: '2027-03-31',
    siteId: siteIds.riverfront, ecName: 'Tanya Bell', ecPhone: '(904) 555-0156', ecRelation: 'Spouse',
    address: '2218 Hendricks Ave', city: 'Jacksonville', zip: '32207', uniform: 'XL',
    pin: '4812', mustChange: false,
  }),
  janelle: await addUser({
    code: '1004', first: 'Janelle', last: 'Carter', email: 'j.carter@usasecuritygroup.com',
    phone: '(407) 555-0164', role: 'officer', hireDate: '2024-01-08',
    rate: 20.5, billRate: 33, employmentType: 'w2',
    // Licence lapses inside the warning window, so the compliance board has something real.
    license: 'D-3410992', licenseType: 'Class D', licenseExpires: '2026-11-30',
    siteId: siteIds.palmetto, ecName: 'Rose Carter', ecPhone: '(407) 555-0165', ecRelation: 'Mother',
    address: '755 Sand Lake Rd', city: 'Orlando', zip: '32819', uniform: 'S',
    pin: '5930', mustChange: false,
  }),
  dwayne: await addUser({
    code: '1005', first: 'Dwayne', last: 'Foster', email: 'd.foster@usasecuritygroup.com',
    phone: '(813) 555-0177', role: 'officer', hireDate: '2022-09-12',
    // An armed contractor: invoices for hours, carries his own insurance.
    rate: 34, billRate: 52, employmentType: '1099',
    businessName: 'Foster Protective Services LLC', taxIdLast4: '4821',
    insuranceExpires: '2026-10-31',
    license: 'G-1120384', licenseType: 'Class G (Armed)', licenseExpires: '2026-09-30',
    siteId: siteIds.gulfport, ecName: 'Priya Foster', ecPhone: '(813) 555-0178', ecRelation: 'Spouse',
    address: '4410 Adamo Dr', city: 'Tampa', zip: '33605', uniform: '2XL',
    pin: '6174', mustChange: false,
  }),
  alicia: await addUser({
    code: '1006', first: 'Alicia', last: 'Nunez', email: 'a.nunez@usasecuritygroup.com',
    phone: '(954) 555-0192', role: 'officer', hireDate: '2025-04-02',
    rate: 20, billRate: 32, employmentType: 'w2',
    license: 'D-3501887', licenseType: 'Class D', licenseExpires: '2028-04-30',
    siteId: siteIds.coral, address: '612 SE 3rd Ave', city: 'Fort Lauderdale', zip: '33301',
    uniform: 'M', pin: '7285', mustChange: false,
  }),
  trainee: await addUser({
    code: '1007', first: 'Kevin', last: 'Osei', email: 'k.osei@usasecuritygroup.com',
    phone: '(904) 555-0198', role: 'officer', hireDate: '2026-09-01',
    rate: 19, billRate: 30, employmentType: 'w2',
    siteId: siteIds.riverfront, uniform: 'L',
    pin: '8140', mustChange: true,
  }),
  contractor: await addUser({
    code: '1008', first: 'Renee', last: 'Okafor', email: 'r.okafor@contractor.example',
    phone: '(407) 555-0210', role: 'officer', hireDate: '2026-02-17',
    rate: 30, billRate: 47, employmentType: '1099', payType: 'per_shift',
    businessName: 'Okafor Event Security', taxIdLast4: '9073',
    insuranceExpires: '2027-02-28',
    license: 'D-3520114', licenseType: 'Class D', licenseExpires: '2027-12-31',
    siteId: siteIds.palmetto, address: '90 Church St', city: 'Orlando', zip: '32801',
    uniform: 'S', pin: '9351', mustChange: false,
  }),
};

/* ----------------------------------------------------------------- shifts -- */

const insertShift = db.prepare(
  `INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status, created_by) VALUES (?,?,?,?,?,?)`
);

const shifts = [];
// Two weeks back and two weeks forward, so the schedule and timesheets look lived-in.
for (let day = -14; day <= 14; day++) {
  const past = day < 0;
  shifts.push({
    user: users.marcus, post: postIds.riverfrontLobby,
    start: at(day, 6), end: at(day, 14), status: past ? 'completed' : 'scheduled',
  });
  shifts.push({
    user: users.janelle, post: postIds.palmettoGate,
    start: at(day, 14), end: at(day, 22), status: past ? 'completed' : 'scheduled',
  });
  if (day % 7 !== 0 && day % 7 !== 6) {
    shifts.push({
      user: users.dwayne, post: postIds.gulfportYard,
      start: at(day, 18), end: at(day + 1, 2), status: past ? 'completed' : 'scheduled',
    });
  }
  if (day % 2 === 0) {
    shifts.push({
      user: users.alicia, post: postIds.coralRetail,
      start: at(day, 10), end: at(day, 18), status: past ? 'completed' : 'scheduled',
    });
  }
}
// An unfilled shift for the admin to assign, plus a supervisor rotation.
shifts.push({ user: null, post: postIds.riverfrontPatrol, start: at(2, 22), end: at(3, 6), status: 'scheduled' });
shifts.push({ user: users.supervisor, post: postIds.riverfrontPatrol, start: at(1, 8), end: at(1, 16), status: 'scheduled' });

// Two shifts nobody ever clocked into. Left as 'scheduled' in the past so the
// compliance sweep raises real no-show flags regardless of the hour the seed
// runs - otherwise the demo board is empty first thing in the morning.
shifts.push({ user: users.alicia, post: postIds.coralRetail, start: at(-2, 10), end: at(-2, 18), status: 'scheduled' });
shifts.push({ user: users.contractor, post: postIds.palmettoGate, start: at(-1, 14), end: at(-1, 22), status: 'scheduled' });

// Inserted one at a time rather than with map(): an async callback passed to
// map returns an array of promises, not an array of rows.
const shiftRows = [];
for (const s of shifts) {
  const info = await insertShift.run(s.user, s.post, toSql(s.start), toSql(s.end), s.status, users.admin);
  shiftRows.push({ ...s, id: Number(info.lastInsertRowid) });
}

/* ------------------------------------------------------------ time entries -- */

const insertEntry = db.prepare(
  `INSERT INTO time_entries
   (user_id, shift_id, post_id, clock_in_at, clock_in_lat, clock_in_lng, clock_in_accuracy,
    clock_in_geofence, clock_in_distance_m, clock_out_at, clock_out_lat, clock_out_lng,
    clock_out_geofence, method, device_id, minutes_worked, late_minutes)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);

const postCoords = {
  [postIds.riverfrontLobby]: [30.3196, -81.6795],
  [postIds.riverfrontPatrol]: [30.3199, -81.6801],
  [postIds.palmettoGate]: [28.4515, -81.4720],
  [postIds.gulfportYard]: [27.9589, -82.4298],
  [postIds.coralRetail]: [26.1224, -80.1373],
};

let entryCount = 0;
for (const shift of shiftRows) {
  if (shift.status !== 'completed' || !shift.user) continue;

  // Most shifts are clean; a deterministic slice runs late or drifts outside the fence.
  const late = entryCount % 9 === 3;
  const outside = entryCount % 17 === 5;
  const lateMinutes = late ? 12 + (entryCount % 5) : 0;

  const clockIn = new Date(shift.start.getTime() + (late ? (lateMinutes + 7) : -(2 + (entryCount % 4))) * 60000);
  const clockOut = new Date(shift.end.getTime() + ((entryCount % 6) - 2) * 60000);
  const [lat, lng] = postCoords[shift.post];

  (await insertEntry.run(
    shift.user, shift.id, shift.post, toSql(clockIn),
    outside ? lat + 0.004 : lat + 0.0002,
    outside ? lng + 0.004 : lng - 0.0002,
    outside ? 18 : 9,
    outside ? 'outside' : 'inside',
    outside ? 580 : 28,
    toSql(clockOut), lat, lng, 'inside',
    'gps', `demo-device-${shift.user}`,
    Math.round((clockOut - clockIn) / 60000),
    lateMinutes
  ));
  const entryId = Number(
    (await db.prepare(`SELECT id FROM time_entries WHERE shift_id = ?`).get(shift.id)).id
  );

  if (lateMinutes > 0) {
    await raiseFlag({
      userId: shift.user,
      type: 'late_clock_in',
      occurredAt: clockIn,
      refType: 'time_entry',
      refId: entryId,
      detail: { late_minutes: lateMinutes, scheduled_start: shift.start.toISOString() },
    });
  }
  if (outside) {
    await raiseFlag({
      userId: shift.user,
      type: 'geofence_violation',
      occurredAt: clockIn,
      refType: 'time_entry',
      refId: entryId,
      detail: { distance_m: 580, radius_m: 150, status: 'outside', reason: null },
    });
  }

  entryCount++;
}

/* ---------------------------------------------------- an officer on duty -- */

// Marcus is mid-shift right now, so the dashboard and officer home have live data.
const liveShift = shiftRows.find((s) => s.user === users.marcus && s.status === 'scheduled' && s.start <= new Date() && s.end >= new Date());

// Three hours ago, but never earlier than today's midnight - otherwise seeding
// in the small hours puts the "currently on duty" officer on yesterday's date
// and the daily activity report opens empty.
const midnight = new Date();
midnight.setHours(0, 0, 0, 0);
const liveStart = new Date(Math.max(Date.now() - 3 * 3600000, midnight.getTime() + 15 * 60000));
const liveShiftId = liveShift?.id ?? Number(
  (await insertShift.run(users.marcus, postIds.riverfrontLobby, toSql(liveStart), toSql(new Date(Date.now() + 5 * 3600000)), 'in_progress', users.admin)).lastInsertRowid
);
if (liveShift) (await db.prepare(`UPDATE shifts SET status = 'in_progress' WHERE id = ?`).run(liveShift.id));

const liveEntryId = Number(
  (await insertEntry.run(
    users.marcus, liveShiftId, postIds.riverfrontLobby, toSql(liveStart),
    30.3196, -81.6795, 8, 'inside', 15,
    null, null, null, null, 'gps', 'demo-device-marcus', null, 0
  )).lastInsertRowid
);

// Two answered check-ins and one that was missed an hour ago.
const insertCheck = db.prepare(
  `INSERT INTO status_checks (time_entry_id, user_id, due_at, window_minutes, responded_at, status, latitude, longitude)
   VALUES (?,?,?,?,?,?,?,?)`
);
(await insertCheck.run(liveEntryId, users.marcus, toSql(new Date(liveStart.getTime() + 3600000)), 10,
  toSql(new Date(liveStart.getTime() + 3660000)), 'ok', 30.3196, -81.6795));
(await insertCheck.run(liveEntryId, users.marcus, toSql(new Date(liveStart.getTime() + 7200000)), 10,
  null, 'missed', null, null));

/* ------------------------------------------------------------- incidents -- */

const insertIncident = db.prepare(
  `INSERT INTO incidents
   (ref_number, user_id, site_id, post_id, officer_name, callback_number, category, severity,
    occurred_at, location_text, what_happened, resolution, other_details, people_involved,
    people_notified, police_notified, cost_recovery_cents, status)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);

const year = new Date().getFullYear();
(await insertIncident.run(
  `USC-${year}-0001`, users.marcus, siteIds.riverfront, postIds.riverfrontLobby,
  'Marcus Bell', '(904) 555-0155', 'Alarm / System', 'medium',
  toSql(at(-3, 22, 15)), 'North stairwell, level 2',
  'Door alarm on the north stairwell triggered repeatedly between 22:10 and 22:20. On inspection the magnetic contact had separated from the frame, so the door was reading as open while physically closed and latched.',
  'Secured the door manually and confirmed it was latched. Notified building maintenance for repair the following morning and logged a work order.',
  'No sign of forced entry. Cameras 4 and 5 reviewed; no persons in the stairwell during the alarm window.',
  'None', 'Dana Whitfield (property manager), dispatch', 0, 18500, 'closed'
));
(await insertIncident.run(
  `USC-${year}-0002`, users.alicia, siteIds.coral, postIds.coralRetail,
  'Alicia Nunez', '(954) 555-0192', 'Theft', 'high',
  toSql(at(-1, 15, 40)), 'Plaza east wing, outside unit 14',
  'Store manager reported a subject concealing merchandise and leaving without payment. Subject left westbound on foot toward the parking structure before I arrived. Obtained description and camera timestamps.',
  'Provided camera timestamps to the store manager and Fort Lauderdale PD. Incident documented with photos of the display area.',
  'Store estimates loss at $312. Police report filed by the store manager.',
  'Unknown male subject, approx 6ft, dark jacket', 'Store manager, FLPD non-emergency', 1, 31200, 'under_review'
));
(await insertIncident.run(
  `USC-${year}-0003`, users.dwayne, siteIds.gulfport, postIds.gulfportYard,
  'Dwayne Foster', '(813) 555-0177', 'Trespass', 'medium',
  toSql(at(-6, 2, 5)), 'South fence line near gate 3',
  'Observed two subjects attempting to climb the south fence at approximately 02:05. Announced presence and the subjects fled the property northbound. No entry was gained and no property was damaged.',
  'Perimeter re-walked and all gates confirmed secured. Tampa PD advised. Extra patrol added to the fence line for the remainder of the shift.',
  'Fence fabric slightly bent at one section; photographed for maintenance.',
  'Two unidentified subjects', 'Alicia Grant (client), Tampa PD', 1, null, 'submitted'
));

/* ----------------------------------------------------------------- tours -- */

const insertTour = db.prepare(`INSERT INTO tours (site_id, name, description, expected_minutes) VALUES (?,?,?,?)`);
const insertCheckpoint = db.prepare(
  `INSERT INTO checkpoints (tour_id, name, sequence, nfc_tag_id, instructions, latitude, longitude, required)
   VALUES (?,?,?,?,?,?,?,?)`
);
const insertTask = db.prepare(
  `INSERT INTO checkpoint_tasks (checkpoint_id, label, sequence, required) VALUES (?,?,?,?)`
);

async function buildTour(siteId, name, description, minutes, checkpoints) {
  const tourId = Number((await insertTour.run(siteId, name, description, minutes)).lastInsertRowid);

  for (const [i, cp] of checkpoints.entries()) {
    const info = await insertCheckpoint.run(
      tourId, cp.name, i, cp.tag, cp.instructions || null,
      cp.lat || null, cp.lng || null, cp.required === false ? 0 : 1
    );
    const cpId = Number(info.lastInsertRowid);
    for (const [ti, label] of (cp.tasks || []).entries()) {
      await insertTask.run(cpId, label, ti, 1);
    }
  }
  return tourId;
}

await buildTour(siteIds.riverfront, 'Riverfront Interior Round', 'Hourly interior sweep of all occupied floors.', 35, [
  { name: 'Main Lobby', tag: 'USC-NFC-RF-101', lat: 30.3196, lng: -81.6795,
    tasks: ['Confirm visitor log is current', 'Check lobby doors are secure'] },
  { name: 'Level 2 Corridor', tag: 'USC-NFC-RF-102',
    instructions: 'Check both stairwell doors are latched.',
    tasks: ['Stairwell doors latched', 'No propped doors'] },
  { name: 'Server Room Entrance', tag: 'USC-NFC-RF-103',
    instructions: 'Do not enter. Confirm the door is closed and the access panel shows green.',
    tasks: ['Door closed and locked', 'Access panel reads normal'] },
  { name: 'Loading Dock', tag: 'USC-NFC-RF-104',
    tasks: ['Dock doors down', 'No unattended packages', 'Area clear of debris'] },
  { name: 'Roof Access Door', tag: 'USC-NFC-RF-105', required: false,
    tasks: ['Roof door secured'] },
]);

await buildTour(siteIds.gulfport, 'Gulfport Perimeter Sweep', 'Full fence line and trailer row inspection.', 45, [
  { name: 'Gate 1 - Main Entry', tag: 'USC-NFC-GP-201', lat: 27.9589, lng: -82.4298,
    tasks: ['Gate arm operational', 'Visitor log current'] },
  { name: 'Trailer Row A', tag: 'USC-NFC-GP-202',
    instructions: 'Check every trailer seal number against the manifest clipboard.',
    tasks: ['All seals intact', 'Seal numbers match manifest'] },
  { name: 'South Fence Line', tag: 'USC-NFC-GP-203',
    tasks: ['No breaches or cuts', 'Lighting operational'] },
  { name: 'Fuel Depot', tag: 'USC-NFC-GP-204',
    tasks: ['Pumps locked', 'No spills or leaks', 'Extinguisher present and charged'] },
]);

await buildTour(siteIds.palmetto, 'Palmetto Community Patrol', 'Drive-through of common areas and amenities.', 25, [
  { name: 'North Gatehouse', tag: 'USC-NFC-PR-301', lat: 28.4515, lng: -81.4720,
    tasks: ['Gate arm down', 'Guest list current'] },
  { name: 'Clubhouse & Pool', tag: 'USC-NFC-PR-302',
    instructions: 'Pool closes at 22:00. Clear the deck and secure the gate.',
    tasks: ['Pool gate locked', 'Clubhouse secured', 'No after-hours guests'] },
  { name: 'Mail Pavilion', tag: 'USC-NFC-PR-303',
    tasks: ['Parcel lockers secured', 'Lighting operational'] },
]);

/* ------------------------------------------------- broadcasts & training -- */

const insertBroadcast = db.prepare(
  `INSERT INTO broadcasts (title, body, priority, requires_ack, audience_role, published_at, created_by)
   VALUES (?,?,?,?,?,?,?)`
);
(await insertBroadcast.run(
  'Hurricane season standby procedures',
  'All posts: review the storm annex in your post orders. If a watch is issued for your county, contact dispatch at the start of every shift to confirm coverage. Do not leave a post unattended during a warning without relief on site.',
  'urgent', 1, null, toSql(at(-1, 8)), users.admin
));
(await insertBroadcast.run(
  'New incident report fields',
  'The incident form now includes a cost recovery field. Enter the client-estimated dollar value whenever property is damaged or stolen so we can bill correctly.',
  'important', 0, null, toSql(at(-4, 9)), users.supervisor
));
(await insertBroadcast.run(
  'Uniform reminder',
  'Class A shirts are required for all daytime lobby posts. Patrol posts may wear the tactical polo. Boots must be black and polished.',
  'normal', 0, 'officer', toSql(at(-8, 10)), users.supervisor
));

const insertTraining = db.prepare(
  `INSERT INTO trainings (title, description, video_url, duration_seconds, required, due_at, created_by)
   VALUES (?,?,?,?,?,?,?)`
);
(await insertTraining.run(
  'Post Orders: Lobby Access Control',
  'How to verify identification, issue badges and handle refused entry at a lobby console.',
  null, 420, 1, toSql(at(7, 23, 59)), users.admin
));
(await insertTraining.run(
  'Use of Force Refresher (Class D)',
  'Annual refresher on Florida statute requirements for non-armed security officers.',
  null, 900, 1, toSql(at(21, 23, 59)), users.admin
));
(await insertTraining.run(
  'Radio Discipline and Dispatch Codes',
  'Standard call signs, priority traffic and how to escalate to dispatch.',
  null, 360, 0, null, users.supervisor
));

/* ------------------------------------------------------------- messaging -- */

const threadId = Number(
  (await db.prepare(`INSERT INTO threads (subject, created_by, last_message_at) VALUES (?,?,?)`)
    .run('Riverfront relief coverage', users.supervisor, toSql(at(0, 9, 12)))).lastInsertRowid
);
for (const uid of [users.supervisor, users.marcus]) {
  (await db.prepare(`INSERT INTO thread_participants (thread_id, user_id) VALUES (?,?)`).run(threadId, uid));
}
(await db.prepare(`INSERT INTO messages (thread_id, sender_id, body, sent_at) VALUES (?,?,?,?)`)
  .run(threadId, users.supervisor, 'Marcus - can you stay on until 15:00 tomorrow? Kevin is still finishing his Class D paperwork.', toSql(at(0, 9, 10))));
(await db.prepare(`INSERT INTO messages (thread_id, sender_id, body, sent_at) VALUES (?,?,?,?)`)
  .run(threadId, users.marcus, 'Yes, I can cover until 15:00. I will note it on the pass-down log.', toSql(at(0, 9, 12))));

/* ------------------------------------------------- supervisor visit log -- */

(await db.prepare(
  `INSERT INTO supervisor_visits
   (supervisor_id, officer_id, site_id, post_id, visited_at, uniform_ok, post_orders_reviewed,
    equipment_ok, site_secure, rating, notes, latitude, longitude)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  users.supervisor, users.marcus, siteIds.riverfront, postIds.riverfrontLobby,
  toSql(at(-2, 11, 30)), 1, 1, 1, 1, 5,
  'Post in good order. Visitor log current and legible. Reviewed the storm annex with the officer.',
  30.3196, -81.6795
));

/* ------------------------------------------------------ certifications -- */

const insertCert = db.prepare(
  `INSERT INTO certifications
   (user_id, type, number, issuing_authority, issued_on, expires_on, verified_by, verified_at, notes)
   VALUES (?,?,?,?,?,?,?,datetime('now'),?)`
);

const FDACS = 'Florida Department of Agriculture and Consumer Services';
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// A deliberate spread: valid, expiring inside the warning window, and expired.
(await insertCert.run(users.marcus, 'CPR / First Aid', 'AHA-22841', 'American Heart Association',
  '2025-04-12', inDays(210), users.admin, null));
(await insertCert.run(users.marcus, 'Verbal De-escalation', null, 'USA Security in-house',
  '2026-01-15', inDays(120), users.supervisor, null));
(await insertCert.run(users.janelle, 'CPR / First Aid', 'AHA-23117', 'American Heart Association',
  '2024-11-02', inDays(34), users.admin, 'Renewal class booked.'));
(await insertCert.run(users.dwayne, 'Class G Statewide Firearm Licence', 'G-1120384', FDACS,
  '2022-09-12', inDays(9), users.admin, 'Range requalification required before renewal.'));
(await insertCert.run(users.dwayne, 'Defensive Tactics', null, 'USA Security in-house',
  '2025-06-01', inDays(-12), users.supervisor, 'Lapsed - schedule refresher.'));
(await insertCert.run(users.alicia, 'CPR / First Aid', 'AHA-24990', 'American Heart Association',
  '2026-03-20', inDays(520), users.admin, null));
(await insertCert.run(users.contractor, 'OSHA 10', 'OSHA-771204', 'OSHA',
  '2025-08-19', inDays(390), users.admin, null));

/* --------------------------------------------------------- availability -- */

const insertAvailability = db.prepare(
  `INSERT INTO availability (user_id, weekday, start_time, end_time, available, note)
   VALUES (?,?,?,?,?,?)`
);

// Everyone is available by default; a couple of realistic restrictions.
for (const uid of [users.marcus, users.janelle, users.dwayne, users.alicia, users.contractor]) {
  for (let weekday = 0; weekday <= 6; weekday++) {
    const isSunday = weekday === 0;
    const restricted = uid === users.janelle && isSunday;
    const studyNight = uid === users.alicia && weekday === 3;
    (await insertAvailability.run(
      uid,
      weekday,
      studyNight ? '00:00' : '00:00',
      studyNight ? '17:00' : '23:59',
      restricted ? 0 : 1,
      restricted ? 'Family commitment' : studyNight ? 'Classes from 18:00' : null
    ));
  }
}

/* ------------------------------------------------------------- time off -- */

const insertTimeOff = db.prepare(
  `INSERT INTO time_off_requests (user_id, type, starts_on, ends_on, reason, status, decided_by, decided_at, decision_note)
   VALUES (?,?,?,?,?,?,?,?,?)`
);

(await insertTimeOff.run(users.marcus, 'vacation', inDays(24), inDays(31),
  'Family trip booked before I started here.', 'pending', null, null, null));
(await insertTimeOff.run(users.alicia, 'sick', inDays(-4), inDays(-3),
  'Flu - doctor note available.', 'approved', users.supervisor,
  toSql(at(-5, 9)), 'Get well. Cover arranged with Kevin.'));
(await insertTimeOff.run(users.dwayne, 'unpaid', inDays(12), inDays(13),
  'Range requalification for my Class G renewal.', 'pending', null, null, null));

/* ---------------------------------------------------- past duress alert -- */

// One resolved alert so the safety board is not empty on a first look.
(await db.prepare(
  `INSERT INTO panic_alerts
   (user_id, post_id, triggered_at, latitude, longitude, accuracy, status,
    acknowledged_by, acknowledged_at, resolved_at, resolution_note)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`
).run(
  users.dwayne, postIds.gulfportYard, toSql(at(-9, 2, 42)),
  27.9589, -82.4298, 12, 'resolved',
  users.supervisor, toSql(at(-9, 2, 43)), toSql(at(-9, 3, 20)),
  'Reached the officer by radio in under a minute. Aggressive driver at gate 1 had left the property. Tampa PD advised, no injuries, no damage.'
));

// Derive flags from everything above.
await sweep();

const flagCount = (await db.prepare(`SELECT COUNT(*) AS n FROM flags`).get()).n;

console.log(`
USA Security Connect - demo data loaded
---------------------------------------
  ${(await db.prepare(`SELECT COUNT(*) AS n FROM sites`).get()).n} sites, ${(await db.prepare(`SELECT COUNT(*) AS n FROM posts`).get()).n} posts
  ${(await db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).n} employees
  ${(await db.prepare(`SELECT COUNT(*) AS n FROM shifts`).get()).n} shifts, ${(await db.prepare(`SELECT COUNT(*) AS n FROM time_entries`).get()).n} time entries
  ${(await db.prepare(`SELECT COUNT(*) AS n FROM incidents`).get()).n} incidents, ${(await db.prepare(`SELECT COUNT(*) AS n FROM tours`).get()).n} tours
  ${flagCount} compliance flags

  ${(await db.prepare(`SELECT COUNT(*) AS n FROM certifications`).get()).n} certifications, ${(await db.prepare(`SELECT COUNT(*) AS n FROM time_off_requests`).get()).n} time-off requests

Sign-in codes (demo PINs):
  1001 / 2468   Vince Ortega      Administrator      W-2 salary, exempt
  1002 / 3571   Renata Diaz       Field Supervisor   W-2 hourly
  1003 / 4812   Marcus Bell       Officer            W-2, currently on duty
  1004 / 5930   Janelle Carter    Officer            W-2, licence expiring
  1005 / 6174   Dwayne Foster     Officer            1099 contractor, armed post
  1006 / 7285   Alicia Nunez      Officer            W-2 hourly
  1007 / 8140   Kevin Osei        Officer            W-2, must change PIN
  1008 / 9351   Renee Okafor      Officer            1099 contractor, per shift
`);

db.close();
