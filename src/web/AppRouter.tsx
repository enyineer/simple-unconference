// The single component-export from the routing layer. Kept in its own file
// so `router.tsx` can stay purely non-component (hooks + helpers + re-exports)
// without tripping react-refresh/only-export-components.
//
// Uses wouter's DEFAULT (browser path) location — URLs are real paths
// (/conferences/<slug>/…), not hash fragments. That's what lets each conference
// install as its own PWA: the web app manifest's `scope` is path-based and the
// browser ignores the `#fragment`, so hash routing forced every conference to
// share one scope. Legacy `/#/…` links are migrated to paths at boot in
// client.tsx (see legacyHashToPath).

import { Router as WouterRouter } from "wouter";

export function AppRouter({ children }: { children: React.ReactNode }) {
  return <WouterRouter>{children}</WouterRouter>;
}
