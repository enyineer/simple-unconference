// Tiny hash-based router. URLs look like #/conferences/my-conf.
// Keeps the bundle small and avoids extra dependencies for a small SPA.

import { useEffect, useState, useCallback } from "react";

export function useRoute(): { path: string; navigate: (to: string) => void } {
  const [path, setPath] = useState(() => parseHash());
  useEffect(() => {
    const onChange = () => setPath(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((to: string) => {
    const normalized = to.startsWith("/") ? to : "/" + to;
    if (window.location.hash !== "#" + normalized) {
      window.location.hash = normalized;
    }
  }, []);
  return { path, navigate };
}

function parseHash(): string {
  const h = window.location.hash;
  if (!h || h === "#") return "/";
  const stripped = h.startsWith("#") ? h.slice(1) : h;
  // Strip the query string so route matching sees only the path segments.
  // Pages that need query params (e.g. JoinPage's `?t=<token>`) read them
  // straight from `window.location.hash`.
  const qIdx = stripped.indexOf("?");
  return qIdx === -1 ? stripped : stripped.slice(0, qIdx);
}

/**
 * Match a route pattern like "/conferences/:slug/agenda" against `path`.
 * Returns { params } on a match, null on miss.
 */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const pParts = pattern.split("/").filter(Boolean);
  const aParts = path.split("/").filter(Boolean);
  if (pParts.length !== aParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pParts.length; i++) {
    const p = pParts[i]!;
    const a = aParts[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(a);
    else if (p !== a) return null;
  }
  return params;
}
