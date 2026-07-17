// DOM glue that makes the document installable as an app ONLY while inside a
// conference. Installing means installing a specific conference — the root
// (landing / dashboard) is deliberately not a PWA (a generic "install the
// dashboard" prompt is useless and would confuse a visitor on the landing
// page). So the <link rel="manifest"> + iOS apple-touch-icon are ADDED when a
// conference is active (pointing at that conference's manifest + icon) and
// REMOVED when it isn't. iOS uses apple-touch-icon — NOT manifest icons — for
// the Home Screen, so both are managed together. The service worker (offline)
// is registered app-wide and is unaffected by this. All URL shapes come from
// the pure, unit-tested builders in ./install.
//
// Kept separate from App.tsx so the Settings "App icon" section can refresh the
// same links immediately after an upload/clear without waiting for a refetch.

import { appleTouchIconHref, manifestHref } from "./install";

function ensureLink(rel: string): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  return link;
}

function removeLink(rel: string): void {
  document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)?.remove();
}

export function updateInstallLinks(slug: string | null, iconHash: string | null): void {
  if (typeof document === "undefined") return;

  if (!slug) {
    // Root / no conference: not an installable app.
    removeLink("manifest");
    removeLink("apple-touch-icon");
    return;
  }

  ensureLink("manifest").href = manifestHref(slug);
  ensureLink("apple-touch-icon").href = appleTouchIconHref(slug, iconHash);
}
