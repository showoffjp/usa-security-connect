import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, tokenStore, deviceId, subscribeUnauthorized } from './api.js';
import { ROLES, atLeast } from './shared.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [mustChangePin, setMustChangePin] = useState(false);
  const [loading, setLoading] = useState(true);

  const clear = useCallback(async () => {
    await tokenStore.set(null);
    setUser(null);
    setMustChangePin(false);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const token = await tokenStore.get();
      if (!token) {
        if (alive) setLoading(false);
        return;
      }
      try {
        const me = await api.get('/auth/me');
        if (!alive) return;
        setUser(me.user);
        setMustChangePin(me.mustChangePin);
      } catch {
        if (alive) await clear();
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [clear]);

  useEffect(() => subscribeUnauthorized(() => clear()), [clear]);

  const signIn = useCallback(async (employeeCode, pin) => {
    const res = await api.post('/auth/login', {
      employeeCode,
      pin,
      deviceId: await deviceId(),
    });
    await tokenStore.set(res.token);
    setUser(res.user);
    setMustChangePin(res.mustChangePin);
    return res;
  }, []);

  const changePin = useCallback(async (currentPin, newPin, confirmPin) => {
    const res = await api.post('/auth/change-pin', { currentPin, newPin, confirmPin });
    await tokenStore.set(res.token);
    setUser(res.user);
    setMustChangePin(false);
    return res;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* clearing locally is what matters */
    }
    await clear();
  }, [clear]);

  const value = useMemo(
    () => ({
      user,
      loading,
      mustChangePin,
      signIn,
      signOut,
      changePin,
      isSupervisor: user ? atLeast(user.role, ROLES.SUPERVISOR) : false,
      isAdmin: user ? atLeast(user.role, ROLES.ADMIN) : false,
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
