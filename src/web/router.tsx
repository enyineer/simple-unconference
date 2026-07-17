// Thin wrappers over wouter that keep the project's existing import surface
// stable. URLs are real paths (/conferences/<slug>/...) — the single SPA bundle
// is served for any path via the server's index.html fallback, and path-based
// routing is what lets each conference install as its own PWA (see AppRouter).
//
// New code should prefer wouter's hooks directly; `useRouteMatch` here is an
// alias kept around so existing callers don't churn. The component (<AppRouter>)
// lives in ./AppRouter to keep this file hooks-only — that's what makes
// react-refresh's only-export-components rule pass.

import type { MouseEvent } from "react";
import { useLocation } from "wouter";

export { useRoute as useRouteMatch } from "wouter";

// Compatibility shim for the project's pre-existing `useRoute()` shape:
// returns `{ path, navigate }`. New code should prefer `useLocation()` /
// wouter's `useRoute(pattern)` matcher instead.
export function useRoute(): { path: string; navigate: (to: string) => void } {
  const [path, setLocation] = useLocation();
  return { path, navigate: (to: string) => setLocation(to.startsWith("/") ? to : "/" + to) };
}

// Props for an internal SPA link rendered as a plain <a> (or the design-system
// <Link>). Under PATH routing a bare same-origin href would trigger a full page
// reload; this keeps a real `href` (so open-in-new-tab / middle-click / a11y
// work) but intercepts plain left-clicks and routes them through wouter for
// client-side navigation. Use for any in-app anchor that used to point at `#/…`.
export function useNavLink(): (href: string) => {
  href: string;
  onClick: (e: MouseEvent) => void;
} {
  const [, setLocation] = useLocation();
  return (href: string) => ({
    href,
    onClick: (e: MouseEvent) => {
      // Let the browser handle modified / non-primary clicks (new tab, etc.).
      if (
        e.defaultPrevented || e.button !== 0
        || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey
      ) return;
      e.preventDefault();
      setLocation(href);
    },
  });
}

// Compatibility shim for the project's pre-existing pure `matchRoute(pattern, path)`
// helper. Pure function — no router context required, safe to call outside
// React. Kept verbatim because callers (App.tsx) still use it for legacy
// route resolution; new routing should use wouter's <Route> / useRouteMatch.
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  // `path` is the pathname from wouter's location. Defensively strip any
  // `?query` / `#fragment` tail before segment matching so the last path segment
  // never carries a query string. `filter(Boolean)` below also drops the empty
  // trailing segment, so a canonical trailing slash (/conferences/foo/) matches.
  const queryIdx = path.search(/[?#]/);
  const cleanPath = queryIdx === -1 ? path : path.slice(0, queryIdx);
  const pParts = pattern.split("/").filter(Boolean);
  const aParts = cleanPath.split("/").filter(Boolean);
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
