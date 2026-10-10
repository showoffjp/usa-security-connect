import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, LOCATION_RULES, CHECK_IN_CHOICES, checkInLabel } from '../shared.js';
import { locationCheck, checkSite, siteAddress, postAddress } from '../services/locations.js';
import { geocodeAddress } from '../services/geocode.js';
import { getSetting, setSetting } from '../services/settings.js';
import { withdrawCheckInsTurnedOff } from '../services/compliance.js';

/**
 * Where sites and posts are (see services/locations.js), and the company
 * settings administrators change. Mounted under /api/admin.
 */
export const locationsRouter = Router();
locationsRouter.use(requireAuth, requireRole(ROLES.SUPERVISOR));
const onlyAdmin = requireRole(ROLES.ADMIN);

/** Every site and post pin against its address, worst first. ?refresh=1 asks the geocoder again. */
locationsRouter.get(
  '/locations',
  wrap(async (req, res) => {
    res.json(await locationCheck({ refresh: req.query.refresh === '1' }));
  })
);

const TABLE = { site: 'sites', post: 'posts' };
async function target(kind, id) {
  const table = TABLE[kind];
  if (!table) throw new HttpError(404, 'Not found.');
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(idParam(id, kind));
  if (!row) throw new HttpError(404, `${kind === 'site' ? 'Site' : 'Post'} not found.`);
  return { table, row };
}

/** The judged site (with all its posts), and the one asked about. */
async function verdictFor(kind, row) {
  const site = kind === 'site' ? await db.prepare(`SELECT * FROM sites WHERE id = ?`).get(row.id) : await db.prepare(`SELECT * FROM sites WHERE id = ?`).get(row.site_id);
  const posts = await db.prepare(`SELECT * FROM posts WHERE site_id = ? AND (active = true OR id = ?) ORDER BY name`).all(site.id, kind === 'post' ? row.id : 0);
  const judged = await checkSite(site, posts);
  return kind === 'site' ? judged : judged.posts.find((p) => p.id === row.id);
}

/** Move the pin onto the street address, as the geocoder places it. */
locationsRouter.post(
  '/locations/:kind/:id/use-address',
  onlyAdmin,
  wrap(async (req, res) => {
    const { table, row } = await target(req.params.kind, req.params.id);
    let address = null;
    if (req.params.kind === 'site') address = siteAddress(row);
    else address = postAddress(row, await db.prepare(`SELECT * FROM sites WHERE id = ?`).get(row.site_id));
    if (!address) throw new HttpError(422, 'There is no street address to use. Add one, or set the pin from the post.');
    const match = await geocodeAddress(address);
    if (!match) throw new HttpError(503, 'Address lookup is unavailable just now. Try again, or set the pin on the map.');
    if (match.precision === 'none' || match.precision === 'area' || match.latitude == null) {
      throw new HttpError(409, 'That address cannot be found precisely. Set the pin from the post itself, or drop it on the map.');
    }
    await db
      .prepare(
        `UPDATE ${table} SET latitude = ?, longitude = ?, location_source = 'address', location_accuracy_m = NULL,
                location_set_at = now(), location_set_by = ? WHERE id = ?`
      )
      .run(match.latitude, match.longitude, req.user.id, row.id);
    await audit(req.user.id, `${req.params.kind}.pin_from_address`, req.params.kind, row.id, { from: [row.latitude, row.longitude], to: [match.latitude, match.longitude], precision: match.precision }, req.ip);
    res.json({ location: await verdictFor(req.params.kind, row) });
  })
);

const surveySchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().nullable().optional(),
});

/**
 * Set the pin from a phone standing at the site or post. Only a fix good to
 * LOCATION_RULES.surveyAccuracyM is taken: anything rougher would move the
 * geofence by more than the error it is meant to fix.
 */
locationsRouter.post(
  '/locations/:kind/:id/survey',
  wrap(async (req, res) => {
    const body = parse(surveySchema, req.body);
    const { table, row } = await target(req.params.kind, req.params.id);
    if (body.accuracy == null) throw new HttpError(422, 'Your device did not say how accurate its position is. Try again with location set to precise.');
    if (body.accuracy > LOCATION_RULES.surveyAccuracyM) {
      throw new HttpError(422, `Your position is only good to ${Math.round(body.accuracy)} m; it needs to be within ${LOCATION_RULES.surveyAccuracyM} m. Step outside or near a window, wait a moment and try again.`);
    }
    await db
      .prepare(
        `UPDATE ${table} SET latitude = ?, longitude = ?, location_source = 'survey', location_accuracy_m = ?,
                location_set_at = now(), location_set_by = ? WHERE id = ?`
      )
      .run(Number(body.latitude.toFixed(6)), Number(body.longitude.toFixed(6)), Math.round(body.accuracy), req.user.id, row.id);
    await audit(req.user.id, `${req.params.kind}.pin_surveyed`, req.params.kind, row.id, { from: [row.latitude, row.longitude], to: [body.latitude, body.longitude], accuracy: body.accuracy }, req.ip);
    res.json({ location: await verdictFor(req.params.kind, row) });
  })
);

/* -------------------------------------------------------------- settings --- */

const checkInView = async () => {
  const everyMin = Number(await getSetting('checkIns.everyMin')) || 0;
  const posts = await db.prepare(`SELECT check_in_interval_min AS m FROM posts WHERE active = true`).all();
  return {
    everyMin,
    label: checkInLabel(everyMin),
    choices: CHECK_IN_CHOICES.map((m) => ({ value: m, label: checkInLabel(m) })),
    postsFollowing: posts.filter((p) => p.m == null).length,
    postsOwn: posts.filter((p) => p.m != null).length,
  };
};

/** How often officers check in, company-wide: posts that set nothing of their own follow it. */
locationsRouter.get(
  '/settings/check-ins',
  wrap(async (_req, res) => {
    res.json(await checkInView());
  })
);

locationsRouter.put(
  '/settings/check-ins',
  onlyAdmin,
  wrap(async (req, res) => {
    const { everyMin } = parse(z.object({ everyMin: z.number().int().refine((m) => CHECK_IN_CHOICES.includes(m), 'Choose one of the listed intervals.') }), req.body);
    const before = await getSetting('checkIns.everyMin');
    await setSetting('checkIns.everyMin', everyMin, req.user.id);
    if (!everyMin) await withdrawCheckInsTurnedOff();
    await audit(req.user.id, 'settings.check_ins', 'settings', null, { from: before, to: everyMin }, req.ip);
    res.json(await checkInView());
  })
);
