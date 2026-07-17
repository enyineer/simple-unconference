// DOM glue that points the document's web app manifest + iOS home-screen icon
// links at the active conference (so an install lands inside it with its own
// icon), or restores the generic defaults when no conference is active. iOS
// uses apple-touch-icon — NOT manifest icons — for the Home Screen, so both
// links must update. Kept separate from App.tsx so the Settings "App icon"
// section can refresh the same links immediately after an upload/clear without
// waiting for the slug-keyed refetch in App. All URL shapes come from the
// pure, unit-tested builders in ./install.

import { appleTouchIconHref, manifestHref } from "./install";

export function updateInstallLinks(slug: string | null, iconHash: string | null): void {
  if (typeof document === "undefined") return;

  const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifestLink) {
    manifestLink.href = slug ? manifestHref(slug) : "/manifest.webmanifest";
  }

  let appleLink = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (!appleLink) {
    appleLink = document.createElement("link");
    appleLink.rel = "apple-touch-icon";
    document.head.appendChild(appleLink);
  }
  appleLink.href = slug ? appleTouchIconHref(slug, iconHash) : "/icon-192.png";
}
