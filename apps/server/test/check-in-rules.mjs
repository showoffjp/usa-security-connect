/**
 * Status check-ins whose time has passed, against a real database but no
 * server.
 *
 * A check-in left unanswered past its window is missed. The sweep finds it
 * on a timer, but a serverless deployment sweeps rarely, and until then the
 * officer's screen kept showing the same one, overdue, with no next one
 * queued. Now the officer's own screen counts it missed when it looks, which
 * flags it and queues the next, and the sweep after that does not flag it
 * again. And an administrator turning check-ins off, for the company or one
 * post, withdraws the ones already waiting, so nobody is pushed for one or
 * marked as having missed it.
 *
 * USC_PGLITE_MEMORY gives this its own throwaway database, like flags.mjs.
 */

process.env.USC_PGLITE_MEMORY = '1';

const { db, migrate } = await import('../src/lib/db.js');
const { sweep, toSql, scheduleNextCheckIn, currentCheckIn, withdrawCheckInsTurnedOff } = await import('../src/services/compliance.js');
const { setSetting } = await import('../src/services/settings.js');

let failed = 0;
const log = (ok, label, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

await migrate();

const MIN = 60000;
const ago = (minutes) => new Date(Date.now() - minutes * MIN);
const id = async (sql, ...args) => Number((await db.prepare(sql).run(...args)).lastInsertRowid);
const row = (sql, ...args) => db.prepare(sql).get(...args);

const siteId = await id(`INSERT INTO sites (name) VALUES ('Check-in Test Site')`);
// The lobby follows the company's interval (an hour); the dock sets 30 minutes of its own.
const lobby = await id(`INSERT INTO posts (site_id, name, requires_gps) VALUES (?, 'Lobby', false)`, siteId);
const dock = await id(`INSERT INTO posts (site_id, name, requires_gps, check_in_interval_min) VALUES (?, 'Dock', false, 30)`, siteId);
let code = 9300;
const officer = () => id(`INSERT INTO users (employee_code, first_name, last_name, role) VALUES (?, 'Test', 'Officer', 'officer')`, String(code++));
const onDuty = async (postId, minutesAgo) => {
  const entryId = await id(`INSERT INTO time_entries (user_id, post_id, clock_in_at) VALUES (?,?,?)`, await officer(), postId, toSql(ago(minutesAgo)));
  return row(`SELECT * FROM time_entries WHERE id = ?`, entryId);
};
const post = (postId) => row(`SELECT * FROM posts WHERE id = ?`, postId);
const missedFlags = (checkId) => row(`SELECT COUNT(*) AS n FROM flags WHERE type = 'missed_check_in' AND ref_id = ?`, checkId).then((r) => Number(r.n));

/* An officer clocked in 75 minutes ago: the first was due 15 minutes ago, and its 10 minutes to answer ran out 5 minutes ago. */
const late = await onDuty(lobby, 75);
const first = await scheduleNextCheckIn(late, await post(lobby));
log(Math.abs(new Date(first.due_at) - ago(15)) < MIN, 'the first check-in fell due an hour after the clock-in');

const next = await scheduleNextCheckIn(late, await post(lobby));
const firstNow = await row(`SELECT status FROM status_checks WHERE id = ?`, first.id);
log(firstNow.status === 'missed', 'looked at again with its window run out, it is counted missed', firstNow.status);
log((await missedFlags(first.id)) === 1, 'and flagged');
log(next && next.id !== first.id && Math.abs(new Date(next.due_at) - (new Date(first.due_at).getTime() + 60 * MIN)) < 1000,
  'and the next is queued an hour after it was due, without waiting for the sweep');
const shown = await currentCheckIn(late.id);
log(shown?.id === next.id && !shown.is_overdue, "so the officer's screen moves on to the next one");

await sweep(new Date());
log((await missedFlags(first.id)) === 1, 'the sweep after that does not flag it a second time');
log((await scheduleNextCheckIn(late, await post(lobby)))?.id === next.id, 'nor queue another');

/* One clocked in 65 minutes ago: due 5 minutes ago, still inside its 10 minutes. */
const answering = await onDuty(lobby, 65);
const due = await scheduleNextCheckIn(answering, await post(lobby));
const again = await scheduleNextCheckIn(answering, await post(lobby));
log(again.id === due.id && (await row(`SELECT status FROM status_checks WHERE id = ?`, due.id)).status === 'pending',
  'one overdue but still inside its window waits to be answered');

/* At the dock, 30 minutes of its own. */
const docked = await onDuty(dock, 10);
const dockCheck = await scheduleNextCheckIn(docked, await post(dock));
log(Math.abs(new Date(dockCheck.due_at) - (new Date(docked.clock_in_at).getTime() + 30 * MIN)) < 1000, 'a post with its own interval keeps it');

/* An administrator turns the company's check-ins off. */
await setSetting('checkIns.everyMin', 0);
const withdrawn = await withdrawCheckInsTurnedOff();
const status = async (checkId) => (await row(`SELECT status FROM status_checks WHERE id = ?`, checkId)).status;
log(withdrawn === 2 && (await status(next.id)) === 'cancelled' && (await status(due.id)) === 'cancelled',
  'turning them off withdraws the two waiting at the post that follows the company', `${withdrawn}`);
log((await status(dockCheck.id)) === 'pending', 'but not the one at the post with its own interval');
log((await scheduleNextCheckIn(late, await post(lobby))) === null && (await currentCheckIn(late.id)) === null, 'and none is queued there after');

/* Then the dock's own turned off. */
await db.prepare(`UPDATE posts SET check_in_interval_min = 0 WHERE id = ?`).run(dock);
log((await withdrawCheckInsTurnedOff()) === 1 && (await status(dockCheck.id)) === 'cancelled', "turning one post's off withdraws its one too");

await sweep(new Date(Date.now() + 3 * 60 * MIN));
log((await missedFlags(next.id)) + (await missedFlags(due.id)) + (await missedFlags(dockCheck.id)) === 0,
  'so the sweep, hours later, holds none of them against anybody');

console.log(`\nCheck-in rules: ${failed ? `${failed} CHECK(S) FAILED.` : 'all checks passed.'}`);
process.exit(failed ? 1 : 0);
