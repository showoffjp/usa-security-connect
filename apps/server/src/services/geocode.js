/**
 * Street addresses to coordinates, and how far each answer can be trusted.
 *
 *   building  the geocoder found the building or its door: Google's ROOFTOP,
 *             or an OpenStreetMap feature carrying that house number
 *   street    placed along the street from the house-number range (the US
 *             Census Bureau's geocoder, Google's RANGE_INTERPOLATED): close
 *             on a city block, but a large property can be hundreds of
 *             metres out
 *   area      only the street or the neighbourhood was found
 *
 * With USC_MAPS_API_KEY set, Google answers. Without it OpenStreetMap's
 * Nominatim and the Census geocoder are asked together, neither needing a
 * key, and the most precise answer wins. USC_GEOCODER=off asks nobody (the
 * test suites, and any server with no way out), leaving only what is cached.
 *
 * A geocoder being slow or down never blocks anything: a lookup gives up after
 * a few seconds and the answer is "not found yet".
 */

import { db } from '../lib/db.js';

const KEY = process.env.USC_MAPS_API_KEY || '';
const OFF = process.env.USC_GEOCODER === 'off';
const UA = 'USA-Security-Connect/1.0 (workforce management)';
const RANK = { building: 0, street: 1, area: 2 };

export const geocoderProvider = OFF ? 'off' : KEY ? 'google' : 'openstreetmap+census';

async function getJson(url, headers = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    return res.ok ? await res.json() : null;
  } finally {
    clearTimeout(t);
  }
}

async function google(q) {
  const data = await getJson(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=us&key=${KEY}`);
  if (data?.status && !['OK', 'ZERO_RESULTS'].includes(data.status)) console.warn('[usc] google geocode:', data.status, data.error_message || '');
  return (data?.results || []).slice(0, 5).map((r) => ({
    label: r.formatted_address,
    latitude: r.geometry.location.lat,
    longitude: r.geometry.location.lng,
    precision: r.geometry.location_type === 'ROOFTOP' ? 'building' : r.geometry.location_type === 'RANGE_INTERPOLATED' ? 'street' : 'area',
    provider: 'google',
  }));
}

async function census(q) {
  const data = await getJson(
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`
  );
  return (data?.result?.addressMatches || []).slice(0, 3).map((m) => ({
    label: m.matchedAddress,
    latitude: Number(m.coordinates.y.toFixed(6)),
    longitude: Number(m.coordinates.x.toFixed(6)),
    precision: 'street',
    provider: 'census',
  }));
}

// Nominatim allows one request a second from an application.
let osmNext = 0;
async function osm(q) {
  const wait = osmNext - Date.now();
  osmNext = Math.max(Date.now(), osmNext) + 1100;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const data = await getJson(
    `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`,
    { 'User-Agent': UA }
  );
  const number = (/^\s*(\d+[a-z]?)\b/i.exec(q) || [])[1];
  return (Array.isArray(data) ? data : []).map((r) => ({
    label: r.display_name,
    latitude: Number(Number(r.lat).toFixed(6)),
    longitude: Number(Number(r.lon).toFixed(6)),
    // A road without the house number on it says nothing about which end.
    precision: r.class !== 'highway' && r.address?.house_number && (!number || r.address.house_number.toLowerCase() === number.toLowerCase()) ? 'building' : 'area',
    provider: 'openstreetmap',
  }));
}

/** Every answer for an address, most precise first. */
export async function geocodeSearch(q) {
  if (OFF || !q?.trim()) return { provider: geocoderProvider, results: [] };
  try {
    const results = KEY
      ? await google(q)
      : (await Promise.all([osm(q).catch(() => []), census(q).catch(() => [])])).flat();
    results.sort((a, b) => RANK[a.precision] - RANK[b.precision]);
    return { provider: geocoderProvider, results: results.slice(0, 6) };
  } catch (err) {
    console.error('[usc] geocode failed', err.message);
    return { provider: geocoderProvider, results: [], error: 'Address lookup is unavailable.' };
  }
}

/** One line for an address, the way it is looked up and cached. */
export const addressLine = (...parts) =>
  parts
    .flat()
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ');

const keyOf = (q) => q.toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
const FRESH_DAYS = 90;

/**
 * The best single answer for an address, cached. `{ precision: 'none' }` when
 * nobody could find it, and null when it has not been looked up and cannot be
 * now (the geocoder is off, or did not answer).
 */
export async function geocodeAddress(q, { refresh = false } = {}) {
  if (!q?.trim()) return null;
  const key = keyOf(q);
  const cached = await db.prepare(`SELECT * FROM address_geocodes WHERE query = ?`).get(key);
  const fresh = cached && Date.now() - new Date(cached.looked_up_at).getTime() < FRESH_DAYS * 86400000;
  if (cached && (OFF || (fresh && !refresh))) return cached;
  if (OFF) return null;
  const { results, error } = await geocodeSearch(q);
  if (error) return cached || null;
  const best = results[0] || null;
  await db
    .prepare(
      `INSERT INTO address_geocodes (query, latitude, longitude, label, precision, provider, looked_up_at)
       VALUES (?,?,?,?,?,?, now())
       ON CONFLICT (query) DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude, label = excluded.label,
         precision = excluded.precision, provider = excluded.provider, looked_up_at = now()`
    )
    .run(key, best?.latitude ?? null, best?.longitude ?? null, best?.label ?? null, best?.precision ?? 'none', best?.provider ?? geocoderProvider);
  return db.prepare(`SELECT * FROM address_geocodes WHERE query = ?`).get(key);
}

/** Put an answer in the cache by hand: the demo seed, which has no way out. */
export async function rememberGeocode(q, { latitude, longitude, label, precision, provider }, at = new Date()) {
  await db
    .prepare(
      `INSERT INTO address_geocodes (query, latitude, longitude, label, precision, provider, looked_up_at)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT (query) DO NOTHING`
    )
    .run(keyOf(q), latitude, longitude, label, precision, provider, at.toISOString());
}
