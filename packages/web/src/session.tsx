// Who is signed in (`GET /api/me`), shared by every page. `undefined` = still loading, `null` = signed out.
import type { MeDto, ServerConfigDto } from '@euta-cloud/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { navigate, useLocation } from './router';

interface SessionValue {
  me: MeDto | null | undefined;
  refresh: () => Promise<MeDto | null>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeDto | null | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      const m = await api<MeDto>('GET', '/api/me');
      setMe(m);
      return m;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        return null;
      }
      throw e;
    }
  }, []);
  const signOut = useCallback(async () => {
    await api('POST', '/api/auth/sign-out', {});
    setMe(null);
    navigate('/login');
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <SessionContext.Provider value={{ me, refresh, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Renders children only for a signed-in user; otherwise goes to the login page and comes back. */
export function RequireLogin({ children }: { children: (me: MeDto) => ReactNode }) {
  const { me } = useSession();
  const loc = useLocation();
  useEffect(() => {
    if (me === null) navigate(`/login?next=${encodeURIComponent(loc.href)}`, { replace: true });
  }, [me, loc.href]);
  if (!me) return <p className="muted">불러오는 중…</p>;
  return <>{children(me)}</>;
}

let serverConfig: Promise<ServerConfigDto | null> | null = null;

/** Public server config (`GET /api/config`), fetched once per page load. `undefined` = loading, `null` = unavailable. */
export function useServerConfig(): ServerConfigDto | null | undefined {
  const [config, setConfig] = useState<ServerConfigDto | null | undefined>(undefined);
  useEffect(() => {
    serverConfig ??= api<ServerConfigDto>('GET', '/api/config').catch(() => null);
    let live = true;
    void serverConfig.then((c) => live && setConfig(c));
    return () => {
      live = false;
    };
  }, []);
  return config;
}
