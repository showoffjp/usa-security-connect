/**
 * Create the first real administrator.
 *
 *   node apps/server/tools/create-admin.mjs "Vince" "Ortega" vince@usasecuritygroup.com
 *
 * The demo seed must never run against production, so this exists to get one
 * genuine account into an empty database. Everyone else is created from the
 * Employees screen by that account.
 *
 * It prints the PIN once. The account is forced to change it at first sign-in,
 * so the printed value is only useful for the next few minutes.
 */

import { db, migrate } from '../src/lib/db.js';
import { hashPin, generatePin, generateEmployeeCode } from '../src/lib/auth.js';

const [first, last, email] = process.argv.slice(2);

if (!first || !last) {
  console.error('Usage: node tools/create-admin.mjs "First" "Last" [email]');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.log(
    'DATABASE_URL is not set, so this will write to the local PGlite database\n' +
      'rather than to production. Ctrl-C now if that is not what you meant.\n'
  );
}

await migrate();

const existing = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get();
if (existing.n > 0 && !process.argv.includes('--force')) {
  console.error(
    `This database already has ${existing.n} administrator${existing.n === 1 ? '' : 's'}.\n` +
      'Create further accounts from the Employees screen, or pass --force if you are sure.'
  );
  await db.close();
  process.exit(1);
}

if (email) {
  const clash = await db.prepare(`SELECT id FROM users WHERE lower(email) = lower(?)`).get(email);
  if (clash) {
    console.error(`Someone already has the email ${email}.`);
    await db.close();
    process.exit(1);
  }
}

const employeeCode = await generateEmployeeCode();
const pin = generatePin(6);
const { hash, salt } = hashPin(pin);

await db
  .prepare(
    `INSERT INTO users
     (employee_code, first_name, last_name, email, role, status, employment_type,
      pay_type, pin_hash, pin_salt, pin_set_at, must_change_pin, hire_date)
     VALUES (?,?,?,?,'admin','active','w2','salary',?,?,now(),true,current_date)`
  )
  .run(employeeCode, first.trim(), last.trim(), email?.trim() || null, hash, salt);

console.log(`
Administrator created.

  Employee code   ${employeeCode}
  PIN             ${pin}

Sign in with those, choose a new PIN when prompted, then add the rest of your
staff from Employees. This PIN is not stored anywhere in readable form and
cannot be shown again - reset it from the admin console if it is lost.
`);

await db.close();
