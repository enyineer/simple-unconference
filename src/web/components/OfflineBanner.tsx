// Slim fixed banner telling the user they're viewing the last data the app
// loaded before the network dropped. Venue wifi is flaky and a silently
// stale view is worse than an honest note. Pure lens over the browser's
// online/offline events — no polling, no fetch probing, no state library.
// Mounted once at the App shell level (see App.tsx).

import { useEffect, useInsertionEffect, useState } from "react";

const STYLE_ID = "uncon-offline-banner";
const bannerCss = `
.uncon-offline-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  display: flex;
  justify-content: center;
  padding: 8px 16px;
  padding-top: max(8px, env(safe-area-inset-top));
  font-size: 13px;
  font-weight: 500;
  text-align: center;
  background: var(--bgColor-attention-muted, rgba(187,128,9,0.16));
  color: var(--fgColor-attention, var(--uncon-warning, #9a6700));
  border-bottom: 1px solid var(--fgColor-attention, var(--uncon-warning, #9a6700));
  transform: translateY(-100%);
  opacity: 0;
  transition: transform 220ms ease, opacity 220ms ease;
  pointer-events: none;
}
.uncon-offline-banner.is-visible {
  transform: translateY(0);
  opacity: 1;
  pointer-events: auto;
}
`;

function useBannerStyles() {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = bannerCss;
    document.head.appendChild(el);
  }, []);
}

export function OfflineBanner() {
  useBannerStyles();
  const [online, setOnline] = useState(
    () => (typeof navigator === "undefined" ? true : navigator.onLine),
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return (
    <div
      className={`uncon-offline-banner${online ? "" : " is-visible"}`}
      role="status"
      aria-live="polite"
    >
      Offline - showing the last loaded data.
    </div>
  );
}
