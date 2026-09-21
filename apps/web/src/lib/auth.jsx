import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, tokenStore, subscribeUnauthorized } from './api.js';
import { ROLES, atLeast } from '@shared/domain.js';

const AuthContext = createContext(null);

/** A stable per-browser identifier, recorded with each clock event. */
function deviceId() {
  const KEY = 'usc.device';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 20);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'unknown-device';
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [mustChangePin, setMustChangePin] = useState(false);
  const [loading, setLoading] = useState(true);

  const signOutLocal = useCallback(() => {
    tokenStore.set(null);
    setUser(null);
    setMustChangePin(false);
  }, []);

  // Restore the session on first load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tokenStore.get()) {
        setLoading(false);
        return;
      }
      try {
        const me = await api.get('/auth/me');
        if (cancelled) return;
        setUser(me.user);
        setMustChangePin(me.mustChangePin);
      } catch {
        if (!cancelled) signOutLocal();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signOutLocal]);

  // If any request comes back 401, drop straight to the sign-in screen.
  useEffect(() => subscribeUnauthorized(signOutLocal), [signOutLocal]);

  const signIn = useCallback(async (employeeCode, pin) => {
    const res = await api.post('/auth/login', { employeeCode, pin, deviceId: deviceId() });
    tokenStore.set(res.token);
    setUser(res.user);
    setMustChangePin(res.mustChangePin);
    return res;
  }, []);

  const changePin = useCallback(async (currentPin, newPin, confirmPin) => {
    const res = await api.post('/auth/change-pin', { currentPin, newPin, confirmPin });
    tokenStore.set(res.token);
    setUser(res.user);
    setMustChangePin(false);
    return res;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* signing out locally matters more than telling the server */
    }
    signOutLocal();
  }, [signOutLocal]);

  const value = useMemo(
    () => ({
      user,
      loading,
      mustChangePin,
      signIn,
      signOut,
      changePin,
      deviceId: deviceId(),
      isAdmin: user ? atLeast(user.role, ROLES.ADMIN) : false,
      isSupervisor: user ? atLeast(user.role, ROLES.SUPERVISOR) : false,
    }),
    [user, loading, mustChangePin, signIn, signOut, changePin]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
