// The single component-export from the routing layer. Kept in its own file
// so `router.tsx` can stay purely non-component (hooks + helpers + re-exports)
// without tripping react-refresh/only-export-components.

import { Router as WouterRouter } from "wouter";
import { useHashLocation } from "./router";

// Re-export the wouter <Router> with a friendlier alias so client.tsx's wrap is
// readable: `<HashRouter>...</HashRouter>` instead of `<Router hook={...}>`.
export function HashRouter({ children }: { children: React.ReactNode }) {
  return <WouterRouter hook={useHashLocation}>{children}</WouterRouter>;
}
