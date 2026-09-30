/**
 * Demo data for USA Security Connect.
 *
 *   npm run seed            -> fills an empty database, leaves existing data alone
 *   npm run reset           -> wipes everything first
 *
 * Also run by services/demoInstance.js to fill the throwaway database of a
 * deployment that has no database configured.
 *
 * Every account below uses a fixed PIN so the demo is reproducible. Real
 * accounts get a random PIN from the admin screen instead.
 */

import { db, migrate } from './lib/db.js';
import { hashPin } from './lib/auth.js';
import { hashPassword } from './lib/clientAuth.js';
import { buildLines, nextNumber } from './routes/invoices.js';
import { toDateString } from './lib/http.js';
import { invoiceTotals } from './shared.js';
import { TRAININGS, BROADCASTS, THREADS, CLIPS } from './seed-content.js';
import { toSql, sweep, raiseFlag } from './services/compliance.js';
import { seedExpansion } from './seed-expansion.js';
import { seedPayroll } from './seed-payroll.js';
import { seedPostLog } from './seed-postlog.js';

/**
 * Load the demo company. With `reset`, every table is emptied first.
 * Returns false, having changed nothing, if there are users and no reset.
 */
export async function seedDemo({ reset = false, log = console.log } = {}) {
  await migrate();

  if (reset) {
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
      'location_pings', 'pay_rate_history', 'pay_period_lines', 'pay_periods',
      'post_pay_rates', 'equipment_assignments', 'equipment', 'coverage_requests',
      'passdown_acks', 'passdown_notes', 'visitor_log', 'watchlist', 'vehicle_violations', 'activity_entries', 'site_issues', 'lost_found', 'site_contacts', 'client_feedback', 'incident_actions', 'client_digests', 'post_order_requests', 'post_order_acks', 'post_orders', 'alert_reads',
      'users', 'posts', 'sites',
      // The limiter counts live in the database on purpose, so they are shared
      // between processes and survive a restart. That also means they survive a
      // reseed, and a reseed of demo data that leaves yesterday's failed sign-ins
      // counted against today is not the fresh start it claims to be - the second
      // run of the suite was being refused on a limit the first run spent.
      'rate_limits',
    ];
    await db.exec(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    log('Cleared existing data.');
  }

  if ((await db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).n > 0) {
    log('Database already has users. Use `npm run reset` to start over.');
    return false;
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

  // Standing contract rates, per post per hour. A shift can carry its own rate
  // when a one-off is agreed; otherwise the post's rate is what gets billed.
  for (const [post, cents] of Object.entries({
    riverfrontLobby: 2850,
    riverfrontPatrol: 2950,
    palmettoGate: 2650,
    gulfportYard: 3850, // armed, so it carries a premium
    coralRetail: 2750,
  })) {
    await db.prepare(`UPDATE posts SET bill_rate_cents = ? WHERE id = ?`).run(cents, postIds[post]);
  }

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

  // An open shift at the armed post. Only an officer holding a current Class G
  // can claim it, which is what makes the eligibility rule worth having.
  // Placed on day 6, which the loop above leaves clear for the armed officer -
  // otherwise his own roster would conflict and mask the licence rule.
  shifts.push({ user: null, post: postIds.gulfportYard, start: at(6, 18), end: at(7, 2), status: 'scheduled' });
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

  const tourRiverfront = await buildTour(siteIds.riverfront, 'Riverfront Interior Round', 'Hourly interior sweep of all occupied floors.', 35, [
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

  const tourGulfport = await buildTour(siteIds.gulfport, 'Gulfport Perimeter Sweep', 'Full fence line and trailer row inspection.', 45, [
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

  const tourPalmetto = await buildTour(siteIds.palmetto, 'Palmetto Community Patrol', 'Drive-through of common areas and amenities.', 25, [
    { name: 'North Gatehouse', tag: 'USC-NFC-PR-301', lat: 28.4515, lng: -81.4720,
      tasks: ['Gate arm down', 'Guest list current'] },
    { name: 'Clubhouse & Pool', tag: 'USC-NFC-PR-302',
      instructions: 'Pool closes at 22:00. Clear the deck and secure the gate.',
      tasks: ['Pool gate locked', 'Clubhouse secured', 'No after-hours guests'] },
    { name: 'Mail Pavilion', tag: 'USC-NFC-PR-303',
      tasks: ['Parcel lockers secured', 'Lighting operational'] },
  ]);

  /* --------------------------------------------- notice board & training -- */

  const insertBroadcast = db.prepare(
    `INSERT INTO broadcasts
     (title, body, priority, requires_ack, audience_role, audience_site_id, published_at, expires_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  const officerIds = [
    users.marcus, users.janelle, users.dwayne, users.alicia, users.trainee, users.contractor,
  ];

  for (const b of BROADCASTS) {
    const publishedAt = at(-b.daysAgo, 8, 30);
    const id = Number((await insertBroadcast.run(
      b.title,
      b.body,
      b.priority,
      b.requiresAck ? 1 : 0,
      b.audienceRole ?? null,
      b.site ? siteIds[b.site] : null,
      toSql(publishedAt),
      b.expiresInDays ? toSql(at(-b.daysAgo + b.expiresInDays, 23, 59)) : null,
      b.priority === 'normal' ? users.supervisor : users.admin
    )).lastInsertRowid);

    // Older notices are mostly read; the newest ones are still landing. An
    // unacknowledged urgent notice is exactly what the supervisor board is for.
    for (const [i, uid] of officerIds.entries()) {
      const read = b.daysAgo > 2 ? i < 6 : i < 3;
      const acked = b.requiresAck && (b.daysAgo > 7 ? i < 5 : i < 2);
      if (!read) continue;
      await db.prepare(
        `INSERT INTO broadcast_receipts (broadcast_id, user_id, read_at, acknowledged_at)
         VALUES (?,?,?,?)`
      ).run(
        id,
        uid,
        toSql(at(-b.daysAgo, 9 + (i % 6), 15)),
        acked ? toSql(at(-b.daysAgo, 9 + (i % 6), 20)) : null
      );
    }
  }

  const insertTraining = db.prepare(
    `INSERT INTO trainings
     (title, description, video_url, duration_seconds, required, due_at, audience_role, created_by)
     VALUES (?,?,?,?,?,?,?,?)`
  );

  const trainingIds = [];
  for (const t of TRAININGS) {
    const clip = CLIPS[t.clip % CLIPS.length];
    trainingIds.push({
      id: Number((await insertTraining.run(
        t.title,
        t.description,
        clip.url,
        clip.seconds,
        t.required ? 1 : 0,
        t.dueInDays ? toSql(at(t.dueInDays, 23, 59)) : null,
        t.audienceRole ?? null,
        users.admin
      )).lastInsertRowid),
      seconds: clip.seconds,
      armedOnly: Boolean(t.armedOnly),
    });
  }

  /**
   * Spread completion around so the board has something to show: most people
   * through the older courses, a scatter of part-watched, and the newest
   * required ones still outstanding.
   */
  for (const [ti, t] of trainingIds.entries()) {
    const audience = t.armedOnly ? [users.dwayne, users.supervisor] : officerIds;
    for (const [ui, uid] of audience.entries()) {
      const roll = (ti * 7 + ui * 3) % 10;
      if (roll < 5) {
        // Watched in full.
        await db.prepare(
          `INSERT INTO training_progress (training_id, user_id, seconds_watched, completed_at)
           VALUES (?,?,?,?) ON CONFLICT (training_id, user_id) DO NOTHING`
        ).run(t.id, uid, t.seconds, toSql(at(-(roll + ti), 11, 0)));
      } else if (roll < 7) {
        // Started, did not finish.
        await db.prepare(
          `INSERT INTO training_progress (training_id, user_id, seconds_watched, completed_at)
           VALUES (?,?,?,NULL) ON CONFLICT (training_id, user_id) DO NOTHING`
        ).run(t.id, uid, Math.floor(t.seconds * (0.2 + (roll % 3) * 0.2)));
      }
      // Anything else is untouched, which is the interesting case.
    }
  }

  /* ------------------------------------------------------------- messaging -- */

  const staffByKey = {
    admin: users.admin,
    supervisor: users.supervisor,
    marcus: users.marcus,
    janelle: users.janelle,
    dwayne: users.dwayne,
    alicia: users.alicia,
    trainee: users.trainee,
    contractor: users.contractor,
  };

  for (const t of THREADS) {
    const last = t.messages[t.messages.length - 1];
    const threadId = Number(
      (await db.prepare(`INSERT INTO threads (subject, created_by, last_message_at) VALUES (?,?,?)`)
        .run(t.subject, staffByKey[t.participants[0]], toSql(at(last[1], last[3], 0)))).lastInsertRowid
    );
    for (const key of t.participants) {
      await db.prepare(`INSERT INTO thread_participants (thread_id, user_id) VALUES (?,?)`)
        .run(threadId, staffByKey[key]);
    }
    for (const [who, days, body, hour] of t.messages) {
      await db.prepare(`INSERT INTO messages (thread_id, sender_id, body, sent_at) VALUES (?,?,?,?)`)
        .run(threadId, staffByKey[who], body, toSql(at(days, hour, 0)));
    }
  }

  /* ------------------------------------------------- supervisor visit log -- */

  (await db.prepare(
    `INSERT INTO supervisor_visits
     (supervisor_id, officer_id, site_id, post_id, visited_at, uniform_ok, post_orders_reviewed,
      equipment_ok, site_secure, rating, notes, client_note, latitude, longitude)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    users.supervisor, users.marcus, siteIds.riverfront, postIds.riverfrontLobby,
    toSql(at(-2, 11, 30)), 1, 1, 1, 1, 5,
    'Post in good order. Visitor log current and legible. Reviewed the storm annex with the officer.',
    'Supervisor visit to the lobby. Visitor log current; hurricane procedures reviewed with the officer.',
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

  /* --------------------------------------------------------- client portal -- */

  // Each contact sees only their own property. Keeping them on separate sites is
  // the point: it is what the portal's scoping is tested against.
  const clientLogins = [
    {
      email: 'dana.whitfield@riverfrontholdings.com', name: 'Dana Whitfield',
      company: 'Riverfront Holdings LLC', password: 'riverfront-portal-01', sites: [siteIds.riverfront],
    },
    {
      email: 'marcus.reyes@palmettoridgehoa.org', name: 'Marcus Reyes',
      company: 'Palmetto Ridge HOA', password: 'palmetto-portal-02', sites: [siteIds.palmetto],
    },
    {
      email: 'alicia.grant@gulfportfreight.com', name: 'Alicia Grant',
      company: 'Gulfport Freight Co', password: 'gulfport-portal-03', sites: [siteIds.gulfport],
    },
  ];

  for (const c of clientLogins) {
    const { hash, salt } = hashPassword(c.password);
    const id = Number((await db.prepare(
      `INSERT INTO client_users (email, name, company, password_hash, password_salt, created_by)
       VALUES (?,?,?,?,?,?)`
    ).run(c.email, c.name, c.company, hash, salt, users.admin)).lastInsertRowid);

    for (const siteId of c.sites) {
      await db.prepare(`INSERT INTO client_sites (client_user_id, site_id) VALUES (?,?)`).run(id, siteId);
    }
  }

  /* -------------------------------------------------------------- invoices -- */

  /**
   * Built with the same code the API uses, so the demo data cannot drift away
   * from what the generator actually produces.
   */
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  for (const spec of [
    { site: siteIds.riverfront, from: -14, to: -8, status: 'paid', due: -1 },
    { site: siteIds.riverfront, from: -7, to: -1, status: 'sent', due: 10 },
    // Overdue, so the receivables view has something to chase.
    { site: siteIds.palmetto, from: -7, to: -1, status: 'sent', due: -4 },
  ]) {
    const start = day(spec.from);
    const end = day(spec.to);
    const { lines } = await buildLines({
      siteId: spec.site,
      start,
      end: day(spec.to + 1),
    });
    if (lines.length === 0) continue;

    const totals = invoiceTotals(lines, 0);
    const id = Number((await db.prepare(
      `INSERT INTO invoices
       (number, site_id, period_start, period_end, status, subtotal_cents, tax_cents,
        total_cents, cost_cents, due_on, issued_at, paid_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      await nextNumber(new Date().getFullYear()),
      spec.site,
      toDateString(start),
      toDateString(end),
      spec.status,
      totals.subtotalCents,
      totals.taxCents,
      totals.totalCents,
      totals.costCents,
      toDateString(day(spec.due)),
      toSql(day(spec.to + 1)),
      spec.status === 'paid' ? toSql(day(spec.due)) : null,
      users.admin
    )).lastInsertRowid);

    for (const line of lines) {
      await db.prepare(
        `INSERT INTO invoice_lines
         (invoice_id, post_id, description, minutes, rate_cents, amount_cents, cost_cents, sequence)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        id, line.post_id, line.description, line.minutes,
        line.rate_cents, line.amount_cents, line.cost_cents, line.sequence
      );
    }
  }

  /* ------------------------------------------------------- patrol history -- */

  /**
   * Three weeks of walked rounds.
   *
   * Without these the Tours board and the client's patrol proof are empty, which
   * is the one thing a client actually asks to see. Most rounds complete; a few
   * carry a skipped checkpoint with a reason, and one was abandoned partway,
   * because a history where nothing ever goes wrong teaches nobody how the
   * screens read when it does.
   */
  const SKIP_REASONS = [
    'Contractor working in the area, could not reach the tag.',
    'Door locked from the far side, reported to building management.',
    'Standing water from the storm; unsafe to approach.',
    'Tag not reading - reported for replacement.',
  ];

  const runTours = [
    { tourId: tourRiverfront, officer: users.marcus, perDay: 2, startHour: 7, minutes: 35 },
    { tourId: tourGulfport, officer: users.dwayne, perDay: 1, startHour: 2, minutes: 45 },
    { tourId: tourPalmetto, officer: users.janelle, perDay: 1, startHour: 19, minutes: 25 },
  ];

  let runCount = 0;
  let skipCount = 0;

  for (const spec of runTours) {
    const checkpoints = await db
      .prepare(`SELECT id, required FROM checkpoints WHERE tour_id = ? ORDER BY sequence`)
      .all(spec.tourId);

    for (let day = 21; day >= 1; day--) {
      for (let n = 0; n < spec.perDay; n++) {
        // A round is skipped entirely now and then - sickness, a post left short.
        if ((day * 3 + n) % 11 === 0) continue;

        const started = at(-day, spec.startHour + n * 6, (day * 7) % 45);
        const abandoned = day === 9 && n === 0;
        const finished = abandoned ? null : new Date(started.getTime() + spec.minutes * 60000);

        const runId = Number((await db.prepare(
          `INSERT INTO tour_runs (tour_id, user_id, started_at, completed_at, status)
           VALUES (?,?,?,?,?)`
        ).run(
          spec.tourId,
          spec.officer,
          toSql(started),
          finished ? toSql(finished) : null,
          abandoned ? 'abandoned' : 'completed'
        )).lastInsertRowid);
        runCount += 1;

        const gap = Math.floor((spec.minutes * 60000) / checkpoints.length);
        for (const [i, cp] of checkpoints.entries()) {
          // The abandoned round stops halfway through.
          if (abandoned && i >= Math.ceil(checkpoints.length / 2)) {
            await db.prepare(
              `INSERT INTO tour_run_checkpoints (tour_run_id, checkpoint_id, status) VALUES (?,?,'pending')`
            ).run(runId, cp.id);
            continue;
          }

          // Yesterday's first round had a required checkpoint skipped - a locked
          // door on the route - which supervisors see in their alerts.
          const skipped = (!cp.required && (day + i) % 9 === 0) || (day === 1 && n === 0 && i === 1 && cp.required);
          if (skipped) skipCount += 1;

          await db.prepare(
            `INSERT INTO tour_run_checkpoints
             (tour_run_id, checkpoint_id, status, scanned_at, method, latitude, longitude, skip_reason)
             VALUES (?,?,?,?,?,?,?,?)`
          ).run(
            runId,
            cp.id,
            skipped ? 'skipped' : 'done',
            toSql(new Date(started.getTime() + gap * (i + 1))),
            skipped ? null : (i % 3 === 0 ? 'nfc' : 'qr'),
            skipped ? null : 30.3196 + i * 0.0002,
            skipped ? null : -81.6795 - i * 0.0002,
            skipped ? SKIP_REASONS[(day + i) % SKIP_REASONS.length] : null
          );
        }

        // Mark the tasks on each scanned checkpoint as done.
        await db.exec(`
          INSERT INTO tour_run_tasks (tour_run_checkpoint_id, checkpoint_task_id, status, completed_at)
          SELECT trc.id, ct.id, 'done', trc.scanned_at
          FROM tour_run_checkpoints trc
          JOIN checkpoint_tasks ct ON ct.checkpoint_id = trc.checkpoint_id
          WHERE trc.tour_run_id = ${runId} AND trc.status = 'done'
        `);
      }
    }
  }

  /* ------------------------------------------------------- more incidents -- */

  /**
   * A realistic incident mix.
   *
   * Spread across sites, categories and severities, with a few still open so
   * the review queue is not empty, and two carrying a cost-recovery figure so
   * the client billing conversation has something behind it.
   */
  const MORE_INCIDENTS = [
    {
      officer: users.janelle, site: 'palmetto', post: 'palmettoGate', name: 'Janelle Carter',
      category: 'Trespass', severity: 'medium', days: -2, hour: 23, at: 'North gate, visitor lane',
      what: 'Two individuals on foot attempted to follow a resident vehicle through the north gate at 23:14. I stepped out and asked them to stop; both said they were visiting a friend but could not give a unit number and were not on the guest list. I explained they could not enter without a resident authorising them and offered to call the unit if they gave me a name. They declined and left on foot toward Palmetto Ridge Drive.',
      resolution: 'Both individuals left the property without incident. Description passed to the oncoming shift and to the HOA contact.',
      notified: 'Renata Diaz (supervisor), Marcus Reyes (HOA)',
      status: 'closed',
    },
    {
      officer: users.dwayne, site: 'gulfport', post: 'gulfportYard', name: 'Dwayne Foster',
      category: 'Theft', severity: 'high', days: -5, hour: 3, at: 'Trailer row, bay 12',
      what: 'On the 03:00 perimeter sweep I found the seal on trailer 4471 cut and hanging. The trailer doors were closed but unlatched. I did not enter the trailer. I secured the area, photographed the seal and the door, and called dispatch immediately.',
      resolution: 'Tampa PD attended at 03:52 and took a report. Gulfport Freight operations manager notified and attended at 05:10. Inventory shortfall confirmed by the client the following morning.',
      other: 'Camera coverage on trailer row is limited to the aisle entrance; the trailer itself is not covered.',
      notified: 'Dispatch, Tampa PD, Alicia Grant (Gulfport Freight)',
      police: true, policeRef: 'TPD-2026-118842', cost: 1240000,
      status: 'under_review',
    },
    {
      officer: users.marcus, site: 'riverfront', post: 'riverfrontLobby', name: 'Marcus Bell',
      category: 'Medical', severity: 'high', days: -8, hour: 14, at: 'Main lobby, seating area',
      what: 'A visitor waiting in the lobby became unsteady and sat down heavily at about 14:20. He was conscious but pale and sweating, and said he felt faint and had not eaten. I called 911 at 14:22, stayed with him, and kept the seating area clear.',
      resolution: 'Paramedics arrived 14:31 and assessed him on scene. He declined transport and left with a colleague at 14:55. No further action.',
      other: 'AED was retrieved but not used.',
      notified: '911, Renata Diaz (supervisor), Dana Whitfield (building)',
      status: 'closed',
    },
    {
      officer: users.alicia, site: 'coral', post: 'coralRetail', name: 'Alicia Nunez',
      category: 'Property Damage', severity: 'low', days: -11, hour: 18, at: 'East entrance, planter bed',
      what: 'A delivery vehicle reversing at the east entrance struck the concrete planter and cracked it along the north face. The driver stopped and gave his details without being asked.',
      resolution: 'Driver details and company recorded. Photographs taken. Property manager notified the same evening.',
      notified: 'Nina Alvarez (Coral Bay Property Group)',
      cost: 48000,
      status: 'closed',
    },
    {
      officer: users.marcus, site: 'riverfront', post: 'riverfrontPatrol', name: 'Marcus Bell',
      category: 'Suspicious Activity', severity: 'medium', days: -13, hour: 1, at: 'Parking deck level 3',
      what: 'During the 01:00 exterior round I observed a male walking between parked vehicles on deck 3, stopping at several and looking into the windows. When he saw me he walked toward the stairwell at a normal pace. I asked if he needed assistance; he said he had forgotten where he parked, then left the deck on foot.',
      resolution: 'No damage or entry found on inspection of the vehicles in that row. Description and time passed to dispatch and logged for the following shifts.',
      other: 'Deck 3 lighting on the north side is poor - two fittings out. Reported separately to building management.',
      notified: 'Dispatch',
      status: 'closed',
    },
    {
      officer: users.janelle, site: 'palmetto', post: 'palmettoGate', name: 'Janelle Carter',
      category: 'Policy Violation', severity: 'low', days: -16, hour: 21, at: 'North gatehouse',
      what: 'A resident became verbally abusive when asked to pull aside because his transponder did not read and he was not on the guest list for the unit he named. He used obscenities and refused to move for several minutes, blocking the lane.',
      resolution: 'I remained at the gatehouse, did not engage further, and called the HOA contact. The resident eventually provided his unit number, which checked out, and was admitted. Incident logged at the HOA contact’s request.',
      other: 'Third recorded incident involving the same resident.',
      notified: 'Renata Diaz (supervisor), Marcus Reyes (HOA)',
      status: 'closed',
    },
    {
      officer: users.dwayne, site: 'gulfport', post: 'gulfportYard', name: 'Dwayne Foster',
      category: 'Alarm / System', severity: 'medium', days: -19, hour: 4, at: 'Yard gate 2 sensor',
      what: 'Gate 2 sensor alarmed four times between 04:05 and 04:40 with no vehicle present. Physical inspection showed no breach of the fence line or the gate.',
      resolution: 'Isolated to a faulty sensor. Client maintenance raised a ticket the same morning. Gate monitored visually for the remainder of the shift.',
      notified: 'Alicia Grant (Gulfport Freight)',
      status: 'closed',
    },
    {
      officer: users.alicia, site: 'coral', post: 'coralRetail', name: 'Alicia Nunez',
      category: 'Theft', severity: 'medium', days: -24, hour: 16, at: 'Unit 14, retail floor',
      what: 'Store manager at unit 14 reported a shoplifting in progress. I attended and observed a female leaving the unit with unpaid items visible. I did not detain. I followed at a distance to the car park and recorded the vehicle plate and direction of travel.',
      resolution: 'Plate and description provided to the store manager and to Fort Lauderdale PD, who took a report by phone. No contact was made with the individual.',
      notified: 'Fort Lauderdale PD, store manager unit 14',
      police: true, policeRef: 'FLPD-2026-55190',
      cost: 21500,
      status: 'closed',
    },
    {
      officer: users.marcus, site: 'riverfront', post: 'riverfrontLobby', name: 'Marcus Bell',
      category: 'Access Control', severity: 'low', days: -1, hour: 9, at: 'Main lobby turnstiles',
      what: 'An individual attempted to tailgate through the turnstiles behind a badged employee at 09:12. I intercepted politely and asked him to sign in. He was a contractor expected by the level 4 tenant but had not been added to the visitor list.',
      resolution: 'Verified with the tenant by phone, issued a visitor badge and escorted him to the lift. Tenant reminded to pre-register contractors.',
      notified: 'Dana Whitfield (building)',
      status: 'submitted',
    },
  ];

  // 0001-0003 are used by the incidents above.
  let incidentSeq = 4;

  for (const i of MORE_INCIDENTS) {
    await insertIncident.run(
      `USC-${year}-${String(incidentSeq++).padStart(4, '0')}`,
      i.officer, siteIds[i.site], postIds[i.post], i.name, '(904) 555-0155',
      i.category, i.severity, toSql(at(i.days, i.hour, (incidentSeq * 7) % 60)),
      i.at, i.what, i.resolution || null, i.other || null, i.involved || null,
      i.notified || null, i.police ? 1 : 0, i.cost ?? null, i.status
    );
  }

  /* -------------------------------------------------- more post visits -- */

  const VISITS = [
    { officer: users.marcus, site: 'riverfront', post: 'riverfrontLobby', days: -2, hour: 10, rating: 5,
      notes: 'Lobby presentable, visitor log current, uniform correct. Marcus raised the camera 6 fault again - chased with building management.',
      clientNote: 'Lobby visited. The camera 6 fault has been chased with building management.' },
    { officer: users.janelle, site: 'palmetto', post: 'palmettoGate', days: -4, hour: 20, rating: 4,
      notes: 'Gate log up to date. Reminded Janelle to record contractor plates in full rather than the last three digits.',
      clientNote: 'Gate visited in the evening. Gate log up to date.' },
    { officer: users.dwayne, site: 'gulfport', post: 'gulfportYard', days: -6, hour: 3, rating: 5,
      notes: 'Weapon check logged correctly at shift start. Seal procedure being followed to the letter since the bulletin.',
      clientNote: 'Overnight yard visit. Seal procedure followed.' },
    { officer: users.alicia, site: 'coral', post: 'coralRetail', days: -17, hour: 15, rating: 4,
      notes: 'Good rapport with store managers. Radio left in the back office for part of the round - corrected on the spot.',
      clientNote: 'Supervisor visit to the retail floor. No concerns.' },
    { officer: users.marcus, site: 'riverfront', post: 'riverfrontPatrol', days: -12, hour: 23, rating: 5,
      notes: 'Exterior round walked properly, not driven. Deck 3 lighting fault noted and reported.',
      clientNote: 'Night exterior round checked. A lighting fault on deck 3 has been reported.' },
    { officer: users.janelle, site: 'palmetto', post: 'palmettoGate', days: -15, hour: 21, rating: 3, insecure: true,
      notes: 'Arrived to find the gatehouse door propped for airflow. Explained why it cannot be left open. Otherwise post in order.',
      clientNote: 'Evening gate visit. The gatehouse door was found propped open and closed on the spot.' },
    { officer: users.dwayne, site: 'gulfport', post: 'gulfportYard', days: -18, hour: 2, rating: 5,
      notes: 'Full perimeter walked in poor weather without prompting. Post orders reviewed together.',
      clientNote: 'Overnight perimeter check. No concerns.' },
    { officer: users.alicia, site: 'coral', post: 'coralRetail', days: -23, hour: 17, rating: 4,
      notes: 'Handled a difficult customer interaction well while I was present. Uniform shirt needs replacing - ordered.',
      clientNote: 'Supervisor visit to the retail floor. No concerns.' },
  ];

  for (const v of VISITS) {
    await db.prepare(
      `INSERT INTO supervisor_visits
       (supervisor_id, officer_id, site_id, post_id, visited_at, uniform_ok, post_orders_reviewed,
        equipment_ok, site_secure, rating, notes, client_note, latitude, longitude)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      users.supervisor, v.officer, siteIds[v.site], postIds[v.post], toSql(at(v.days, v.hour, 20)),
      v.rating >= 4 || v.insecure ? 1 : 0, 1, v.rating >= 4 || v.insecure ? 1 : 0, v.insecure ? 0 : 1, v.rating, v.notes, v.clientNote, null, null
    );
  }

  /* ------------------------------------------------------- more duress -- */

  await db.prepare(
    `INSERT INTO panic_alerts
     (user_id, post_id, triggered_at, latitude, longitude, accuracy, status,
      acknowledged_by, acknowledged_at, resolved_at, resolution_note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    users.janelle, postIds.palmettoGate, toSql(at(-16, 21, 34)),
    28.4515, -81.4720, 9, 'resolved',
    users.supervisor, toSql(at(-16, 21, 35)), toSql(at(-16, 21, 58)),
    'Triggered during the gate confrontation logged in the incident report. Supervisor reached her within a minute; no physical contact occurred and no injury. Reviewed afterwards and confirmed the right call to press it.'
  );

  await db.prepare(
    `INSERT INTO panic_alerts
     (user_id, post_id, triggered_at, latitude, longitude, accuracy, status,
      acknowledged_by, acknowledged_at, resolved_at, resolution_note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    users.alicia, postIds.coralRetail, toSql(at(-21, 16, 5)),
    26.1224, -80.1373, 22, 'false_alarm',
    users.supervisor, toSql(at(-21, 16, 6)), toSql(at(-21, 16, 9)),
    'Pressed in a pocket while the officer was moving a barrier. Confirmed safe by phone within three minutes. No action needed - a false alarm costs us nothing and hesitating costs everything.'
  );

  /* ------------------------------------------------ the regional operation -- */

  // Six more client sites and thirty-five more staff around the original four.
  // Kept in its own module so the fixtures the test suites rely on stay above,
  // untouched and easy to read.
  const expansion = await seedExpansion({
    db, at, toSql, hashPin, hashPassword, raiseFlag, buildTour, buildLines, nextNumber,
    invoiceTotals, toDateString, users, year,
  });

  // Derive flags from everything above.
  await sweep();

  // Pay periods last, once the sweep has closed any shift left open, so the
  // approvals are pinned to the hours as they will stay.
  const payroll = await seedPayroll({ db, users });

  // Extra coverage clients have asked for from the portal: one waiting for an
  // answer, one already scheduled onto open shifts, one declined.
  {
    const contact = async (email) =>
      (await db.prepare(`SELECT c.id, cs.site_id FROM client_users c JOIN client_sites cs ON cs.client_user_id = c.id
                         WHERE c.email = ? ORDER BY cs.site_id LIMIT 1`).get(email));
    const dana = await contact('dana.whitfield@riverfrontholdings.com');
    const marcusR = await contact('marcus.reyes@palmettoridgehoa.org');
    const alicia = await contact('alicia.grant@gulfportfreight.com');
    const request = (c, startDays, startHour, hours, officers, armed, reason, extra = {}) =>
      db.prepare(
        `INSERT INTO coverage_requests (site_id, client_user_id, starts_at, ends_at, officers, armed, reason,
           status, response, post_id, shifts_created, handled_by, handled_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        c.site_id, c.id, toSql(at(startDays, startHour)), toSql(at(startDays, startHour + hours)),
        officers, armed, reason, extra.status || 'open', extra.response || null, extra.postId || null,
        extra.shifts || 0, extra.by || null, extra.handledAt ? toSql(extra.handledAt) : null,
        toSql(extra.created || at(-1, 15, 20))
      );
    if (dana) {
      await request(dana, 5, 17, 6, 2, false,
        'Tenant holiday reception in the main atrium, about 300 guests. Need two officers on the doors and lobby.');
    }
    if (marcusR) {
      const gate = (await db.prepare(`SELECT id FROM posts WHERE site_id = ? ORDER BY id LIMIT 1`).get(marcusR.site_id)).id;
      for (let i = 0; i < 1; i++) {
        await db.prepare(
          `INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status, notes, created_by)
           VALUES (NULL, ?, ?, ?, 'scheduled', ?, ?)`
        ).run(gate, toSql(at(9, 18)), toSql(at(9, 24)), 'Extra coverage requested by the client', users.supervisor);
      }
      await request(marcusR, 9, 18, 6, 1, false,
        'HOA annual meeting in the clubhouse - extra officer at the gate for visitor check-in.',
        { status: 'scheduled', postId: gate, shifts: 1, by: users.supervisor, handledAt: at(-1, 9, 5), created: at(-2, 19, 40),
          response: 'Scheduled - one officer at the main gate from 6 PM.' });
    }
    if (alicia) {
      await request(alicia, 3, 22, 8, 2, true,
        'High-value container arriving overnight; want two armed officers on the yard.',
        { status: 'declined', by: users.admin, handledAt: at(-1, 11, 30), created: at(-2, 8, 15),
          response: 'We cannot staff two armed officers on that notice. We can offer one armed officer - please call to confirm.' });
    }
  }

  // Visitors and pass-down notes, from the shifts worked above.
  const postLog = await seedPostLog({ db });

  const flagCount = (await db.prepare(`SELECT COUNT(*) AS n FROM flags`).get()).n;

  log(`
  USA Security Connect - demo data loaded
  ---------------------------------------
    ${(await db.prepare(`SELECT COUNT(*) AS n FROM sites`).get()).n} sites, ${(await db.prepare(`SELECT COUNT(*) AS n FROM posts`).get()).n} posts
    ${(await db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).n} employees
    ${(await db.prepare(`SELECT COUNT(*) AS n FROM shifts`).get()).n} shifts, ${(await db.prepare(`SELECT COUNT(*) AS n FROM time_entries`).get()).n} time entries
    ${(await db.prepare(`SELECT COUNT(*) AS n FROM incidents`).get()).n} incidents, ${(await db.prepare(`SELECT COUNT(*) AS n FROM tours`).get()).n} tours
    ${flagCount} compliance flags
    ${postLog.visitors} visitors logged, ${postLog.notes} pass-down notes
    ${postLog.watchlist} watchlist entries, ${postLog.violations} vehicle violations
    ${postLog.activity} activity entries, ${postLog.issues} building issues, ${postLog.found} lost-and-found items
    ${postLog.contacts} site contacts, ${postLog.feedback} client ratings, ${postLog.orders} versions of post orders, ${postLog.orderRequests} client change requests, ${postLog.followUps} incident follow-ups

    Payroll: week of ${payroll.closed}
             week of ${payroll.due}

    ${(await db.prepare(`SELECT COUNT(*) AS n FROM certifications`).get()).n} certifications, ${(await db.prepare(`SELECT COUNT(*) AS n FROM time_off_requests`).get()).n} time-off requests
    ${(await db.prepare(`SELECT COUNT(*) AS n FROM location_pings`).get()).n} GPS points, ${(await db.prepare(`SELECT COUNT(*) AS n FROM status_checks`).get()).n} status check-ins, ${(await db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get()).n} invoices

  On duty right now (new sites):
  ${expansion.live.map((l) => `  ${l}`).join('\n') || '  nobody - every roster slot is between shifts'}

  Sign-in codes (demo PINs):
    1001 / 2468   Vince Ortega      Administrator      W-2 salary, exempt
    1002 / 3571   Renata Diaz       Field Supervisor   W-2 hourly
    1003 / 4812   Marcus Bell       Officer            W-2, currently on duty
    1004 / 5930   Janelle Carter    Officer            W-2, licence expiring
    1005 / 6174   Dwayne Foster     Officer            1099 contractor, armed post
    1006 / 7285   Alicia Nunez      Officer            W-2 hourly
    1007 / 8140   Kevin Osei        Officer            W-2, must change PIN
    1008 / 9351   Renee Okafor      Officer            1099 contractor, per shift

  Regional staff (code / PIN):
  ${expansion.staff
    .map((s) => `  ${s.code} / ${s.pin}   ${s.name.padEnd(20)} ${s.role === 'supervisor' ? 'Supervisor' : 'Officer   '}  ${s.type === '1099' ? '1099' : 'W-2 '}${s.armed ? '  armed' : ''}`)
    .join('\n')}

  Client portal logins (/portal):
    dana.whitfield@riverfrontholdings.com / riverfront-portal-01   Riverfront Commerce Center
    marcus.reyes@palmettoridgehoa.org     / palmetto-portal-02     Palmetto Ridge Residences
    alicia.grant@gulfportfreight.com      / gulfport-portal-03     Gulfport Logistics Yard
  ${expansion.clientLogins.map((c) => `  ${c.email.padEnd(37)} / ${c.password.padEnd(22)} ${c.site}`).join('\n')}
  `);

  return true;
}
