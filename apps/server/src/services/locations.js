/**
 * The location check: is every site and post pin where its address says it
 * is? The geofence that decides whether an officer is on post is drawn round
 * the post's pin, so a pin in the wrong place either lets an officer clock in
 * from down the road or flags one standing at the door.
 *
 * A site pin is compared with the site's street address; a post with an
 * address of its own with that, and a post without one with its site's pin
 * (it should be on the same property). A pin set from a phone at the post
 * with a good fix is trusted over any address. See LOCATION_RULES.
 */

import { db } from '../lib/db.js';
import { isoFields } from '../lib/http.js';
import { LOCATION_RULES as R, LOCATION_STATE_LABEL, distanceMeters } from '../shared.js';
import { addressLine, geocodeAddress, geocoderProvider } from './geocode.js';

/** A site's full address, as looked up. */
export const siteAddress = (s) => addressLine(s.address, s.city, addressLine(s.state, s.postal_code).replace(',', ''));

/** A post's own address, completed from its site's town when it is only the street. */
export function postAddress(p, site) {
  if (!p.address?.trim()) return null;
  return /,/.test(p.address) ? addressLine(p.address, site?.state) : addressLine(p.address, site?.city, site?.state, site?.postal_code);
}

const hasPin = (x) => x.latitude != null && x.longitude != null;
const surveyed = (x) => x.location_source === 'survey' && x.location_accuracy_m != null && x.location_accuracy_m <= R.surveyAccuracyM;

/** Judge one pin against what it should be near. */
export function judge(x, { match = null, sitePin = null } = {}) {
  if (!hasPin(x)) return { state: 'no_pin' };
  const base = surveyed(x) ? { state: 'surveyed', accuracy_m: x.location_accuracy_m } : null;
  if (match) {
    if (match.precision === 'none' || match.precision === 'area' || match.latitude == null) return base || { state: 'no_match', match };
    const distance = distanceMeters(x.latitude, x.longitude, match.latitude, match.longitude);
    const tolerance = match.precision === 'building' ? R.pinToleranceM : R.streetToleranceM;
    // Set at the post, but nowhere near the address: stood at the wrong place?
    if (base) return distance > 3 * tolerance ? { state: 'check', distance_m: distance, tolerance_m: tolerance, match, accuracy_m: x.location_accuracy_m } : { ...base, distance_m: distance, tolerance_m: tolerance, match };
    return { state: distance <= tolerance ? 'ok' : distance <= 3 * tolerance ? 'check' : 'wrong', distance_m: distance, tolerance_m: tolerance, match };
  }
  if (sitePin && hasPin(sitePin)) {
    const distance = distanceMeters(x.latitude, x.longitude, sitePin.latitude, sitePin.longitude);
    if (base) return distance > 3 * R.postFromSiteM ? { state: 'check', distance_m: distance, tolerance_m: R.postFromSiteM, from: 'site' } : { ...base, distance_m: distance, from: 'site' };
    return { state: distance <= R.postFromSiteM ? 'ok' : distance <= 3 * R.postFromSiteM ? 'check' : 'wrong', distance_m: distance, tolerance_m: R.postFromSiteM, from: 'site' };
  }
  return base || { state: 'unchecked' };
}

const present = (row, verdict, address) => ({
  ...isoFields(row, ['location_set_at']),
  address_line: address,
  ...verdict,
  match: verdict.match
    ? { latitude: verdict.match.latitude, longitude: verdict.match.longitude, label: verdict.match.label, precision: verdict.match.precision, provider: verdict.match.provider }
    : null,
  state_label: LOCATION_STATE_LABEL[verdict.state],
});

/** One site and its posts, judged. */
export async function checkSite(site, posts, { refresh = false } = {}) {
  const address = siteAddress(site);
  const match = address ? await geocodeAddress(address, { refresh }) : null;
  const siteVerdict = match ? judge(site, { match }) : hasPin(site) ? judge(site) : { state: 'no_pin' };
  const out = [];
  for (const p of posts) {
    const own = postAddress(p, site);
    const pm = own ? await geocodeAddress(own, { refresh }) : null;
    // A post's own address that cannot be found falls back to the site.
    const verdict = pm && pm.precision !== 'none' && pm.precision !== 'area' ? judge(p, { match: pm }) : judge(p, { sitePin: site });
    out.push(present(p, verdict, own));
  }
  return { ...present(site, address ? siteVerdict : { state: hasPin(site) ? 'unchecked' : 'no_pin' }, address), posts: out };
}

const NEEDS = ['wrong', 'no_pin', 'check', 'no_match'];

/** Every active site and post, worst first. */
export async function locationCheck({ refresh = false } = {}) {
  const sites = await db.prepare(`SELECT * FROM sites WHERE active = true ORDER BY name`).all();
  const posts = await db.prepare(`SELECT * FROM posts WHERE active = true ORDER BY name`).all();
  const judged = [];
  for (const s of sites) judged.push(await checkSite(s, posts.filter((p) => p.site_id === s.id), { refresh }));
  const all = judged.flatMap((s) => [s, ...s.posts]);
  const counts = Object.fromEntries(Object.keys(LOCATION_STATE_LABEL).map((k) => [k, all.filter((x) => x.state === k).length]));
  const worst = (s) => Math.min(...[s, ...s.posts].map((x) => (NEEDS.includes(x.state) ? NEEDS.indexOf(x.state) : 9)));
  judged.sort((a, b) => worst(a) - worst(b) || a.name.localeCompare(b.name));
  return {
    rules: R,
    geocoder: geocoderProvider,
    counts,
    needsAttention: all.filter((x) => NEEDS.includes(x.state)).length,
    sites: judged,
  };
}
