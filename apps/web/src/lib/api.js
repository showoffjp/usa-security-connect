/** Thin API client. Attaches the bearer token and normalises server errors. */

const BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * Staff and client contacts are separate identities with separate tokens, and
 * one browser may well hold both - an account manager checking what a client
 * sees. Two stores under two keys keeps signing out of one from signing out
 * of the other.
 */
function makeTokenStore(key) {
  return {
    get: () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (t) => {
      try {
        t ? localStorage.setItem(key, t) : localStorage.removeItem(key);
      } catch {
        /* private browsing - the session simply will not persist */
      }
    },
  };
}

export const tokenStore = makeTokenStore('usc.token');
export const clientTokenStore = makeTokenStore('usc.client.token');

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

/**
 * Fired when the server rejects our token so the app can bounce to sign-in.
 * Handlers are told which store was rejected, so the client portal's 401 does
 * not sign a staff user out of the console in another tab.
 */
const onUnauthorized = new Set();
export const subscribeUnauthorized = (fn) => {
  onUnauthorized.add(fn);
  return () => onUnauthorized.delete(fn);
};

export async function request(
  path,
  { method = 'GET', body, formData, signal, store = tokenStore, raw = false } = {}
) {
  const token = store.get();
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

  // An <img src> cannot carry a bearer token, so a caller wanting a file that
  // sits behind auth asks for the bytes and makes its own object URL.
  if (raw && res.ok) return res.blob();

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    if (res.status === 401 && token) {
      store.set(null);
      onUnauthorized.forEach((fn) => fn(store));
    }
    throw new ApiError(
      res.status,
      (payload && payload.error) || `Request failed (${res.status}).`,
      payload?.details
    );
  }
  return payload;
}

function makeApi(store) {
  return {
    get: (p, opts) => request(p, { ...opts, store }),
    post: (p, body, opts) => request(p, { ...opts, store, method: 'POST', body }),
    patch: (p, body, opts) => request(p, { ...opts, store, method: 'PATCH', body }),
    del: (p, opts) => request(p, { ...opts, store, method: 'DELETE' }),
    upload: (p, formData) => request(p, { store, method: 'POST', formData }),
  };
}

export const api = makeApi(tokenStore);

/** The same client, pointed at the portal's own token. */
export const clientApi = makeApi(clientTokenStore);

/**
 * Save a file that sits behind staff auth. A plain link cannot carry the
 * bearer token, so the bytes are fetched and handed over as a blob.
 */
export async function downloadFile(path, filename) {
  const blob = await request(path, { raw: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
