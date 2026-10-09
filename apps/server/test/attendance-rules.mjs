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
const { stagesFor, sweepAttendance, attendanceBoard, headsUpFor, reportRunningLate, callOff, attendanceRecord, attendancePoints } = await import('../src/services/attendance.js');
const { attendancePointsFor, ATTENDANCE_POINTS } = await import('../src/shared.js');
const { officerScore } = await import('../src/services/scorecards.js');
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

/* ================================================ the officer says so first === */
console.log('\n--- running late, and calling off ---');
const refused = async (fn) => { try { await fn(); return null; } catch (err) { return err.status; } };
const rita = await person('9406', 'Rita', 'officer');
const ritaShift = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at) VALUES (?,?,?,?)`, rita, post,
  toSql(new Date(now.getTime() + 20 * MIN)), toSql(new Date(now.getTime() + 8 * 60 * MIN)));
const offered = await headsUpFor(rita, now);
log(offered.shift?.id === ritaShift && !offered.shift.started && offered.shift.minutes_to_start === 20, 'the next shift, twenty minutes away, is the one Rita can say something about');
log(await refused(() => reportRunningLate({ userId: rita, shiftId: ritaShift, etaMinutes: 10, now })) === 422, 'arriving before the start is not late');
log(await refused(() => reportRunningLate({ userId: officer, shiftId: ritaShift, etaMinutes: 40, now })) === 409, "nobody can say it for someone else's shift");
let sent = (await texts()).length;
const said = await reportRunningLate({ userId: rita, shiftId: ritaShift, etaMinutes: 35, note: 'Flat tyre', now });
t = (await texts()).slice(sent);
log(said.notice.minutes_late === 15 && t.length === 1 && t[0].to_user_id === admin && /^USC heads-up: Rita Tester is running late .* expects to arrive by .*"Flat tyre"/.test(t[0].body),
  'running fifteen minutes late: the one who asked for late starts is told now', t[0]?.body);
log(await refused(() => reportRunningLate({ userId: rita, shiftId: ritaShift, etaMinutes: 50, now })) === 409, 'once per shift; after that, they call');
const start = new Date(now.getTime() + 20 * MIN);
const at = (m) => new Date(start.getTime() + m * MIN);
log((await attendanceBoard({ now })).open.find((o) => o.shift_id === ritaShift)?.state === 'running_late', 'the board shows it before the shift starts');
sent = (await texts()).length;
await sweepAttendance(at(8));
log((await texts()).length === sent, 'eight minutes in, late but within the time given: no late text');
const lateRow = (await attendanceBoard({ now: at(8) })).open.find((o) => o.shift_id === ritaShift);
log(lateRow?.state === 'late' && lateRow.notice?.note === 'Flat tyre', 'the board has Rita late, with what was said');
await sweepAttendance(at(31));
t = (await texts()).slice(sent);
log(t.length === 1 && /^USC NO-SHOW: Rita Tester .* They said they would be there by /.test(t[0].body), 'still not there at thirty minutes: the no-show text repeats the time given', t[0]?.body);

const nick = await person('9407', 'Nick', 'officer');
const nickStart = new Date(now.getTime() + 3 * 60 * MIN);
const nickShift = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at) VALUES (?,?,?,?)`, nick, post,
  toSql(nickStart), toSql(new Date(nickStart.getTime() + 6 * 60 * MIN)));
