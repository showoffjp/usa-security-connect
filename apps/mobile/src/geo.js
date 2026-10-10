import * as Location from 'expo-location';
import { LOCATION_RULES } from './shared.js';

/**
 * The best fix the phone gives in a few seconds. The first answer is often
 * the rough network position, hundreds of metres out; the GPS settles over the
 * next few seconds. So this watches, keeps the most accurate fix, and stops as
 * soon as one is good to `goodEnough` metres or `timeout` runs out.
 *
 * Never rejects - a refused permission is an outcome the clock-in flow
 * handles, not an exception.
 */
export async function getPosition({ timeout = LOCATION_RULES.bestFixSeconds * 1000, goodEnough = LOCATION_RULES.goodFixM } = {}) {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      return {
        ok: false,
        reason: 'denied',
        message: 'Location permission is off. Turn it on so your post can be verified.',
      };
    }

    const shape = (p) => ({
      ok: true,
      latitude: Number(p.coords.latitude.toFixed(6)),
      longitude: Number(p.coords.longitude.toFixed(6)),
      accuracy: p.coords.accuracy == null ? null : Math.round(p.coords.accuracy),
      at: new Date(p.timestamp || Date.now()).toISOString(),
    });
    let best = null;
    let sub = null;
    const position = await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        sub?.remove();
        resolve(best);
      };
      setTimeout(done, timeout);
      // A fix the phone took in the last few seconds (location sharing is
      // already watching) counts too.
      Location.getLastKnownPositionAsync({ maxAge: 5000 })
        .then((p) => {
          if (p && (!best || (p.coords.accuracy ?? Infinity) < (best.coords.accuracy ?? Infinity))) best = p;
          if (p && (p.coords.accuracy ?? Infinity) <= goodEnough) done();
        })
        .catch(() => {});
      Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 }, (p) => {
        if (!best || (p.coords.accuracy ?? Infinity) < (best.coords.accuracy ?? Infinity)) best = p;
        if ((p.coords.accuracy ?? Infinity) <= goodEnough) done();
      })
        .then((s) => {
          sub = s;
          if (settled) s.remove();
        })
        .catch(async () => {
          // Watching is not allowed everywhere: one reading at the highest accuracy instead.
          try {
            best = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
          } catch {
            /* best stays null */
          }
          done();
        });
    });

    if (!position) {
      return { ok: false, reason: 'timeout', message: 'Getting your location took too long.' };
    }
    return shape(position);
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: err.message || 'Location is unavailable.' };
  }
}

export const geoBody = (fix) =>
  fix?.ok
    ? { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy }
    : { latitude: null, longitude: null, accuracy: null };
