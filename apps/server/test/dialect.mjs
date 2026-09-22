import { toPostgres, toPositional } from '../src/lib/db.js';

let failed = 0;
const check = (input, expected) => {
  const got = toPostgres(input);
  const ok = got.includes(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${expected}`);
  if (!ok) console.log(`      got: ${got}`);
};

// Every SQLite-ism that appears in the route code.
check("WHERE a > datetime('now')", 'a > now()');
check("BETWEEN datetime('now') AND datetime('now', '+12 hours')", "(now() + interval '12 hours')");
check("WHERE te.clock_in_at >= datetime('now','-30 days')", "(now() - interval '30 days')");
check("WHERE date(starts_at) = date('now')", 'starts_at::date = current_date');
check("AND date(c.expires_on) <= date('now','+60 days')", "(current_date + interval '60 days')");
check("date(c.expires_on) <= date('now', '+' || ? || ' days')", "(current_date + (? || ' days')::interval)");
check("datetime(sc.due_at, '+' || sc.window_minutes || ' minutes') < ?", "(sc.due_at + (sc.window_minutes || ' minutes')::interval)");
check("ORDER BY ABS(strftime('%s', sh.starts_at) - strftime('%s', ?))", 'EXTRACT(EPOCH FROM sh.starts_at)');

// Placeholders, including one inside a string literal that must be left alone.
const p = toPositional("SELECT * FROM t WHERE a = ? AND b = ? AND c = 'what? no'");
const pOk = p.includes('a = $1') && p.includes('b = $2') && p.includes("'what? no'");
console.log(`${pOk ? 'PASS' : 'FAIL'}  ? placeholders numbered, literals untouched`);
if (!pOk) { failed++; console.log('      got: ' + p); }

console.log(failed ? `\n${failed} FAILED` : '\nDialect translation correct.');
process.exit(failed ? 1 : 0);