log(await refused(() => callOff({ userId: nick, shiftId: nickShift, reason: 'bored', now })) === 422, 'a call-off needs one of the reasons');
log(await refused(() => callOff({ userId: nick, shiftId: nickShift, reason: 'other', note: 'eh', now })) === 422, "and 'something else' needs a few words");
sent = (await texts()).length;
await callOff({ userId: nick, shiftId: nickShift, reason: 'sick', note: 'Fever', now });
const opened = await db.prepare(`SELECT user_id, is_open FROM shifts WHERE id = ?`).get(nickShift);
t = (await texts()).slice(sent);
log(opened.user_id === null && opened.is_open, 'calling off sick takes the shift off Nick and opens it');
log(t.length === 1 && /^USC CALL-OFF: Nick Tester can't work the .* \(sick\)\. It is open: find cover\./.test(t[0].body), 'everyone who hears of no-shows is texted at once', t[0]?.body);
log(!/Call \(/.test(t[0]?.body || ''), "without the officer's number: they have said they can't come");
log((await attendanceBoard({ now })).open.find((o) => o.shift_id === nickShift)?.state === 'called_off', 'the board has it as called off, needing cover');
log((await headsUpFor(nick, now)).shift?.id !== nickShift, 'and it is no longer Nick\'s to say anything about');
log(await refused(() => callOff({ userId: nick, shiftId: nickShift, reason: 'sick', now })) === 409, 'nor can it be called off twice');
await db.prepare(`UPDATE shifts SET user_id = ?, is_open = false WHERE id = ?`).run(cover, nickShift);
sent = (await texts()).length;
await sweepAttendance(new Date(now.getTime() + MIN));
t = (await texts()).slice(sent);
log(t.length === 1 && /is covered\. Casey Tester is taking Nick Tester's/.test(t[0].body), 'given to someone before it starts: covered, and those told are told so', t[0]?.body);
log((await attendanceBoard({ now: new Date(nickStart.getTime() + 20 * MIN) })).open.find((o) => o.shift_id === nickShift)?.state === 'covering',
  'twenty minutes in without the cover clocked in, it is cover on the way, not late');

/* ================================================== the attendance record === */
console.log('\n--- the attendance record ---');
const soon = new Date(now.getTime() + MIN);
const nickRec = await attendanceRecord(nick, { now: soon });
const nickOff = nickRec.items.find((i) => i.shift_id === nickShift);
log(nickRec.summary.calledOff === 1 && nickRec.summary.due === 1 && nickRec.summary.worked === 0,
  "Nick's record has the call-off, though the shift is no longer Nick's", JSON.stringify(nickRec.summary));
log(nickOff?.kind === 'called_off' && nickOff.reason_label === 'Sick' && nickOff.note === 'Fever' && nickOff.notice_hours === 3,
  'with the reason, the note, and three hours of notice', JSON.stringify(nickOff));
log(nickOff?.short_notice === true && nickRec.summary.shortNotice === 1, 'under four hours before the start is short notice');
log(nickOff?.covered_by === 'Casey Tester', 'and who covered it');
log((await attendanceRecord(cover, { now: soon })).summary.calledOff === 0, 'covering it does not count against Casey');
const lee = await person('9409', 'Lee', 'officer');
const leeStart = new Date(now.getTime() + 239 * MIN);
const leeShift = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at) VALUES (?,?,?,?)`, lee, post,
  toSql(leeStart), toSql(new Date(leeStart.getTime() + 6 * 60 * MIN)));
await callOff({ userId: lee, shiftId: leeShift, reason: 'transport', now });
const leeOff = (await attendanceRecord(lee, { now: soon })).items[0];
log(leeOff?.notice_hours === 3.9 && leeOff.short_notice, 'a minute under four hours reads 3.9 hours and is short notice, never "4 h" and short', JSON.stringify(leeOff?.notice_hours));

const ritaRec = await attendanceRecord(rita, { now: at(31) });
const ritaMiss = ritaRec.items.find((i) => i.shift_id === ritaShift);
log(ritaRec.summary.noShows === 1 && ritaMiss?.kind === 'no_show' && ritaMiss.notice?.note === 'Flat tyre',
  'Rita never came: a no-show, with the time Rita gave', JSON.stringify(ritaMiss));
log(ritaRec.summary.headsUps === 1 && ritaRec.summary.keptWord === 0, 'warned them once, and did not make it by then');

const kim = await person('9408', 'Kim', 'officer');
const kimStart = new Date(now.getTime() + 10 * MIN);
const kimShift = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at) VALUES (?,?,?,?)`, kim, post,
  toSql(kimStart), toSql(new Date(kimStart.getTime() + 6 * 60 * MIN)));
await reportRunningLate({ userId: kim, shiftId: kimShift, etaMinutes: 25, note: 'Bridge is up', now });
const kimIn = new Date(kimStart.getTime() + 12 * MIN);
await db.prepare(`INSERT INTO time_entries (user_id, shift_id, post_id, clock_in_at, clock_in_geofence, method) VALUES (?,?,?,?, 'inside', 'gps')`)
  .run(kim, kimShift, post, toSql(kimIn));
const kimRec = await attendanceRecord(kim, { now: new Date(kimIn.getTime() + MIN) });
const kimLate = kimRec.items.find((i) => i.shift_id === kimShift);
log(kimRec.summary.worked === 1 && kimRec.summary.onTime === 0 && kimRec.summary.late === 1 && kimLate?.minutes_late === 12,
  'Kim clocked in twelve minutes after the start: worked, and late', JSON.stringify(kimRec.summary));
log(kimLate?.kept_word === true && kimRec.summary.keptWord === 1, 'but within the fifteen minutes Kim gave: as good as their word');
log((await attendanceRecord(kim, { days: 7, now: new Date(kimIn.getTime() + 9 * 86400000) })).summary.due === 0, 'and a week later it is outside a seven-day record');

/* ===================================================== attendance points === */
console.log('\n--- attendance points ---');
log(attendancePointsFor({ kind: 'no_show' }) === 3 && attendancePointsFor({ kind: 'called_off', short_notice: true }) === 2
  && attendancePointsFor({ kind: 'called_off', short_notice: false }) === 1 && attendancePointsFor({ kind: 'late' }) === 1,
  'a no-show is 3, a call-off 1 (2 at short notice), a late start 1');
log(attendancePointsFor({ kind: 'late', kept_word: true }) === 0, 'and a late start warned of, arriving by the time given, nothing');
log(ATTENDANCE_POINTS.windowDays === 30 && ATTENDANCE_POINTS.threshold === 4, 'counted over 30 days; 4 is the limit');
log((await attendancePoints({ now: soon, userId: nick })).get(nick)?.points === 2, "Nick's short-notice call-off: 2 points");
log(!(await attendancePoints({ now: new Date(kimIn.getTime() + MIN), userId: kim })).get(kim)?.points, 'Kim, late but as good as their word: none');

// Rita never came (3), and was 20 minutes late two days before (1): 4, the limit.
const ritaEarlier = new Date(now.getTime() - 2 * 86400000);
const ritaOld = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status) VALUES (?,?,?,?, 'completed')`, rita, post,
  toSql(ritaEarlier), toSql(new Date(ritaEarlier.getTime() + 6 * 60 * MIN)));
await db.prepare(`INSERT INTO time_entries (user_id, shift_id, post_id, clock_in_at, clock_in_geofence, method) VALUES (?,?,?,?, 'inside', 'gps')`)
  .run(rita, ritaOld, post, toSql(new Date(ritaEarlier.getTime() + 20 * MIN)));
const later2 = new Date(at(31).getTime() + MIN);
let rp = (await attendancePoints({ now: later2, userId: rita })).get(rita);
log(rp?.points === 4 && rp.over && rp.needs_review && rp.items.length === 2, 'Rita: a no-show and a late start make 4, the limit: flagged', JSON.stringify(rp && { points: rp.points, items: rp.items.map((i) => i.kind) }));
const review = await db
  .prepare(`INSERT INTO conduct_records (user_id, category, level, occurred_on, summary, expectations, issued_by, created_at) VALUES (?, 'attendance', 'coaching', ?, ?, ?, ?, ?) RETURNING id`)
  .get(rita, toSql(later2).slice(0, 10), 'Missed a shift and was late earlier in the week.', 'Call ahead, every time.', supervisor, toSql(later2));
rp = (await attendancePoints({ now: new Date(later2.getTime() + MIN), userId: rita })).get(rita);
log(rp.over && !rp.needs_review && rp.reviewed?.id === review.id && rp.reviewed.level_label === 'Coaching', 'a coaching on attendance after it clears the flag, and is shown', JSON.stringify(rp.reviewed));
await db.prepare(`INSERT INTO conduct_records (user_id, category, level, occurred_on, summary, expectations, issued_by, created_at) VALUES (?, 'uniform', 'coaching', ?, ?, ?, ?, ?)`)
  .run(nick, toSql(later2).slice(0, 10), 'Uniform not to standard on the night shift.', 'Full uniform on post.', supervisor, toSql(later2));
log(!(await attendancePoints({ now: new Date(later2.getTime() + MIN), userId: nick })).get(nick)?.reviewed, 'a coaching about something else does not');
// A third lapse after the coaching: flagged again.
const ritaNext = new Date(later2.getTime() + 2 * 3600000);
const ritaNew = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status) VALUES (?,?,?,?, 'completed')`, rita, post,
  toSql(ritaNext), toSql(new Date(ritaNext.getTime() + 4 * 60 * MIN)));
