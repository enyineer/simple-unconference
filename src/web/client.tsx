import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppRouter } from "./AppRouter";
import { legacyHashToPath } from "./pwa/legacyRoute";

// Back-compat: the app moved from hash routing to real paths. Migrate any
// incoming legacy `/#/…` URL (old bookmarks, already-sent verify/reset emails,
// existing push CTAs, shared board links) to its path form BEFORE React mounts,
// so wouter reads the right route on first render. No-op for path URLs.
const migrated = legacyHashToPath(window.location.hash, window.location.search);
if (migrated) history.replaceState(null, "", migrated);

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");
createRoot(root).render(
  <StrictMode>
    <AppRouter>
      <App />
    </AppRouter>
  </StrictMode>,
);

// Offline-ready PWA (prod only — dev relies on Vite's own dev server, and a
// registered SW there would fight its HMR fetches). Silent failure: this is
// a resilience nicety, not something that should ever surface an error to
// the user.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
