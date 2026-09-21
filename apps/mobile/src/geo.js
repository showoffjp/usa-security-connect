import * as Location from 'expo-location';

/**
 * Native GPS fix. Never rejects - a refused permission is an outcome the
 * clock-in flow handles, not an exception.
 */
export async function getPosition({ timeout = 12000 } = {}) {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      return {
        ok: false,
        reason: 'denied',
        message: 'Location permission is off. Turn it on so your post can be verified.',
      };
    }

    const position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
    ]);

    if (!position) {
      return { ok: false, reason: 'timeout', message: 'Getting your location took too long.' };
    }

    return {
      ok: true,
      latitude: Number(position.coords.latitude.toFixed(6)),
      longitude: Number(position.coords.longitude.toFixed(6)),
      accuracy: position.coords.accuracy == null ? null : Math.round(position.coords.accuracy),
    };
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: err.message || 'Location is unavailable.' };
  }
}

export const geoBody = (fix) =>
  fix?.ok
    ? { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy }
    : { latitude: null, longitude: null, accuracy: null };
