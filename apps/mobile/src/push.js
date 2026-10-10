import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { api, deviceId } from './api.js';
import { C } from './theme.js';

/** Alerts an officer on post must actually see, so they surface in-app too. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // Shown while the app is open too: a call or a chase needs seeing on post.
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

let registeredToken = null;

/**
 * Ask for permission, get an Expo push token, and hand it to the API.
 *
 * Returns a plain result rather than throwing: push is a nice-to-have, and an
 * officer who declines notifications must still be able to work the shift.
 */
export async function registerForPush() {
  try {
    // Android needs its channels declared before any notification arrives.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'General',
        importance: Notifications.AndroidImportance.DEFAULT,
        lightColor: C.brand600,
      });
      await Notifications.setNotificationChannelAsync('urgent', {
        name: 'Urgent alerts',
        description: 'Status check-ins and urgent broadcasts.',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: C.brand600,
        sound: 'default',
      });
    }

    // A simulator cannot receive push, so there is nothing to register.
    if (!Device.isDevice) return { ok: false, reason: 'simulator' };

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return { ok: false, reason: 'denied' };

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;

    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );

    if (token === registeredToken) return { ok: true, token, cached: true };

    await api.post('/devices/register', {
      token,
      platform: Platform.OS,
      deviceId: await deviceId(),
    });
    registeredToken = token;
    return { ok: true, token };
  } catch (err) {
    // Most often: no projectId configured yet, or offline. Neither is fatal.
    console.warn('[usc] push registration skipped:', err.message);
    return { ok: false, reason: 'error', message: err.message };
  }
}

/** Called on sign-out so the next officer on this phone does not get their alerts. */
export async function unregisterPush() {
  if (!registeredToken) return;
  try {
    await api.post('/devices/unregister', { token: registeredToken });
  } catch {
    /* the server drops dead tokens on its own when delivery fails */
  }
  registeredToken = null;
}

/**
 * Route a tapped notification to the right screen.
 * Returns the path, or null when the payload is not something we navigate to.
 */
export function pathForNotification(data) {
  if (!data) return null;
  switch (data.type) {
    case 'check_in':
    case 'call':
    case 'vehicle':
    case 'handover':
    case 'shift_offer':
      // A call sent to the officer, or a shift they are asked to cover, sits on the home screen.
      return '/';
    case 'attendance':
      // A late start or no-show, for a supervisor.
      return '/late';
    case 'broadcast':
      return '/updates';
    case 'message':
      return data.threadId ? `/thread/${data.threadId}` : '/updates';
    case 'flag':
    case 'correction':
    case 'confirm':
      return '/schedule';
    default:
      return null;
  }
}

export { Notifications };
