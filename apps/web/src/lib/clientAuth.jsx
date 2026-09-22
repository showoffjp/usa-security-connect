import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clientApi, clientTokenStore, subscribeUnauthorized } from './api.js';

const ClientAuthContext = createContext(null);

/** Session state for a client contact. Separate from the staff AuthProvider. */
export function ClientAuthProvider({ children }) {
  const [client, setClient] = useState(null);
  const [sites, setSites] = useState([]);
  // A contact whose account exists but has no sites linked yet gets a 403 with
  // an explanation. Signing them out would hide it behind a form that works.
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const signOutLocal = useCallback(() => {
    clientTokenStore.set(null);
    setClient(null);
    setSites([]);
    setNotice('');
  }, []);

  /** Load the account and its sites, tolerating the no-sites case. */
  const loadMe = useCallback(async (fallbackClient = null) => {
    try {
      const me = await clientApi.get('/client/me');
      setClient(me.client);
      setSites(me.sites);
      setNotice('');
      return me;
    } catch (err) {
      if (err.status === 403) {
        setClient(fallbackClient ?? { name: 'Your account', company: null });
        setSites([]);
        setNotice(err.message);
        return null;
      }
      throw err;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!clientTokenStore.get()) {
        setLoading(false);
        return;
      }
      try {
        await loadMe();
      } catch {
        if (!cancelled) signOutLocal();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe, signOutLocal]);

  useEffect(
    () => subscribeUnauthorized((store) => (store === clientTokenStore ? signOutLocal() : undefined)),
    [signOutLocal]
  );

  const signIn = useCallback(
    async (email, password) => {
      const res = await clientApi.post('/client/login', { email, password });
      clientTokenStore.set(res.token);
      await loadMe(res.client);
      return res;
    },
    [loadMe]
  );

  const changePassword = useCallback(async (currentPassword, newPassword, confirmPassword) => {
    const res = await clientApi.post('/client/change-password', {
      currentPassword,
      newPassword,
      confirmPassword,
    });
    // The server retires the old token on a password change, so swap it in.
    clientTokenStore.set(res.token);
    return res;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await clientApi.post('/client/logout');
    } catch {
      /* signing out locally matters more than telling the server */
    }
    signOutLocal();
  }, [signOutLocal]);

  const value = useMemo(
    () => ({ client, sites, notice, loading, signIn, signOut, changePassword }),
    [client, sites, notice, loading, signIn, signOut, changePassword]
  );

  return <ClientAuthContext.Provider value={value}>{children}</ClientAuthContext.Provider>;
}

export function useClientAuth() {
  const ctx = useContext(ClientAuthContext);
  if (!ctx) throw new Error('useClientAuth must be used inside <ClientAuthProvider>');
  return ctx;
}
