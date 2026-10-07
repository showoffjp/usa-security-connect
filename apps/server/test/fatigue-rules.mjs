/**
 * Rest and fatigue rules: the shared rule on its own, then against a real
 * database (no server) for shifts as worked - a held-over officer's shift
 * ends when they clock out, or now if they are still on.
 *
 * USC_PGLITE_MEMORY gives this its own throwaway database, like holdover.mjs.
 */

process.env.USC_PGLITE_MEMORY = '1';

const { fatigueIssues, RULES } = await import('../../../packages/shared/src/domain.js');
const { db, migrate } = await import('../src/lib/db.js');
const { toSql } = await import('../src/services/compliance.js');
const { fatigueFor, fatigueBoard, shiftsAsWorked } = await import('../src/services/fatigue.js');

let failed = 0;
const log = (ok, label, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const codes = (issues) => issues.map((i) => i.code).sort().join(',');

/* ===================================================== the rule itself === */
console.log('--- the rule ---');
const H = 3600000;
// A Wednesday at 06:00, local: days in a row are counted in local days.
const base = new Date();
base.setDate(base.getDate() - ((base.getDay() + 4) % 7));
base.setHours(6, 0, 0, 0);
const at = (h) => new Date(base.getTime() + h * H);
const shift = (from, to) => ({ starts_at: at(from), ends_at: at(to) });
const check = (from, to, others, opts = {}) => fatigueIssues({ startsAt: at(from), endsAt: at(to), others, ...opts });

log(codes(check(0, 8, [shift(-14, -6)])) === 'short_rest', 'six hours off between shifts is short of rest');
log(check(0, 8, [shift(-14, -8)]).length === 0, `exactly ${RULES.minRestHours} hours off is enough`);
log(codes(check(0, 8, [shift(14, 22)])) === 'short_rest' && /next shift/.test(check(0, 8, [shift(14, 22)])[0].message),
  'and the rest after counts too, when proposing a shift');
log(codes(check(0, 8, [shift(-8, 0)])) === '', 'working straight on is no short rest (16 hours is the most, not over it)');
log(codes(check(0, 8, [shift(-10, 0)])) === 'long_day', 'but 18 hours in 24 is a long day', check(0, 8, [shift(-10, 0)])[0]?.message);
log(codes(check(0, 8, [shift(-12, -4)])) === 'short_rest', '4 hours off between two 8-hour shifts is short of rest, and 16 hours in 24 is at the limit, not over it');
log(codes(check(0, 8, [shift(-14, -4)])) === 'long_day,short_rest', 'a 10-hour shift, 4 hours off, then 8 more is both');
const week = [1, 2, 3, 4, 5, 6].map((d) => shift(-24 * d, -24 * d + 8));
log(codes(check(0, 8, week)) === 'too_many_days', 'a seventh day in a row is too many', check(0, 8, week)[0]?.message);
log(check(0, 8, week.slice(1)).length === 0, 'six is not');
const around = [-3, -2, -1, 1, 2, 3].map((d) => shift(24 * d, 24 * d + 8));
log(codes(check(0, 8, around)) === 'too_many_days', 'filling the one day off in a fortnight makes seven in a row');
log(codes(check(0, 8, around, { lookBack: true })) === '', 'which, looking back from this shift alone, it is not yet: the board lists it on the day that tips it');
log(check(0, 8, [shift(14, 22)], { lookBack: true }).length === 0, 'and lists a short gap on the later shift only');
log(check(0, 8, [shift(2, 6)]).length === 0, 'an overlapping shift is a conflict, not a fatigue problem');
const r = check(0, 8, [shift(-14, -6)])[0];
log(r.advisory && r.supervisorOnly && r.officerMessage && r.note, 'a supervisor is warned, an officer cannot take it on themselves, and each is told why');

/* ============================================== shifts as worked =========== */
console.log('\n--- shifts as worked ---');
await migrate();
const MIN = 60000;
const now = new Date(Math.floor(Date.now() / MIN) * MIN);
const ago = (h) => new Date(now.getTime() - h * H);
const id = async (sql, ...args) => Number((await db.prepare(sql).run(...args)).lastInsertRowid);
const siteId = await id(`INSERT INTO sites (name) VALUES ('Fatigue Test Site')`);
const postId = await id(`INSERT INTO posts (site_id, name, requires_gps) VALUES (?, 'Fatigue Post', false)`, siteId);
const officer = await id(`INSERT INTO users (employee_code, first_name, last_name, role) VALUES ('9301', 'Held', 'Over', 'officer')`);

// A shift that ended two hours ago; they are still on post, held over.
const heldShift = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status) VALUES (?,?,?,?, 'in_progress')`,
  officer, postId, toSql(ago(10)), toSql(ago(2)));
await id(`INSERT INTO time_entries (user_id, post_id, shift_id, clock_in_at) VALUES (?,?,?,?)`, officer, postId, heldShift, toSql(ago(10)));
// Their next shift starts nine hours after the scheduled end: enough on paper.
const nextStart = new Date(ago(2).getTime() + 9 * H);
const nextShift = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at) VALUES (?,?,?,?)`,
  officer, postId, toSql(nextStart), toSql(new Date(nextStart.getTime() + 8 * H)));

const worked = (await shiftsAsWorked({ from: ago(48), to: new Date(now.getTime() + 48 * H), userId: officer, now })).get(officer);
const held = worked.find((s) => s.id === heldShift);
log(held?.held_over && Math.abs(new Date(held.ends_at) - now) < MIN, 'a shift they are still on, past its end, is worked until now');
const issues = await fatigueFor(officer, { startsAt: nextStart, endsAt: new Date(nextStart.getTime() + 8 * H), excludeShiftId: nextShift, now });
const rest = issues.find((i) => i.code === 'short_rest');
log(rest && /7 h/.test(rest.message), 'so their next shift, nine hours after the scheduled end, leaves them seven hours off', rest?.message);
const board = await fatigueBoard({ now });
log(board.shifts.some((s) => s.shift_id === nextShift && s.previous?.held_over), 'the board lists it, and says the shift before was held over');

// Clocked out late: the shift ends at the clock-out.
const late = await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status) VALUES (?,?,?,?, 'completed')`,
  officer, postId, toSql(ago(40)), toSql(ago(32)));
await id(`INSERT INTO time_entries (user_id, post_id, shift_id, clock_in_at, clock_out_at) VALUES (?,?,?,?,?)`,
  officer, postId, late, toSql(ago(40)), toSql(ago(30)));
const lateWorked = (await shiftsAsWorked({ from: ago(48), to: now, userId: officer, now })).get(officer).find((s) => s.id === late);
log(Math.abs(new Date(lateWorked.ends_at) - ago(30)) < MIN, 'one they clocked out of two hours late ends at the clock-out');

// Cancelled and missed shifts were not worked.
await id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status) VALUES (?,?,?,?, 'missed')`, officer, postId, toSql(ago(28)), toSql(ago(20)));
const count = (await shiftsAsWorked({ from: ago(48), to: new Date(now.getTime() + 48 * H), userId: officer, now })).get(officer).length;
log(count === 3, 'and a missed shift does not count', `${count} shifts`);

console.log(`\nRest and fatigue rules: ${failed ? `${failed} CHECK(S) FAILED.` : 'all checks passed.'}`);
process.exit(failed ? 1 : 0);
