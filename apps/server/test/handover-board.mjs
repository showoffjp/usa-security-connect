/**
 * The handover board's rules, against a real database but no server, at a
 * moment the test picks.
 *
 * For each officer on duty whose shift ends within the window, or has ended
 * and who is still there, the board finds the shift that follows at the same
 * post and says where that relief stands.
 *
 * USC_PGLITE_MEMORY gives this its own throwaway database, like holdover.mjs.
 */

process.env.USC_PGLITE_MEMORY = '1';

const { db, migrate } = await import('../src/lib/db.js');
const { toSql } = await import('../src/services/compliance.js');
const { confirmKey } = await import('../src/services/confirmations.js');
const { handovers, myHandovers } = await import('../src/services/handovers.js');

let failed = 0;
const log = (ok, label, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

await migrate();

const MIN = 60000;
// On the minute, so times read back from the database compare exactly.
const now = new Date(Math.floor(Date.now() / MIN) * MIN);
const at = (minutes) => new Date(now.getTime() + minutes * MIN);
const id = async (sql, ...args) => Number((await db.prepare(sql).run(...args)).lastInsertRowid);

const siteId = await id(`INSERT INTO sites (name) VALUES ('Handover Test Site')`);
let code = 9200;
const officer = (name) =>
  id(`INSERT INTO users (employee_code, first_name, last_name, role, phone) VALUES (?, ?, 'Officer', 'officer', '555-0100')`, String(code++), name);
const post = (name) => id(`INSERT INTO posts (site_id, name, requires_gps) VALUES (?, ?, false)`, siteId, name);
const shift = (userId, postId, startMin, endMin) =>
  id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at, is_open) VALUES (?,?,?,?,?)`, userId, postId, toSql(at(startMin)), toSql(at(endMin)), !userId);
const clockIn = (userId, postId, shiftId, atMin) =>
  id(`INSERT INTO time_entries (user_id, post_id, shift_id, clock_in_at) VALUES (?,?,?,?)`, userId, postId, shiftId, toSql(at(atMin)));
const confirm = async (shiftId, { stale = false } = {}) => {
  const row = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId);
  const key = stale ? confirmKey({ ...row, ends_at: toSql(at(999)) }) : confirmKey(row);
  await db.prepare(`UPDATE shifts SET confirmed_at = ?, confirmed_key = ? WHERE id = ?`).run(toSql(at(-600)), key, shiftId);
};

/**
 * An officer on duty at a post of their own, their shift ending `endMin` from
 * now, and (unless `relief` is false) a relief due at the end.
 */
async function handover(name, endMin, relief = {}) {
  const postId = await post(name);
  const out = await officer(`Out-${name}`);
  const outShift = await shift(out, postId, endMin - 480, endMin);
  await clockIn(out, postId, outShift, endMin - 482);
  let rel = null;
  let relShift = null;
  if (relief) {
    rel = relief.same ? out : relief.open ? null : await officer(`Relief-${name}`);
    relShift = await shift(rel, postId, endMin + (relief.offset || 0), endMin + 480);
    if (relief.confirmed) await confirm(relShift, { stale: relief.stale });
    if (relief.on) await clockIn(rel, postId, relShift, relief.on);
  }
  return { name, postId, out, outShift, rel, relShift };
}

const late = await handover('late', -20, { confirmed: true });
const relieved = await handover('relieved', -5, { confirmed: true, on: -8 });
const open = await handover('open', 40, { open: true });
const soon = await handover('soon', 30);
const later = await handover('later', 100);
const stale = await handover('stale', 80, { confirmed: true, stale: true });
const confirmed = await handover('confirmed', 70, { confirmed: true, offset: 15 });
const closes = await handover('closes', 10, false);
const straightOn = await handover('straight-on', 15, { same: true });
const far = await handover('far', 200, { confirmed: true });

const board = await handovers({ now });
const of = (h) => board.handovers.find((x) => x.shift_id === h.outShift);

log(of(late)?.state === 'late' && of(late).severity === 'critical', 'a relief past their start (and its grace) who has not clocked in is late');
log(of(late)?.held_over_minutes === 20 && of(late).relief.minutes_late === 20, 'with how long the officer has been held over, and how late the relief is',
  `${of(late)?.held_over_minutes} / ${of(late)?.relief?.minutes_late}`);
log(of(relieved)?.state === 'relieved' && of(relieved).severity === 'ok', 'a relief on post means the officer can hand over and go');
log(of(open)?.state === 'open' && of(open).severity === 'critical' && of(open).relief.user_id === null,
  'a following shift nobody is on, inside the hour, is critical');
log(of(soon)?.state === 'unconfirmed' && of(soon).severity === 'warning', 'a relief who has not confirmed, half an hour out, is a warning');
log(of(later)?.state === 'unconfirmed' && of(later).severity === 'info', 'and over an hour out, worth knowing');
log(of(stale)?.state === 'unconfirmed', 'a confirmation for different times does not count once the shift has moved');
log(of(confirmed)?.state === 'confirmed' && of(confirmed).relief.confirmed === true, 'a relief starting a little after the handover is still the relief');
log(of(closes)?.state === 'closes' && of(closes).relief === null, 'with no shift after it, the post closes');
log(!of(straightOn), 'an officer working straight on into their own next shift is not a handover');
log(!of(far), 'a shift ending after the window is not on the board yet');
log(board.handovers[0]?.state === 'late', 'the worst come first');
log(board.counts.at_risk === 3 && board.counts.held_over === 1 && board.counts.total === 8,
  'counted: three at risk, one officer held over', JSON.stringify(board.counts));
log((await handovers({ now, windowMinutes: 240 })).handovers.some((h) => h.shift_id === far.outShift), 'a wider window reaches further');

const mineOut = await myHandovers(late.out, now);
log(mineOut.outgoing?.state === 'late' && mineOut.incoming === null, 'the held-over officer sees that their relief is late');
log(mineOut.outgoing && !mineOut.outgoing.phone && !mineOut.outgoing.relief.phone,
  "and nobody's phone number");
const mineIn = await myHandovers(late.rel, now);
log(mineIn.incoming?.shift_id === late.outShift && mineIn.outgoing === null, 'the late relief sees whose post they are taking over');
const mineOn = await myHandovers(relieved.rel, now);
log(mineOn.incoming === null, 'and once on post, it drops off their list');

console.log(`\nHandover board: ${failed ? `${failed} CHECK(S) FAILED.` : 'all checks passed.'}`);
process.exit(failed ? 1 : 0);
