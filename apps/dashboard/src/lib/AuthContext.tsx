import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { api, ApiRequestError } from './api';
import type { Limits, User } from './types';

interface AuthState {
  user: User | null;
  limits: Limits | null;
  /** Tokens consumed today, used for quota progress in Settings. */
  tokensToday: number;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [tokensToday, setTokensToday] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.me();
      setUser(res.user);
      setLimits(res.limits);
      setTokensToday(res.usage?.tokensToday ?? 0);
    } catch (err) {
      // A 401 here is the normal signed-out case, not an error worth showing.
      if (!(err instanceof ApiRequestError) || err.status !== 401) {
        console.warn('Session check failed', err);
      }
      setUser(null);
      setLimits(null);
      setTokensToday(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const value = useMemo<AuthState>(() => ({
    user,
    limits,
    tokensToday,
    loading,
    login: async (email, password) => {
      await api.login({ email, password });
      await load();
    },
    register: async (name, email, password) => {
      await api.register({ name, email, password });
      await load();
    },
    logout: async () => {
      try { await api.logout(); } finally { setUser(null); setLimits(null); setTokensToday(0); }
    },
    refresh: load,
  }), [user, limits, tokensToday, loading, load]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
