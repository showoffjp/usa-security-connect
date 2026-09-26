/**
 * raiseFlag, against a real database but no server.
 *
 * `flags.detail` is jsonb, so whatever raiseFlag is handed has to come back out
 * as JSON. Every caller today passes an object, which is exactly why the string
 * branch could sit there broken without anyone noticing - it was unreachable by
 * route, so no HTTP suite could have caught it.
 *
 * USC_PGLITE_MEMORY gives this its own throwaway database, so it does not fight
 * the API server for PGlite's single writer and can run before anything starts.
 */

process.env.USC_PGLITE_MEMORY = '1';

const { db, migrate } = await import('../src/lib/db.js');
const { raiseFlag } = await import('../src/services/compliance.js');

let failed = 0;
const log = (ok, label, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

await migrate();

const userId = Number(
  (await db
    .prepare(
      `INSERT INTO users (employee_code, first_name, last_name, role)
       VALUES ('9001', 'Flag', 'Fixture', 'officer')`
    )
    .run()).lastInsertRowid
);

const read = async (refId) =>
  (await db.prepare(`SELECT detail FROM flags WHERE ref_type = 'test' AND ref_id = ?`).get(refId))?.detail;

/* ---------------------------------------------------------------- objects */

await raiseFlag({
  userId,
  type: 'late_clock_in',
  refType: 'test',
  refId: 1,
  detail: { late_minutes: 12, scheduled_start: '2026-01-01T06:00:00.000Z' },
});
const object = await read(1);
log(object?.late_minutes === 12, 'an object detail survives the round trip', JSON.stringify(object));

/* ---------------------------------------------------------------- strings */

// This is the case that used to fail: a bare string went into a jsonb column
// unquoted, which is not valid JSON, and the insert threw.
await raiseFlag({
  userId,
  type: 'no_show',
  refType: 'test',
  refId: 2,
  detail: 'Nobody arrived and the client called it in.',
});
const text = await read(2);
log(text === 'Nobody arrived and the client called it in.',
  'a string detail is encoded rather than rejected', JSON.stringify(text));

/* ------------------------------------------------------------------ empty */

await raiseFlag({ userId, type: 'early_departure', refType: 'test', refId: 3 });
log((await read(3)) === null, 'no detail stays null rather than becoming "null"');

await raiseFlag({ userId, type: 'unscheduled_shift', refType: 'test', refId: 4, detail: 0 });
log((await read(4)) === 0, 'a falsy detail is still recorded, not dropped');

/* ------------------------------------------------------------- uniqueness */

await raiseFlag({ userId, type: 'late_clock_in', refType: 'test', refId: 1, detail: { late_minutes: 99 } });
const again = await read(1);
log(again?.late_minutes === 12,
  'raising the same flag twice leaves the first one alone', JSON.stringify(again));

console.log(`\n${failed === 0 ? 'flags: all checks passed.' : `flags: ${failed} CHECK(S) FAILED.`}`);
await db.close?.();
process.exit(failed === 0 ? 0 : 1);
