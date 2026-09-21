/**
 * Browser geolocation with a bounded wait.
 *
 * Never rejects: a refused or unavailable fix is a normal outcome that the
 * clock-in flow has to handle, not an exception.
 */
export function getPosition({ timeout = 12000, highAccuracy = true } = {}) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      return resolve({ ok: false, reason: 'unsupported', message: 'This device cannot report its location.' });
    }
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    navigator.geolocation.getCurrentPosition(
      (pos) =>
        done({
          ok: true,
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
          accuracy: pos.coords.accuracy == null ? null : Math.round(pos.coords.accuracy),
          at: new Date(pos.timestamp).toISOString(),
        }),
      (err) => {
        const messages = {
          1: 'Location permission is blocked. Enable it for this site so your post can be verified.',
          2: 'Your location is unavailable right now. Move to an open area and try again.',
          3: 'Getting your location took too long.',
        };
        done({ ok: false, reason: err.code === 1 ? 'denied' : 'unavailable', message: messages[err.code] || err.message });
      },
      { enableHighAccuracy: highAccuracy, timeout, maximumAge: 15000 }
    );

    setTimeout(() => done({ ok: false, reason: 'timeout', message: 'Getting your location took too long.' }), timeout + 500);
  });
}

/** Shape a fix for the clock-in / check-in request bodies. */
export const geoBody = (fix) =>
  fix?.ok
    ? { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy }
    : { latitude: null, longitude: null, accuracy: null };
