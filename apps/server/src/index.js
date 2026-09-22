/**
 * Standalone server: local development, Docker, Render, Railway, Fly.
 *
 * Vercel uses `api/index.js`, which exports the same app without listening.
 */

import { app } from './app.js';
import { migrate, db } from './lib/db.js';
import { startComplianceWorker } from './services/compliance.js';

// On a long-running host the schema is applied once, up front.
await migrate();

const PORT = Number(process.env.PORT || 4000);

// A process that stays alive can run the sweep on a timer. Serverless cannot,
// which is what /api/cron/sweep is for.
const stopWorker = await startComplianceWorker(60000);

const server = app.listen(PORT, () => {
  console.log(`USA Security Connect API listening on http://localhost:${PORT}`);
});

const shutdown = () => {
  stopWorker();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
