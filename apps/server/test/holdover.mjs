/**
 * Holdovers, against a real database but no server.
 *
 * An officer whose relief is late stays on post and is paid for it. The sweep
 * that closes forgotten clock-outs used to close them at the scheduled shift
 * end two hours later, unpaid for the time they stood; now it waits while the
 * relief has not come (for up to eight hours), and closes at the handover
 * once the relief clocks in.
 *
 * USC_PGLITE_MEMORY gives this its own throwaway database, like flags.mjs.
 */

process.env.USC_PGLITE_MEMORY = '1';

const { db, migrate } = await import('../src/lib/db.js');
const { sweep, toSql } = await import('../src/services/compliance.js');

let failed = 0;
const log = (ok, label, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

await migrate();

const MIN = 60000;
const now = new Date();
const ago = (minutes) => new Date(now.getTime() - minutes * MIN);
const id = async (sql, ...args) => Number((await db.prepare(sql).run(...args)).lastInsertRowid);

const siteId = await id(`INSERT INTO sites (name) VALUES ('Holdover Test Site')`);
let code = 9100;
const officer = () => id(`INSERT INTO users (employee_code, first_name, last_name, role) VALUES (?, 'Test', 'Officer', 'officer')`, String(code++));
const post = (name) => id(`INSERT INTO posts (site_id, name, requires_gps) VALUES (?, ?, false)`, siteId, name);
const shift = (userId, postId, startMin, endMin) =>
  id(`INSERT INTO shifts (user_id, post_id, starts_at, ends_at) VALUES (?,?,?,?)`, userId, postId, toSql(ago(startMin)), toSql(ago(endMin)));
const clockIn = (userId, postId, shiftId, atMin) =>
  id(`INSERT INTO time_entries (user_id, post_id, shift_id, clock_in_at) VALUES (?,?,?,?)`, userId, postId, shiftId, toSql(ago(atMin)));
const entry = (entryId) => db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(entryId);

/*
 * Four posts, each with an officer whose shift ended three hours ago (past
 * the two-hour grace the sweep gives a forgotten clock-out):
 *  late     - the relief was due at the handover and has not clocked in
 *  relieved - the relief clocked in 40 minutes after the handover
 *  closes   - nobody follows at the post
 *  gone     - the shift ended nine hours ago and the relief never came
 */
const scenarios = {};
for (const name of ['late', 'relieved', 'closes', 'gone']) {
  const postId = await post(`Post ${name}`);
  const a = await officer();
  const endMin = name === 'gone' ? 540 : 180;
  const shiftA = await shift(a, postId, endMin + 480, endMin);
  const entryA = await clockIn(a, postId, shiftA, endMin + 480);
  scenarios[name] = { postId, entryA, endMin };
  if (name !== 'closes') {
    const b = await officer();
    const shiftB = await shift(b, postId, endMin, endMin - 480);
    if (name === 'relieved') await clockIn(b, postId, shiftB, endMin - 40);
  }
}

await sweep(now);

const late = await entry(scenarios.late.entryA);
log(late.clock_out_at == null, 'an officer whose relief is late stays on the clock, held over');

const relieved = await entry(scenarios.relieved.entryA);
log(relieved.clock_out_at != null && Math.abs(new Date(relieved.clock_out_at) - ago(140)) < MIN,
  'one who forgot to clock out after the relief arrived is closed at the handover, not the scheduled end',
  relieved.clock_out_at && new Date(relieved.clock_out_at).toISOString());
log(Number(relieved.minutes_worked) === 480 + 40, 'and paid for the 40 minutes held over', `${relieved.minutes_worked} min`);

const closes = await entry(scenarios.closes.entryA);
log(closes.clock_out_at != null && Math.abs(new Date(closes.clock_out_at) - ago(180)) < MIN && Number(closes.minutes_worked) === 480,
  'with nobody following at the post, a forgotten clock-out still closes at the scheduled end');

const gone = await entry(scenarios.gone.entryA);
log(gone.clock_out_at != null && Math.abs(new Date(gone.clock_out_at) - ago(540)) < MIN,
  'a relief who never came does not hold the officer on the clock past eight hours');

const flag = await db
  .prepare(`SELECT detail FROM flags WHERE type = 'missed_clock_out' AND ref_id = ?`)
  .get(scenarios.relieved.entryA);
const detail = typeof flag?.detail === 'string' ? JSON.parse(flag.detail) : flag?.detail;
log(/relief clocked in/.test(detail?.note || ''), 'and the missed clock-out flag says it closed at the handover');

console.log(`\nHoldovers: ${failed ? `${failed} CHECK(S) FAILED.` : 'all checks passed.'}`);
process.exit(failed ? 1 : 0);
