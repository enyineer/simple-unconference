import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { HashRouter } from "./HashRouter";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");
createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
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
