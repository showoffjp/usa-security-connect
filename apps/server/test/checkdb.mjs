import { db, migrate } from '../src/lib/db.js';

migrate();

const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
const wanted = [
  'employment_type', 'pay_type', 'exempt', 'overtime_multiplier', 'salary_cents',
  'bill_rate_cents', 'business_name', 'tax_id_last4', 'w9_on_file',
  'contractor_agreement_on_file', 'insurance_expires_on', 'address_line1',
  'city', 'state', 'postal_code', 'uniform_size', 'emergency_contact_relation',
];
console.log('users columns :', cols.length);
const missing = wanted.filter((c) => !cols.includes(c));
console.log('missing cols  :', missing.length ? missing.join(', ') : 'none');

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((t) => t.name)
  .filter((n) => !n.startsWith('sqlite_'));
console.log('tables        :', tables.length, '-', tables.join(', '));

const newTables = ['certifications', 'availability', 'time_off_requests', 'breaks', 'panic_alerts', 'device_tokens'];
const missingTables = newTables.filter((t) => !tables.includes(t));
console.log('missing tables:', missingTables.length ? missingTables.join(', ') : 'none');

db.close();
process.exit(missing.length || missingTables.length ? 1 : 0);
