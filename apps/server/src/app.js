/**
 * The Express application, with no server attached.
 *
 * `index.js` listens on a port for local development and container hosts;
 * `api/index.js` exports the same app as a Vercel serverless function. Keeping
 * the wiring here means both surfaces behave identically.
 */

import express from 'express';
import cors from 'cors';
import { migrate, db, demoInstance } from './lib/db.js';
import { errorHandler, wrap, HttpError } from './lib/http.js';
import { requireAuth } from './lib/auth.js';
import { sweep } from './services/compliance.js';
import { sendDailyReports } from './services/clientNotify.js';

import { authRouter } from './routes/auth.js';
import { timeclockRouter } from './routes/timeclock.js';
import { incidentsRouter } from './routes/incidents.js';
import { visitsRouter } from './routes/visits.js';
import { toursRouter } from './routes/tours.js';
import { broadcastsRouter, trainingRouter, messagesRouter } from './routes/comms.js';
import { scheduleRouter } from './routes/schedule.js';
import { adminRouter } from './routes/admin.js';
import { devicesRouter } from './routes/devices.js';
import { certificationsRouter, availabilityRouter, timeOffRouter } from './routes/workforce.js';
import { panicRouter, breaksRouter } from './routes/safety.js';
import { reportsRouter } from './routes/reports.js';
import { shiftRequestsRouter } from './routes/shiftRequests.js';
import { clientRouter } from './routes/client.js';
import { clientAdminRouter } from './routes/clientAdmin.js';
import { noticesRouter } from './routes/notices.js';
import { applyRouter, hiringRouter } from './routes/hiring.js';
import { dispatchRouter } from './routes/dispatch.js';
import { correctionsRouter } from './routes/corrections.js';
import { agreementsRouter } from './routes/agreements.js';
import { invoicesRouter } from './routes/invoices.js';
import { liveRouter, punchesRouter } from './routes/operations.js';
import { payRatesRouter } from './routes/payRates.js';
import { equipmentRouter } from './routes/equipment.js';
import { vehiclesRouter } from './routes/vehicles.js';
import { expensesRouter } from './routes/expenses.js';
import { commendationsRouter } from './routes/commendations.js';
import { holidaysRouter } from './routes/holidays.js';
import { adminReportsRouter } from './routes/adminReports.js';
import { payrollRouter } from './routes/payroll.js';
import { ensureDemoInstance } from './services/demoInstance.js';
import { coverageRequestsRouter } from './routes/coverageRequests.js';
import { postLogRouter } from './routes/postLog.js';
import { siteLogRouter } from './routes/siteLog.js';

export const app = express();

app.set('trust proxy', 1);
app.use(
  cors({
    origin: process.env.USC_ALLOWED_ORIGINS?.split(',') ?? true,
    credentials: false,
  })
);
app.use(express.json({ limit: '2mb' }));

/**
 * A serverless instance starts cold, so the schema is applied on the first
 * request rather than at import time. migrate() memoises, so this costs one
 * round trip per cold start and nothing afterwards.
 */
let ready = null;
app.use((_req, _res, next) => {
  // A deployment with no database is a self-contained demo; it fills its own
  // throwaway database first. With a database configured this is migrate().
  ready ??= demoInstance ? ensureDemoInstance() : migrate();
  ready.then(
    () => next(),
    (err) => {
      ready = null;
      next(err);
    }
  );
});

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, service: 'USA Security Connect API', time: new Date().toISOString(), demo: demoInstance })
);

/** Sites and posts an officer may need to pick from when clocking in. */
app.get(
  '/api/reference',
  requireAuth,
  wrap(async (_req, res) => {
    const sites = await db
      .prepare(`SELECT id, name, address, city, state FROM sites WHERE active = 1 ORDER BY name`)
      .all();
    const posts = await db
      .prepare(
        `SELECT p.id, p.name, p.post_code, p.site_id, p.requires_gps, p.check_in_interval_min,
                p.latitude, p.longitude, p.geofence_radius_m, p.address, s.name AS site_name
         FROM posts p JOIN sites s ON s.id = p.site_id
         WHERE p.active = 1 ORDER BY s.name, p.name`
      )
      .all();
    res.json({ sites, posts });
  })
);

/**
 * Compliance sweep, for a scheduler to call.
 *
 * On a long-running host an internal timer drives this. On Vercel there is no
 * such timer, so Vercel Cron hits this endpoint instead - hence the shared
 * secret, since it must be reachable without a user session.
 *
 * Vercel Cron only ever issues GET, and sends the secret as a bearer token.
 * POST stays for triggering a sweep by hand.
 */
const sweepHandler = wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const offered =
    req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.secret || '';

  if (!secret) throw new HttpError(503, 'CRON_SECRET is not configured.');
  if (offered !== secret) throw new HttpError(401, 'Not authorised.');

  const result = await sweep();
  // The morning's daily report emails ride the same timer, after the sweep.
  try {
    result.dailyReports = await sendDailyReports();
  } catch (err) {
    console.error('[usc] daily report emails failed', err.message);
  }
  res.json({ ok: true, ...result });
});

app.get('/api/cron/sweep', sweepHandler);
app.post('/api/cron/sweep', sweepHandler);

app.use('/api/auth', authRouter);
app.use('/api/timeclock', timeclockRouter);
app.use('/api/incidents', incidentsRouter);
app.use('/api/visits', visitsRouter);
app.use('/api/tours', toursRouter);
app.use('/api/broadcasts', broadcastsRouter);
app.use('/api/training', trainingRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/certifications', certificationsRouter);
app.use('/api/availability', availabilityRouter);
app.use('/api/time-off', timeOffRouter);
app.use('/api/panic', panicRouter);
app.use('/api/breaks', breaksRouter);
app.use('/api/shifts', shiftRequestsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/equipment', equipmentRouter);
app.use('/api/vehicles', vehiclesRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/commendations', commendationsRouter);
app.use('/api/holidays', holidaysRouter);
app.use('/api/post-log', postLogRouter);
app.use('/api/post-log', siteLogRouter);
app.use('/api/client', clientRouter);
app.use('/api/invoices', invoicesRouter);
// Mounted ahead of adminRouter so these prefixes reach their own routers.
app.use('/api/admin/clients', clientAdminRouter);
app.use('/api/admin/client-notices', noticesRouter);
app.use('/api/apply', applyRouter);
app.use('/api/admin/hiring', hiringRouter);
app.use('/api/admin/agreements', agreementsRouter);
app.use('/api/dispatch', dispatchRouter);
app.use('/api/time-corrections', correctionsRouter);
app.use('/api/admin/live', liveRouter);
app.use('/api/admin/punches', punchesRouter);
app.use('/api/admin/pay-rates', payRatesRouter);
app.use('/api/admin/reports', adminReportsRouter);
app.use('/api/admin/payroll', payrollRouter);
app.use('/api/admin/coverage-requests', coverageRequestsRouter);
app.use('/api/admin', adminRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.use(errorHandler);

export default app;
