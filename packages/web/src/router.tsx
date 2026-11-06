// A tiny history router: path + query, `:param` / trailing `*` patterns, and a leave guard for unsaved
// edits (ADR-019 결과 C4 — kept instead of react-router; the route table is small and flat).
import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export interface Loc {
  path: string;
  query: URLSearchParams;
  /** path + search, for `next=` links. */
  href: string;
}

const current = (): Loc => ({ path: window.location.pathname, query: new URLSearchParams(window.location.search), href: window.location.pathname + window.location.search });

/** Returns false to keep the current page (e.g. "저장하지 않은 변경" declined). */
let leaveGuard: (() => boolean) | null = null;

/** Install a guard asked before every in-app navigation and on tab close; returns the remover. */
export function setLeaveGuard(guard: (() => boolean) | null): () => void {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}

/** True when there is no guard or the guard lets the user leave. */
export const mayLeave = (): boolean => !leaveGuard || leaveGuard();

export function navigate(to: string, opts: { replace?: boolean; force?: boolean } = {}) {
  if (!opts.force && to !== window.location.pathname + window.location.search && !mayLeave()) return;
  if (opts.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useLocation(): Loc {
  const [loc, setLoc] = useState(current);
  useEffect(() => {
    const on = () => setLoc(current());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return loc;
}

/**
 * Match `/projects/:id/runs/:runId` style patterns; a trailing `*` captures the rest (decoded per
 * segment, `/` kept — script paths). Returns the params or null.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const ps = pattern.split('/').filter(Boolean);
  const xs = path.split('/').filter(Boolean);
  const out: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (p === '*') {
      if (i >= xs.length) return null;
      out['*'] = xs.slice(i).map(safeDecode).join('/');
      return out;
    }
    const x = xs[i];
    if (x === undefined) return null;
    if (p.startsWith(':')) out[p.slice(1)] = safeDecode(x);
    else if (p !== x) return null;
  }
  return xs.length === ps.length ? out : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Encode a script path for a URL: each segment encoded, `/` kept. */
export const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

/** Only same-site paths are allowed as a post-login destination. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={click} {...rest} />;
}
