import express from 'express';
import cors from 'cors';
import { migrate, db } from './lib/db.js';
import { errorHandler, wrap } from './lib/http.js';
import { requireAuth } from './lib/auth.js';
import { startComplianceWorker } from './services/compliance.js';

import { authRouter } from './routes/auth.js';
import { timeclockRouter } from './routes/timeclock.js';
import { incidentsRouter, visitsRouter } from './routes/incidents.js';
import { toursRouter } from './routes/tours.js';
import { broadcastsRouter, trainingRouter, messagesRouter } from './routes/comms.js';
import { scheduleRouter } from './routes/schedule.js';
import { adminRouter } from './routes/admin.js';
import { devicesRouter } from './routes/devices.js';
import { certificationsRouter, availabilityRouter, timeOffRouter } from './routes/workforce.js';
import { panicRouter, breaksRouter } from './routes/safety.js';
import { reportsRouter } from './routes/reports.js';

migrate();

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.set('trust proxy', 1);
app.use(
  cors({
    origin: process.env.USC_ALLOWED_ORIGINS?.split(',') ?? true,
    credentials: false,
  })
);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, service: 'USA Security Connect API', time: new Date().toISOString() })
);

/** Sites and posts an officer may need to pick from when clocking in. */
app.get(
  '/api/reference',
  requireAuth,
  wrap(async (_req, res) => {
    const sites = db.prepare(`SELECT id, name, address, city, state FROM sites WHERE active = 1 ORDER BY name`).all();
    const posts = db
      .prepare(
        `SELECT p.id, p.name, p.post_code, p.site_id, p.requires_gps, p.check_in_interval_min,
                p.latitude, p.longitude, p.geofence_radius_m, s.name AS site_name
         FROM posts p JOIN sites s ON s.id = p.site_id
         WHERE p.active = 1 ORDER BY s.name, p.name`
      )
      .all();
    res.json({ sites, posts });
  })
);

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
app.use('/api/reports', reportsRouter);
app.use('/api/admin', adminRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.use(errorHandler);

const stopWorker = startComplianceWorker(60000);

const server = app.listen(PORT, () => {
  console.log(`USA Security Connect API listening on http://localhost:${PORT}`);
});

const shutdown = () => {
  stopWorker();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
