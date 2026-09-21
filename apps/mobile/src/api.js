import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const TOKEN_KEY = 'usc_token';
const DEVICE_KEY = 'usc_device';

/**
 * Where the API lives.
 *
 * The Android emulator reaches the host machine on 10.0.2.2 rather than
 * localhost, so the default in app.json uses that; point `apiUrl` at your
 * real server before shipping a build.
 */
export const API_BASE =
  process.env.EXPO_PUBLIC_API_URL ||
  Constants.expoConfig?.extra?.apiUrl ||
  (Platform.OS === 'android' ? 'http://10.0.2.2:4000/api' : 'http://localhost:4000/api');

/** The token is a credential, so it lives in the OS keystore, not AsyncStorage. */
export const tokenStore = {
  get: async () => {
    try {
      return await SecureStore.getItemAsync(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: async (token) => {
    try {
      if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
      else await SecureStore.deleteItemAsync(TOKEN_KEY);
    } catch {
      /* keystore unavailable - the session just will not survive a restart */
    }
  },
};

export async function deviceId() {
  try {
    let id = await SecureStore.getItemAsync(DEVICE_KEY);
    if (!id) {
      id = `${Platform.OS}-${Math.random().toString(36).slice(2, 12)}`;
      await SecureStore.setItemAsync(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return `${Platform.OS}-unknown`;
  }
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
  get fieldErrors() {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries(this.details.map((d) => [d.field, d.message]));
  }
}

const unauthorizedHandlers = new Set();
export const subscribeUnauthorized = (fn) => {
  unauthorizedHandlers.add(fn);
  return () => unauthorizedHandlers.delete(fn);
};

export async function request(path, { method = 'GET', body, formData } = {}) {
  const token = await tokenStore.get();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: formData ?? (body ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your signal and try again.');
  }

  if (res.status === 204) return null;

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    if (res.status === 401 && token) {
      await tokenStore.set(null);
      unauthorizedHandlers.forEach((fn) => fn());
    }
    throw new ApiError(res.status, payload?.error || `Request failed (${res.status}).`, payload?.details);
  }
  return payload;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p) => request(p, { method: 'DELETE' }),
  upload: (p, formData) => request(p, { method: 'POST', formData }),
};
