/**
 * Demo post logs: visitors and pass-down notes, built from the shifts that
 * were actually worked so every entry is signed by an officer who was on that
 * post at that hour.
 *
 *  - The last three days of visitors at every site, a few an hour through the
 *    working day, each signed in and out by whoever was on duty.
 *  - A few people still inside right now wherever someone is on post.
 *  - Pass-down notes left at the end of recent shifts, read by the officers
 *    who took the post over afterwards - and some left for whoever is on
 *    now, not yet read, so there is something to acknowledge.
 */

import { toSql } from './services/compliance.js';

const PEOPLE = [
  ['Carlos Mendoza', 'FedEx Freight', 'delivery', 'Pallet delivery to receiving', null],
  ['Priya Shah', 'Otis Elevator', 'contractor', 'Quarterly elevator inspection', 'Facilities'],
  ['Tom Whitlock', null, 'visitor', 'Meeting with property manager', 'Leasing office'],
  ['Angela Brooks', 'Cintas', 'vendor', 'First-aid cabinet restock', 'Facilities'],
  ['Derrick Lyons', 'Comcast Business', 'contractor', 'Network outage ticket, 3rd floor', 'Suite 310'],
  ['Maria Gonzalez', null, 'visitor', 'Job interview', 'HR'],
  ['Kevin Park', 'Amazon Logistics', 'delivery', 'Parcel drop', null],
  ['Rachel Adams', 'Rentokil', 'vendor', 'Monthly pest control', 'Facilities'],
  ['James Carter', 'City of Tallahassee', 'visitor', 'Fire code walk-through', 'Building engineer'],
  ['Sonia Patel', 'Sysco', 'delivery', 'Cafe delivery', 'Cafe manager'],
  ['Ben Hughes', 'ABM Janitorial', 'contractor', 'Carpet cleaning, lobby', 'Facilities'],
  ['Laura Chen', null, 'visitor', 'Visiting tenant', 'Suite 204'],
  ['Marcus Doyle', 'Johnson Controls', 'contractor', 'HVAC service call', 'Building engineer'],
  ['Hannah Wright', 'UPS', 'delivery', 'Signature-required package', 'Mailroom'],
  ['Omar Haddad', 'Iron Mountain', 'vendor', 'Shred bin collection', 'Records'],
  ['Grace Liu', null, 'visitor', 'Client meeting', 'Suite 500'],
];
const PLATES = ['JKT 4821', 'FL 7GH 22', 'QRM 318', 'BTX 9921', null, 'LMN 6603', null, 'ZPD 4410'];
const VEHICLES = ['White box truck', 'Silver sedan', 'Grey work van', 'Black pickup', null, 'Blue hatchback'];

const PASSDOWN = [
  ['normal', 'East stairwell door is sticking again - it closes but does not latch unless you push it. Work order is in, check it on every round.'],
  ['important', 'Tenant in Suite 310 expecting a courier after hours with a signature-required package. Call their mobile on the board before letting the courier up.'],
  ['normal', 'Grey Honda (plate on the board) parked in the fire lane since this morning. Tagged it at 14:00 - tow if still there by end of shift.'],
  ['normal', 'Keys for the roof hatch were signed back in; key box count is correct.'],
  ['important', 'Former employee Todd R. is not permitted on site - photo is at the desk. If seen, do not engage, call the supervisor and 911.'],
  ['normal', 'Lobby light by the east entrance is flickering. Reported to facilities, no action needed from us.'],
  ['normal', 'Cleaning crew is starting an hour late tonight; they have the new badge list.'],
  ['important', 'Fire panel showed a trouble signal on zone 4 at 02:10, cleared on its own. Alarm company notified. Log any repeat straight away.'],
  ['normal', 'Delivery dock gate closes slowly - wait for it to seat fully before walking away.'],
  ['normal', 'All quiet. Rounds complete, nothing outstanding.'],
];

