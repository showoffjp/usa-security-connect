import { LOCATION_RULES } from '@shared/domain.js';

const MESSAGES = {
  1: 'Location permission is blocked. Enable it for this site so your post can be verified.',
  2: 'Your location is unavailable right now. Move to an open area and try again.',
  3: 'Getting your location took too long.',
};

/**
 * The best fix the device gives in a few seconds.
 *
 * A phone's first answer is often its rough network position, hundreds of
 * metres out, and the GPS settles over the next few seconds. So this watches
 * the position, keeps the most accurate fix seen, and stops as soon as one is
 * good to `goodEnough` metres, or when `timeout` runs out. A position at
 * most a few seconds old is taken too: with location sharing on, the phone is
 * already watching, and a second watch on a phone standing still may hear
 * nothing new.
 *
 * Never rejects: a refused or unavailable fix is a normal outcome that the
 * clock-in flow has to handle, not an exception.
 */
export function getPosition({ timeout = LOCATION_RULES.bestFixSeconds * 1000, goodEnough = LOCATION_RULES.goodFixM, highAccuracy = true } = {}) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      return resolve({ ok: false, reason: 'unsupported', message: 'This device cannot report its location.' });
    }
    let best = null;
    let watch = null;
    let settled = false;
    const shape = (pos) => ({
      ok: true,
      latitude: Number(pos.coords.latitude.toFixed(6)),
      longitude: Number(pos.coords.longitude.toFixed(6)),
      accuracy: pos.coords.accuracy == null ? null : Math.round(pos.coords.accuracy),
      at: new Date(pos.timestamp).toISOString(),
    });
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (watch != null) navigator.geolocation.clearWatch(watch);
      resolve(value);
    };
    const consider = (pos) => {
      const acc = pos.coords.accuracy ?? Infinity;
      if (!best || acc < (best.coords.accuracy ?? Infinity)) best = pos;
      if (acc <= goodEnough) done(shape(best));
    };
    navigator.geolocation.getCurrentPosition(consider, () => {}, { enableHighAccuracy: highAccuracy, timeout, maximumAge: 5000 });
    watch = navigator.geolocation.watchPosition(
      consider,
      (err) => {
        // Keep waiting on a slow fix; give up on a refusal.
        if (err.code === 1 || !best) done({ ok: false, reason: err.code === 1 ? 'denied' : 'unavailable', message: MESSAGES[err.code] || err.message });
      },
      { enableHighAccuracy: highAccuracy, timeout, maximumAge: 0 }
    );
    setTimeout(() => done(best ? shape(best) : { ok: false, reason: 'timeout', message: MESSAGES[3] }), timeout);
  });
}

/** Shape a fix for the clock-in / check-in request bodies. */
export const geoBody = (fix) =>
  fix?.ok
    ? { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy }
    : { latitude: null, longitude: null, accuracy: null };
