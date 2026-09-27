/**
 * Vercel serverless entry.
 *
 * Express apps are request handlers, so the app can be exported directly.
 * Everything under /api is routed here by the rewrite in vercel.json.
 *
 * Nothing that needs a persistent process lives in here: the compliance sweep
 * runs from Vercel Cron against /api/cron/sweep, and incident photos go to blob
 * storage rather than a local disk.
 */
import './timezone.mjs';
export { app as default } from '../apps/server/src/app.js';