/** A small repeatable generator so the demo is the same every time it loads. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export async function seedPostLog({ db }) {
  const rand = rng(20260929);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const now = new Date();
  const ts = (v) => (v instanceof Date ? v : new Date(v));

  const entries = (
    await db
      .prepare(
        `SELECT te.id, te.user_id, te.post_id, te.clock_in_at, te.clock_out_at, p.site_id
         FROM time_entries te JOIN posts p ON p.id = te.post_id
         WHERE te.clock_in_at >= ?
         ORDER BY te.clock_in_at`
      )
      .all(toSql(new Date(now.getTime() - 3 * 86400000)))
  ).map((e) => ({ ...e, in: ts(e.clock_in_at), out: e.clock_out_at ? ts(e.clock_out_at) : null }));

  const insertVisitor = (e, person, arrived, departed, departedBy) =>
    db
      .prepare(
        `INSERT INTO visitor_log (site_id, post_id, full_name, company, purpose, host, kind, vehicle_plate,
           vehicle_desc, badge_number, arrived_at, departed_at, logged_by, departed_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        e.site_id, e.post_id, person[0], person[1], person[3], person[4], person[2],
        person[2] === 'visitor' ? null : pick(PLATES), person[2] === 'visitor' ? null : pick(VEHICLES),
        rand() < 0.6 ? `V-${100 + Math.floor(rand() * 900)}` : null,
        toSql(arrived), departed ? toSql(departed) : null, e.user_id, departed ? departedBy : null, toSql(arrived)
      );

  let visitors = 0;
  // Through each worked shift, a visitor every hour or two during the day.
  for (const e of entries) {
    const end = e.out || now;
    for (let t = e.in.getTime() + 20 * 60000; t < end.getTime() - 30 * 60000; t += (60 + rand() * 80) * 60000) {
      const hour = new Date(t).getHours();
      if (hour < 7 || hour > 19 || rand() < 0.35) continue;
      const arrived = new Date(t);
      const stay = (15 + rand() * 150) * 60000;
      const left = new Date(t + stay);
      const stillHere = !e.out && left > now;
      if (stillHere && rand() < 0.5) continue;
      await insertVisitor(e, pick(PEOPLE), arrived, stillHere ? null : left < end ? left : end, e.user_id);
      visitors++;
    }
  }
  // And someone inside right now at every post that is staffed.
  for (const e of entries.filter((x) => !x.out)) {
    const open = (await db.prepare(`SELECT COUNT(*) AS n FROM visitor_log WHERE site_id = ? AND departed_at IS NULL`).get(e.site_id)).n;
    if (Number(open) > 0) continue;
    const arrived = new Date(Math.max(e.in.getTime() + 5 * 60000, now.getTime() - (20 + rand() * 70) * 60000));
    if (arrived > now) continue;
    await insertVisitor(e, pick(PEOPLE), arrived, null, null);
    visitors++;
  }

  // Pass-down: left at clock-out on about half the finished shifts, read by
  // each officer who clocked in on that post afterwards.
  let notes = 0;
  const writeNote = async (e, when, [priority, body]) => {
    const info = await db
      .prepare(`INSERT INTO passdown_notes (post_id, author_id, time_entry_id, body, priority, created_at) VALUES (?,?,?,?,?,?)`)
      .run(e.post_id, e.user_id, e.id, body, priority, toSql(when));
    notes++;
    return Number(info.lastInsertRowid);
  };
  for (const e of entries.filter((x) => x.out && rand() < 0.5)) {
    const when = new Date(e.out.getTime() - 5 * 60000);
    const id = await writeNote(e, when, pick(PASSDOWN));
    const readers = entries.filter((x) => x.post_id === e.post_id && x.user_id !== e.user_id && x.in > when);
    // Whoever is on the post right now has not got round to reading the most
    // recent one yet - that is the one the demo shows waiting.
    for (const r of readers.filter((x) => x.out)) {
      await db
        .prepare(`INSERT INTO passdown_acks (note_id, user_id, acked_at) VALUES (?,?,?) ON CONFLICT DO NOTHING`)
        .run(id, r.user_id, toSql(new Date(r.in.getTime() + 10 * 60000)));
    }
  }
  // Make sure each officer on duty now has at least one unread note waiting.
  for (const e of entries.filter((x) => !x.out)) {
    const before = entries.filter((x) => x.post_id === e.post_id && x.out && x.user_id !== e.user_id && x.out <= e.in);
    const unread = (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM passdown_notes n WHERE n.post_id = ? AND n.author_id <> ?
             AND NOT EXISTS (SELECT 1 FROM passdown_acks a WHERE a.note_id = n.id AND a.user_id = ?)`
        )
        .get(e.post_id, e.user_id, e.user_id)
    ).n;
    if (Number(unread) > 0) continue;
    const prev = before[before.length - 1];
    if (prev) {
      await writeNote(prev, new Date(prev.out.getTime() - 5 * 60000), PASSDOWN[1]);
    } else {
      // Nobody worked the post before them in the window: the field
      // supervisor left the note instead.
      const sup = await db.prepare(`SELECT id FROM users WHERE role = 'supervisor' ORDER BY id LIMIT 1`).get();
      await writeNote({ post_id: e.post_id, user_id: sup.id, id: null }, new Date(e.in.getTime() - 30 * 60000), PASSDOWN[1]);
    }
  }

  /* ---------------------------------------------------------- watchlist -- */

  const sites = await db.prepare(`SELECT id, name FROM sites ORDER BY id`).all();
  const siteId = (re) => sites.find((x) => re.test(x.name))?.id || sites[0].id;
  const sup = await db.prepare(`SELECT id FROM users WHERE role = 'supervisor' ORDER BY id LIMIT 1`).get();
  const addWatch = (site, name, aliases, description, plate, reason, action, risk, expires) =>
    db
      .prepare(
        `INSERT INTO watchlist (site_id, full_name, aliases, description, vehicle_plate, reason, action, risk, expires_on, added_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(site, name, aliases, description, plate, reason, action, risk, expires, sup.id, toSql(new Date(now.getTime() - 20 * 86400000)));
  const inDays = (n) => new Date(now.getTime() + n * 86400000).toISOString().slice(0, 10);

  await addWatch(null, 'Todd Reardon', 'T. Reardon, Tod Reardon', 'White male, about 45, grey beard, often in a Jaguars cap.',
    null, 'Former employee terminated for theft of client property. Not permitted on any site we guard.', 'notify_supervisor', 'medium', null);
  const riverfrontWatch = await addWatch(siteId(/Riverfront/), 'Kyle Banner', 'K. Banner', 'Tall, shaved head, tattoo on left forearm.',
    'KBN 4471', 'Trespass warning issued by the property manager after a confrontation with a tenant. Police report JSO-26-118422.', 'call_police', 'high', inDays(300));
  await addWatch(siteId(/Riverfront/), 'Dana Mills', null, 'Former tenant employee.', null,
    'Access revoked by the tenant (Suite 310). May try to collect belongings - escort only, with the tenant present.', 'escort', 'low', inDays(30));
  await addWatch(siteId(/Harborview/), 'Marcus Hale', null, 'Late 20s, frequently near the ED entrance.', null,
    'Barred by hospital administration after repeated disturbances in the emergency department.', 'deny_entry', 'high', inDays(180));
  await addWatch(siteId(/Palmetto/), 'Brian Castillo', 'B. Castillo', null, 'PLM 2210',
    'Former resident evicted by the HOA. Gate access code revoked.', 'deny_entry', 'medium', inDays(90));
  await addWatch(siteId(/Gulfport/), 'Rick Dawson', null, 'Truck driver, red Peterbilt.', 'FL 8812K',
    'Banned from the yard by the client after a forklift incident.', 'deny_entry', 'medium', null);
  // One that has lapsed, to show expiry.
  await addWatch(siteId(/Riverfront/), 'Leon Price', null, null, null, 'Thirty-day ban after a parking dispute.', 'deny_entry', 'low', inDays(-3));

  // A past override at Riverfront: the officer checked ID and it was a different Kyle Banner.
  const rfEntry = entries.find((e) => e.site_id === siteId(/Riverfront/) && e.out);
  if (rfEntry) {
    const when = new Date(rfEntry.in.getTime() + 90 * 60000);
    await db
      .prepare(
        `INSERT INTO visitor_log (site_id, post_id, full_name, company, purpose, host, kind, arrived_at, departed_at,
           logged_by, departed_by, notes, watchlist_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(rfEntry.site_id, rfEntry.post_id, 'Kyle Banner', 'Banner Electric', 'Panel inspection, 2nd floor', 'Building engineer',
        'contractor', toSql(when), toSql(new Date(when.getTime() + 50 * 60000)), rfEntry.user_id, rfEntry.user_id,
        'Watchlist match overridden: Checked driver licence - different person (DOB 1991, entry is for a man in his 40s). Supervisor called.',
        Number(riverfrontWatch.lastInsertRowid), toSql(when));
    visitors++;
  }

  /* ---------------------------------------------------- vehicle violations -- */

  const month = (
    await db
      .prepare(
        `SELECT te.user_id, te.post_id, te.clock_in_at, te.clock_out_at, p.site_id
         FROM time_entries te JOIN posts p ON p.id = te.post_id
         WHERE te.clock_in_at >= ? AND te.clock_out_at IS NOT NULL ORDER BY te.clock_in_at`
      )
      .all(toSql(new Date(now.getTime() - 30 * 86400000)))
  ).map((e) => ({ ...e, in: ts(e.clock_in_at), out: ts(e.clock_out_at) }));

  const SPOTS = ['Fire lane by the east entrance', 'Visitor lot, row C', 'Loading dock bay 2', 'Accessible bay by the lobby',
    'Reserved tenant space 14', 'North lot, by the dumpsters', 'Main drive, in front of the doors'];
  const CARS = ['Grey Honda Accord', 'White Ford Transit', 'Black Chevy Tahoe', 'Red Nissan Altima', 'Silver Toyota Camry', 'Blue Jeep Wrangler'];
  const KINDS = [
    ['fire_lane', 'tagged'], ['no_permit', 'warning'], ['accessible', 'tagged'], ['blocking', 'warning'],
    ['reserved', 'warning'], ['abandoned', 'tagged'], ['fire_lane', 'towed'],
  ];
  // Two plates that keep coming back, one of them at two different sites.
  const REPEAT = ['GHT 4410', 'QRV 882', 'BTX 9921'];
  const addViolation = (e, when, plate, [violation, action], spot, car, note) =>
    db
      .prepare(
        `INSERT INTO vehicle_violations (site_id, post_id, plate, plate_state, vehicle_desc, location_text, violation, action,
           notes, logged_by, occurred_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(e.site_id, e.post_id, plate.replace(/[^A-Z0-9]/g, ''), 'FL', car, spot, violation, action, note, e.user_id, toSql(when), toSql(when));

  let violations = 0;
  for (const e of month) {
    if (rand() > 0.12) continue;
    const when = new Date(e.in.getTime() + (e.out - e.in) * (0.2 + rand() * 0.6));
    const plate = rand() < 0.3 ? pick(REPEAT) : `${String.fromCharCode(65 + Math.floor(rand() * 26))}${String.fromCharCode(65 + Math.floor(rand() * 26))}${String.fromCharCode(65 + Math.floor(rand() * 26))} ${100 + Math.floor(rand() * 900)}`;
    await addViolation(e, when, plate, pick(KINDS), pick(SPOTS), pick(CARS), rand() < 0.3 ? 'Owner not located. Photo on file.' : null);
    violations++;
  }
  // Make sure the first repeat plate really is a repeat at Riverfront, ending in a tow.
  const rf = month.filter((e) => e.site_id === siteId(/Riverfront/));
  for (const [i, e] of rf.slice(-3).entries()) {
    const when = new Date(e.in.getTime() + 2 * 3600000);
    await addViolation(e, when, REPEAT[0], i === 2 ? ['fire_lane', 'towed'] : ['fire_lane', 'tagged'], SPOTS[0], CARS[0],
      i === 2 ? 'Third time this month. Towed by Coastal Towing, ticket 55821.' : null);
    violations++;
  }

  /* ------------------------------------------------------ activity log -- */

  const ACTIVITY = [
    ['patrol', 'Exterior patrol complete. All perimeter doors secure, lot lighting working.'],
    ['patrol', 'Interior rounds, floors 1-3. Stairwells clear, fire doors closed.'],
    ['observation', 'Unfamiliar grey sedan circled the lot twice and left. Plate not visible.'],
    ['access', 'Let the cleaning crew in at the loading dock; badges checked against the list.'],
    ['alarm', 'Door-held alarm, east entrance. Tenant propping it for a delivery; reset and advised.'],
    ['safety', 'Wet floor by the lobby entrance from the rain; cones placed, facilities notified.'],
    ['customer_service', 'Escorted a tenant to her car in the north lot at her request.'],
    ['observation', 'Group of teenagers skateboarding by the fountain; asked to leave, complied.'],
    ['patrol', 'Parking garage patrol, all levels. Nothing to report.'],
    ['access', 'Contractor arrived without an appointment; called the building engineer, who approved.'],
  ];
  const INTERNAL = ['Relief officer 15 minutes late; covered the gap.', 'Radio battery low - swapped for the spare in the key box.'];
  let activity = 0;
  for (const e of entries) {
    const end = e.out || now;
    for (let t = e.in.getTime() + 25 * 60000; t < end.getTime() - 10 * 60000; t += (50 + rand() * 70) * 60000) {
      const internal = rand() < 0.08;
      const [category, body] = internal ? ['other', pick(INTERNAL)] : pick(ACTIVITY);
      await db
        .prepare(
          `INSERT INTO activity_entries (site_id, post_id, user_id, time_entry_id, category, body, client_visible, occurred_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(e.site_id, e.post_id, e.user_id, e.id, category, body, !internal, toSql(new Date(t)), toSql(new Date(t)));
      activity++;
    }
  }

  /* ------------------------------------------------------ building issues -- */

  const ISSUES = [
    ['lighting', 'normal', 'Parking garage level 2, northeast corner', 'Two overhead lights out; that corner is dark after sunset.'],
    ['door_lock', 'urgent', 'East stairwell exit door', 'Door closes but does not latch. The building is not secure until it is fixed.'],
    ['leak', 'urgent', 'Ceiling above the lobby elevators', 'Water dripping from a ceiling tile after the rain; bucket placed.'],
    ['hazard', 'normal', 'Front walkway', 'Raised paving slab by the main entrance - a trip hazard. Coned off.'],
    ['damage', 'low', 'North lot fence', 'Section of fence bent, probably by a vehicle. No gap yet.'],
    ['equipment', 'normal', 'Gatehouse', 'Gate arm sticks halfway about one time in five; has to be lifted by hand.'],
    ['cleanliness', 'low', 'Loading dock', 'Overflowing dumpster; bags on the ground attracting birds.'],
    ['lighting', 'low', 'Rear entrance', 'Motion light over the rear door stays on all night.'],
  ];
  const clientOf = async (site) =>
    (await db.prepare(`SELECT client_user_id AS id FROM client_sites WHERE site_id = ? ORDER BY client_user_id LIMIT 1`).get(site))?.id || null;
  let issues = 0;
  const reporters = entries.filter((e) => e.out);
  for (let i = 0; i < ISSUES.length && reporters.length; i++) {
    const e = reporters[Math.floor(rand() * reporters.length)];
    const [category, priority, where, what] = ISSUES[i];
    const reported = new Date(e.in.getTime() + (e.out - e.in) / 2);
    // Some still open, some seen by the client, some fixed.
    const state = i % 3 === 0 ? 'open' : i % 3 === 1 ? 'acknowledged' : 'fixed';
    const client = await clientOf(e.site_id);
    await db
      .prepare(
        `INSERT INTO site_issues (site_id, post_id, reported_by, category, priority, location_text, description, status,
           client_note, acknowledged_at, fixed_at, closed_by_client, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        e.site_id, e.post_id, e.user_id, category, priority, where, what, state,
        state === 'fixed' ? 'Facilities fixed this - thank you for flagging it.' : state === 'acknowledged' ? 'Work order raised with our contractor.' : null,
        state !== 'open' ? toSql(new Date(reported.getTime() + 3 * 3600000)) : null,
        state === 'fixed' ? toSql(new Date(reported.getTime() + 20 * 3600000)) : null,
        state === 'fixed' ? client : null,
        toSql(reported)
      );
    issues++;
  }
  // And one urgent, open issue at Riverfront from today, so the portal has one to act on.
  const rfNow = entries.find((e) => e.site_id === siteId(/Riverfront/) && !e.out) || entries.find((e) => e.site_id === siteId(/Riverfront/));
  if (rfNow) {
    await db
      .prepare(
        `INSERT INTO site_issues (site_id, post_id, reported_by, category, priority, location_text, description, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(rfNow.site_id, rfNow.post_id, rfNow.user_id, 'door_lock', 'urgent', 'Loading dock roll-up door',
        'Roll-up door will not close the last two feet. Dock is open to the street; officer is standing by it.',
        toSql(new Date(Math.max(rfNow.in.getTime() + 30 * 60000, now.getTime() - 50 * 60000))));
    issues++;
  }

  /* --------------------------------------------------------- lost & found -- */

  const FOUND = [
    ['phone', 'Black iPhone in a clear case, cracked screen', 'Lobby seating area', 'Security desk drawer'],
    ['keys', 'Key ring with a Toyota fob and three brass keys', 'North lot, space 41', 'Key box, hook 12'],
    ['wallet', 'Brown leather wallet, driver licence inside (name on file)', 'Elevator 2', 'Office safe'],
    ['bag', 'Navy backpack with a laptop', 'Cafe', 'Security office'],
    ['clothing', 'Grey hooded sweatshirt, size M', 'Gym', 'Lost property bin'],
    ['id', 'Employee badge, Suite 310', 'Parking garage stairwell', 'Security desk drawer'],
    ['jewelry', 'Silver bracelet', 'Restroom, 2nd floor', 'Office safe'],
  ];
  let found = 0;
  for (let i = 0; i < FOUND.length && reporters.length; i++) {
    const e = reporters[Math.floor(rand() * reporters.length)];
    const [category, description, where, stored] = FOUND[i];
    const at = new Date(e.in.getTime() + (e.out - e.in) * 0.4);
    const returned = i % 3 === 1;
    await db
      .prepare(
        `INSERT INTO lost_found (site_id, post_id, found_by, description, category, found_location, stored_location, found_at,
           status, returned_to, returned_contact, closed_at, closed_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        e.site_id, e.post_id, e.user_id, description, category, where, stored, toSql(at),
        returned ? 'returned' : 'held', returned ? 'Owner - Alex Morgan' : null, returned ? 'FL DL checked, (904) 555-0142' : null,
        returned ? toSql(new Date(at.getTime() + 5 * 3600000)) : null, returned ? e.user_id : null, toSql(at)
      );
    found++;
  }

  /* -------------------------------------------------------- site contacts -- */

  const PEOPLE_BY_ROLE = [
    ['Property manager', ['Laura Kim', 'Dennis Ortiz', 'Monica Hale', 'Greg Summers', 'Tasha Reid']],
    ['Maintenance on call', ['Facilities hotline', 'Ray Delgado', 'Building engineer', 'Mike Patel']],
    ['Alarm monitoring', ['ADT Commercial', 'Vector Security', 'Johnson Controls monitoring']],
    ['Police non-emergency', ['Local police non-emergency']],
  ];
  let contacts = 0;
  const firstClient = async (site) =>
    (await db.prepare(`SELECT client_user_id AS id FROM client_sites WHERE site_id = ? ORDER BY client_user_id LIMIT 1`).get(site))?.id || null;
  for (const [i, site] of sites.entries()) {
    const client = await firstClient(site.id);
    for (const [j, [role, names]] of PEOPLE_BY_ROLE.entries()) {
      const phone = `(${['904', '305', '850', '727', '352', '386'][i % 6]}) 555-${String(1000 + i * 37 + j * 211).slice(-4)}`;
      await db
        .prepare(
          `INSERT INTO site_contacts (site_id, name, role, phone, email, notes, after_hours, sort, added_by_user, added_by_client)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          site.id, names[i % names.length], role, phone,
          j === 0 ? `${names[i % names.length].split(' ')[0].toLowerCase()}@${site.name.split(' ')[0].toLowerCase()}.example.com` : null,
          j === 1 ? 'Call first for anything leaking, broken or stuck.' : j === 2 ? 'Give the site number and the zone.' : null,
          j !== 0, j, j === 0 && client ? null : sup.id, j === 0 && client ? client : null
        );
      contacts++;
    }
  }

  /* ------------------------------------------------------ client feedback -- */

  const pairs = await db.prepare(`SELECT client_user_id, site_id FROM client_sites ORDER BY client_user_id, site_id`).all();
  const COMMENTS = {
    5: ['Officers are professional and always on time.', 'Very happy - the daily reports are exactly what we need.', null],
    4: ['Good month overall. One late shift but it was covered quickly.', 'Solid service.', null],
    3: ['Patrol reports were late a couple of mornings.', 'Fine, but we would like more visible patrols in the garage.'],
    2: ['Officer was on his phone at the desk twice this week. Not the standard we pay for.'],
  };
  let feedback = 0;
  for (const [k, pair] of pairs.entries()) {
    for (let m = 5; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (m === 0 && k % 2 === 0) continue; // half the clients have not rated this month yet
      // Mostly good, one poor month for one client, and the latest poor one unanswered.
      const rating = k === 1 && m === 1 ? 2 : k === 2 && m <= 1 ? 3 : rand() < 0.6 ? 5 : 4;
      const comment = pick(COMMENTS[rating]);
      const replied = rating <= 3 && m > 1;
      await db
        .prepare(
          `INSERT INTO client_feedback (client_user_id, site_id, period, rating, comment, response, responded_by, responded_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          pair.client_user_id, pair.site_id, period, rating, comment,
          replied ? 'Thank you - we have spoken to the team and added a supervisor check.' : null,
          replied ? sup.id : null, replied ? toSql(new Date(d.getTime() + 20 * 86400000)) : null,
          toSql(new Date(d.getTime() + 15 * 86400000)), toSql(new Date(d.getTime() + 15 * 86400000))
        );
      feedback++;
    }
  }

  /* ---------------------------------------------------------- post orders -- */

  const posts = await db.prepare(`SELECT id, site_id, name, instructions FROM posts WHERE instructions IS NOT NULL ORDER BY id`).all();
  let orders = 0;
  for (const p of posts) {
    const issued = new Date(now.getTime() - 60 * 86400000);
    const info = await db
      .prepare(`INSERT INTO post_orders (post_id, version, body, change_note, created_by, created_at) VALUES (?,?,?,?,?,?)`)
      .run(p.id, 1, p.instructions, 'Orders issued', sup.id, toSql(issued));
    orders++;
    // Everyone who has worked the post in the last month read version 1 on their first shift.
    const crew = await db
      .prepare(`SELECT user_id, MIN(clock_in_at) AS first FROM time_entries WHERE post_id = ? AND clock_in_at >= ? GROUP BY user_id`)
      .all(p.id, toSql(new Date(now.getTime() - 30 * 86400000)));
    for (const c of crew) {
      await db
        .prepare(`INSERT INTO post_order_acks (post_order_id, user_id, acked_at) VALUES (?,?,?) ON CONFLICT DO NOTHING`)
        .run(Number(info.lastInsertRowid), c.user_id, toSql(new Date(new Date(c.first).getTime() + 15 * 60000)));
    }
  }
  // The Riverfront lobby's orders changed two days ago; the officer on post has not read them yet.
  const lobby = posts.find((p) => p.site_id === siteId(/Riverfront/));
  if (lobby) {
    const revised = `${lobby.instructions}\n\nFrom this week: the loading dock roll-up door is out of order. Check it on every round and log it in the activity log. Deliveries after 6 PM go to the east entrance only - call the tenant before letting a courier up.`;
    await db
      .prepare(`INSERT INTO post_orders (post_id, version, body, change_note, created_by, created_at) VALUES (?,?,?,?,?,?)`)
      .run(lobby.id, 2, revised, 'Loading dock door out of order; after-hours deliveries to the east entrance.', sup.id,
        toSql(new Date(now.getTime() - 2 * 86400000)));
    await db.prepare(`UPDATE posts SET instructions = ? WHERE id = ?`).run(revised, lobby.id);
    orders++;
  }

  return { visitors, notes, watchlist: 7, violations, activity, issues, found, contacts, feedback, orders };
}
