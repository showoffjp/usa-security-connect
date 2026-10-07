/**
 * Late and no-show rules against a throwaway database (no server): the
 * stages a shift reaches, what is sent and to whom, and phone numbers.
 *
 * USC_PGLITE_MEMORY gives this its own database, like fatigue-rules.mjs.
 */

process.env.USC_PGLITE_MEMORY = '1';
process.env.USC_PUSH_DISABLED = '1';

const { db, migrate } = await import('../src/lib/db.js');
const { toSql } = await import('../src/services/compliance.js');
const { stagesFor, sweepAttendance, attendanceBoard } = await import('../src/services/attendance.js');
const { normalizePhone, displayPhone, maskPhone } = await import('../src/services/sms.js');

let failed = 0;
const log = (ok, label, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const MIN = 60000;

/* ======================================================== phone numbers === */
console.log('--- phone numbers ---');
log(normalizePhone('(904) 555-0100') === '+19045550100', 'ten digits are a US number');
log(normalizePhone('1-904-555-0100') === '+19045550100', 'with or without the leading 1');
log(normalizePhone('+44 20 7946 0958') === '+442079460958', 'anything else needs its country code');
log(normalizePhone('555-0100') === null && normalizePhone('0904 555 0100') === null && normalizePhone('') === null, 'and a short or local number is refused');
log(displayPhone('+19045550100') === '(904) 555-0100' && maskPhone('+19045550100') === '•••• 0100', 'shown in full to its owner, masked to everyone else');

/* =========================================================== the stages === */
console.log('\n--- the stages ---');
const now = new Date(Math.floor(Date.now() / MIN) * MIN);
const ago = (m) => new Date(now.getTime() - m * MIN);
const st = (startedMinutesAgo, inMinutesAfter = null) =>
  stagesFor({ starts_at: ago(startedMinutesAgo), clock_in_at: inMinutesAfter == null ? null : new Date(ago(startedMinutesAgo).getTime() + inMinutesAfter * MIN) }, now)
    .map((s) => s.stage).join(',');
log(st(5) === '', 'five minutes in, nothing yet');
log(st(7) === '', 'at exactly seven minutes, still within the grace');
log(st(8) === 'late', 'after seven, late');
log(st(31) === 'late,no_show', 'after thirty, a no-show');
log(st(60, 5) === '', 'clocked in five minutes after the start: on time');
log(st(60, 12) === 'late,arrived', 'twelve minutes after: late, then arrived');
log(st(60, 45) === 'late,no_show,arrived', 'forty-five minutes after: a no-show who turned up');
const arrived = stagesFor({ starts_at: ago(60), clock_in_at: ago(15) }, now).find((s) => s.stage === 'arrived');
log(arrived.minutes === 45, 'and how late they were', `${arrived.minutes} min`);

/* ======================================================= sending, to whom === */
console.log('\n--- what is sent, and to whom ---');
await migrate();
const id = async (sql, ...args) => Number((await db.prepare(sql).run(...args)).lastInsertRowid);
const site = await id(`INSERT INTO sites (name) VALUES ('Rules Test Site')`);
const post = await id(`INSERT INTO posts (site_id, name, requires_gps) VALUES (?, 'Rules Gate', false)`, site);
const person = (code, first, role) =>
  id(`INSERT INTO users (employee_code, first_name, last_name, role, phone) VALUES (?,?, 'Tester', ?, '(904) 555-0199')`, code, first, role);
const admin = await person('9401', 'Avery', 'admin');
const supervisor = await person('9402', 'Sam', 'supervisor');
const quiet = await person('9403', 'Quinn', 'supervisor');
const officer = await person('9404', 'Olly', 'officer');
const cover = await person('9405', 'Casey', 'officer');
// The administrator wants everything by text; Sam has saved nothing; Quinn
// has turned everything off.
await db.prepare(`INSERT INTO alert_subscriptions (user_id, sms_enabled, on_late, on_no_show, on_update, sms_phone, sms_verified_at)
                  VALUES (?, true, true, true, true, '+19045550101', now())`).run(admin);
await db.prepare(`INSERT INTO alert_subscriptions (user_id, sms_enabled, push_enabled, on_late, on_no_show, on_update)
                  VALUES (?, false, false, false, false, false)`).run(quiet);
const texts = async () => (await db.prepare(`SELECT to_user_id, body, status FROM sms_messages ORDER BY id`).all());

const shift = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at) VALUES (?,?,?,?)`, officer, post, toSql(ago(10)), toSql(new Date(now.getTime() + 6 * 60 * MIN)));
let r = await sweepAttendance(now);
let t = await texts();
log(r.recorded === 1 && t.length === 1 && t[0].to_user_id === admin && /^USC late: Olly Tester/.test(t[0].body), 'ten minutes late: a text to the one who asked for late starts', t[0]?.body);
log(t[0].status === 'skipped', 'skipped, with no provider configured');
log(/Call \(904\) 555-0199/.test(t[0].body), "with the officer's number to call");
r = await sweepAttendance(now);
log(r.recorded === 0 && (await texts()).length === 1, 'the next sweep sends nothing more');

const later = new Date(now.getTime() + 25 * MIN);
r = await sweepAttendance(later);
t = await texts();
log(r.recorded === 1 && t.length === 2 && /^USC NO-SHOW: /.test(t[1].body), 'thirty-five minutes: a no-show text');

await db.prepare(`UPDATE shifts SET user_id = ? WHERE id = ?`).run(cover, shift);
r = await sweepAttendance(new Date(later.getTime() + MIN));
t = await texts();
log(t.length === 3 && /is covered\. Casey Tester is taking Olly Tester's/.test(t[2].body), 'given to someone else: covered', t[2]?.body);
const coverEvents = await db.prepare(`SELECT stage FROM attendance_events WHERE user_id = ?`).all(cover);
log(coverEvents.length === 0, 'and the cover is not counted late from the original start');
const board = await attendanceBoard({ now: new Date(later.getTime() + MIN) });
log(board.open.find((o) => o.shift_id === shift)?.state === 'covering', 'the board shows cover on the way');
await db.prepare(`INSERT INTO time_entries (user_id, post_id, shift_id, clock_in_at) VALUES (?,?,?,?)`).run(cover, post, shift, toSql(new Date(later.getTime() + 2 * MIN)));
const done = await attendanceBoard({ now: new Date(later.getTime() + 3 * MIN) });
log(done.resolved.find((o) => o.shift_id === shift)?.state === 'covered' && done.open.every((o) => o.shift_id !== shift), 'and covered once they clock in');

// Missed by a sweep that has not run for an hour: one text, the latest stage.
const stale = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at) VALUES (?,?,?,?)`, officer, post, toSql(ago(40)), toSql(new Date(now.getTime() + 60 * MIN)));
const before = (await texts()).length;
r = await sweepAttendance(now);
t = (await texts()).slice(before);
log(r.recorded === 2 && t.length === 1 && /^USC NO-SHOW/.test(t[0].body), 'a sweep that missed the late start sends only the no-show');
await db.prepare(`INSERT INTO time_entries (user_id, post_id, shift_id, clock_in_at) VALUES (?,?,?,?)`).run(officer, post, stale, toSql(new Date(now.getTime() + MIN)));
r = await sweepAttendance(new Date(now.getTime() + 2 * MIN));
t = (await texts()).slice(before);
log(t.length === 2 && /clocked in at Rules Gate, Rules Test Site at .*, 41 min late/.test(t[1].body), 'then that they arrived, and how late', t[1]?.body);

// Old news is recorded, not sent.
const old = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at) VALUES (?,?,?,?)`, cover, post, toSql(ago(5 * 60)), toSql(ago(60)));
const n = (await texts()).length;
r = await sweepAttendance(now);
log(r.recorded === 2 && (await texts()).length === n, 'a no-show from hours ago, seen for the first time, is recorded but not sent');
const oldEvents = await db.prepare(`SELECT stage FROM attendance_events WHERE shift_id = ? ORDER BY occurred_at`).all(old);
log(oldEvents.map((e) => e.stage).join(',') === 'late,no_show', 'with both its stages');

// Sam saved nothing, so by default heard only of no-shows (by push, no text);
// Quinn turned everything off. Neither got a text.
const people = new Set((await texts()).map((x) => x.to_user_id));
log(!people.has(supervisor) && !people.has(quiet), 'nobody without a confirmed number and texts on is texted');

console.log(`\nLate and no-show rules: ${failed ? `${failed} CHECK(S) FAILED.` : 'all checks passed.'}`);
process.exit(failed ? 1 : 0);
