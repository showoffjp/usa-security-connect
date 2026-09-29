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

  return { visitors, notes };
}
