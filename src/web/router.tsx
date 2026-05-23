// Thin wrappers over wouter that keep the project's existing import surface
// stable. URLs use the hash-fragment form (#/conferences/<slug>/...) — single
// SPA bundle, no server-side routing config, works under any path / domain.
//
// New code should prefer wouter's hooks directly; `useRouteMatch` here is an
// alias kept around so existing callers don't churn. The component (<HashRouter>)
// lives in ./HashRouter to keep this file hooks-only — that's what makes
// react-refresh's only-export-components rule pass.

import { useLocation } from "wouter";
import { useHashLocation as wouterUseHashLocation } from "wouter/use-hash-location";

export { useRoute as useRouteMatch } from "wouter";

// Use this as the outermost <Router hook={useHashLocation}> in App.tsx so
// every hook reads from the URL hash, not the pathname.
export const useHashLocation = wouterUseHashLocation;

// Compatibility shim for the project's pre-existing `useRoute()` shape:
// returns `{ path, navigate }`. New code should prefer `useLocation()` /
// wouter's `useRoute(pattern)` matcher instead.
export function useRoute(): { path: string; navigate: (to: string) => void } {
  const [path, setLocation] = useLocation();
  return { path, navigate: (to: string) => setLocation(to.startsWith("/") ? to : "/" + to) };
}

// Compatibility shim for the project's pre-existing pure `matchRoute(pattern, path)`
// helper. Pure function — no router context required, safe to call outside
// React. Kept verbatim because callers (App.tsx) still use it for legacy
// route resolution; new routing should use wouter's <Route> / useRouteMatch.
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  // wouter's useHashLocation returns the full hash payload, including any
  // `?query` / `#fragment` tail (e.g. `/c/foo/join?t=...`). Strip those before
  // segment matching so the last path segment doesn't carry the query string.
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