await db.prepare(`INSERT INTO time_entries (user_id, shift_id, post_id, clock_in_at, clock_in_geofence, method) VALUES (?,?,?,?, 'inside', 'gps')`)
  .run(rita, ritaNew, post, toSql(new Date(ritaNext.getTime() + 15 * MIN)));
rp = (await attendancePoints({ now: new Date(ritaNext.getTime() + 20 * MIN), userId: rita })).get(rita);
log(rp.points === 5 && rp.needs_review && !rp.reviewed, 'late again after it: 5 points, and flagged again', `${rp.points}`);
rp = (await attendancePoints({ now: new Date(ritaEarlier.getTime() + 31 * 86400000), userId: rita })).get(rita);
log(rp && !rp.items.some((i) => i.shift_id === ritaOld), 'and a month on, the old late start no longer counts');
const ritaMonth = await attendanceRecord(rita, { days: 30, now: new Date(ritaNext.getTime() + 20 * MIN) });
log(ritaMonth.standing.points === 5 && ritaMonth.items.every((i) => typeof i.points === 'number'), 'the record carries the points, and each lapse its own');

/* ============================================================== the score === */
console.log('\n--- the score ---');
log(officerScore({}) === null, 'nothing worked or due: no score, rather than zero');
log(officerScore({ worked: 10, onTime: 10 }) === 100, 'every shift worked on time, nothing else to judge: 100');
log(officerScore({ worked: 9, onTime: 9, calledOff: 2 }) === officerScore({ worked: 9, onTime: 9, missed: 1 }), 'two call-offs cost the same as one no-show');
log(officerScore({ worked: 9, onTime: 9, calledOff: 1 }) > officerScore({ worked: 9, onTime: 9, missed: 1 }), 'so calling off costs less than not turning up');
log(officerScore({ worked: 0, calledOff: 3 }) === 0, 'calling off every shift due scores nothing');
log(officerScore({ worked: 10, onTime: 5, checksOk: 4, checksLate: 0, checksMissed: 0 }) === Math.round((35 * 0.5 + 25 + 25 + 15) / 100 * 100),
  'half on time loses half the punctuality part');

console.log(`\nLate and no-show rules: ${failed ? `${failed} CHECK(S) FAILED.` : 'all checks passed.'}`);
process.exit(failed ? 1 : 0);
