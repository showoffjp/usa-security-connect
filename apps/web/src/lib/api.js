/** Thin API client. Attaches the bearer token and normalises server errors. */

const TOKEN_KEY = 'usc.token';
const BASE = import.meta.env.VITE_API_URL || '/api';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t) => {
    try {
      t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private browsing - the session simply will not persist */
    }
  },
};

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
  /** Turn a 422 payload into { fieldName: message } for inline form errors. */
  get fieldErrors() {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries(this.details.map((d) => [d.field, d.message]));
  }
}

/** Fired when the server rejects our token so the app can bounce to sign-in. */
const onUnauthorized = new Set();
export const subscribeUnauthorized = (fn) => {
  onUnauthorized.add(fn);
  return () => onUnauthorized.delete(fn);
};

export async function request(path, { method = 'GET', body, formData, signal } = {}) {
  const token = tokenStore.get();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: formData ?? (body ? JSON.stringify(body) : undefined),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }

  if (res.status === 204) return null;

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    if (res.status === 401 && token) {
      tokenStore.set(null);
      onUnauthorized.forEach((fn) => fn());
    }
    throw new ApiError(
      res.status,
      (payload && payload.error) || `Request failed (${res.status}).`,
      payload?.details
    );
  }
  return payload;
}

export const api = {
  get: (p, opts) => request(p, opts),
  post: (p, body, opts) => request(p, { ...opts, method: 'POST', body }),
  patch: (p, body, opts) => request(p, { ...opts, method: 'PATCH', body }),
  del: (p, opts) => request(p, { ...opts, method: 'DELETE' }),
  upload: (p, formData) => request(p, { method: 'POST', formData }),
};
