/**
 * Load the demo company from the command line.
 *
 *   npm run seed            -> fills an empty database, leaves existing data alone
 *   npm run reset           -> wipes everything first
 *
 * Every account uses a fixed PIN so the demo is reproducible; the sign-in
 * codes are printed at the end.
 */

import { db } from './lib/db.js';
import { seedDemo } from './seed-demo.js';

await seedDemo({ reset: process.argv.includes('--reset') });
await db.close();
