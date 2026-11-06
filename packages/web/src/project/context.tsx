// The open project: DTO + environments, my permissions (shared `can` list from the server), and one
// change-feed EventSource (ADR-022) that pages subscribe to.
import type { EnvironmentDto, FeedEventDto, MeDto, ProjectAction, ProjectDto } from '@euta-cloud/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, errorText } from '../api';

/** A change-feed event, or `resync` (history gone / reconnected far behind → reload everything). */
export type ProjectEvent = FeedEventDto | { kind: 'resync' };

/** The event's data (empty for `resync`). */
export const feedData = (e: ProjectEvent): Record<string, unknown> => ('data' in e ? e.data : {});

export interface ProjectCtx {
  project: ProjectDto;
  environments: EnvironmentDto[];
  me: MeDto;
  can: (a: ProjectAction) => boolean;
  /** Viewer (or read token): no edit / run controls. */
  readOnly: boolean;
  reload: () => Promise<void>;
  subscribe: (fn: (e: ProjectEvent) => void) => () => void;
}

const Ctx = createContext<ProjectCtx | null>(null);

export function useProject(): ProjectCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProject outside ProjectProvider');
  return v;
}

/** Run `fn` for every change-feed event of the open project (latest `fn` wins, no resubscribe). */
export function useProjectEvents(fn: (e: ProjectEvent) => void) {
  const { subscribe } = useProject();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

/** Feed kinds that change what the shell holds (project settings, environments, members). */
const SHELL_KINDS = /^(project\.|environment\.|credential\.|member\.|access\.)/;

export function ProjectProvider({ id, me, children, fallback }: { id: string; me: MeDto; children: ReactNode; fallback: (state: { error: string | null; notFound: boolean }) => ReactNode }) {
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const subs = useRef(new Set<(e: ProjectEvent) => void>());

  const reload = useCallback(async () => {
    try {
      const [p, e] = await Promise.all([
        api<ProjectDto>('GET', `/api/projects/${encodeURIComponent(id)}`),
        api<{ environments: EnvironmentDto[] }>('GET', `/api/projects/${encodeURIComponent(id)}/environments`),
      ]);
      setProject(p);
      setEnvironments(e.environments);
      setError(null);
    } catch (err) {
      // 404 = deleted, or no longer visible (members-only / removed) → drop the loaded project.
      if (err instanceof ApiError && err.status === 404) {
        setProject(null);
        setNotFound(true);
      }
      else setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    setProject(null);
    setNotFound(false);
    void reload();
  }, [reload]);

  useEffect(() => {
    const es = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
    const emit = (e: ProjectEvent) => {
      if (e.kind === 'resync' || SHELL_KINDS.test(e.kind)) void reload();
      for (const fn of subs.current) fn(e);
    };
    es.addEventListener('change', (m) => {
      try {
        emit(JSON.parse((m as MessageEvent<string>).data) as FeedEventDto);
      } catch {
        /* malformed line: ignore */
      }
    });
    es.addEventListener('resync', () => emit({ kind: 'resync' }));
    // The server ends the stream when I can no longer see the project (stage 15).
    es.addEventListener('access_lost', () => {
      es.close();
      void reload();
    });
    return () => es.close();
  }, [id, reload]);

  const subscribe = useCallback((fn: (e: ProjectEvent) => void) => {
    subs.current.add(fn);
    return () => void subs.current.delete(fn);
  }, []);

  if (!project) return <>{fallback({ error, notFound })}</>;
  const allowed = new Set(project.can ?? []);
  const can = (a: ProjectAction) => allowed.has(a);
  return <Ctx.Provider value={{ project, environments, me, can, readOnly: !can('script.edit'), reload, subscribe }}>{children}</Ctx.Provider>;
}
