// Pure, dependency-free decision logic for the per-conference PWA install
// affordance. The repo has no DOM/component test harness, so ALL the logic
// that decides *whether* and *what* to show — plus the URL builders that must
// stay byte-for-byte in lockstep with the server routes — lives here and is
// unit-tested (see install.test.ts). The hook + components in
// hooks/useInstallPrompt.ts and components/Install*.tsx are thin wrappers that
// only wire browser events and render; they carry no branching worth testing.

/** The three states the install affordance can be in. */
export type InstallAffordance = "prompt" | "ios-hint" | "none";

/**
 * True for iPhone/iPad Safari (the only browsers where "Add to Home Screen"
 * is the install path). False for Chrome-on-iOS (CriOS), Firefox-on-iOS
 * (FxiOS), Android, and desktop — those either fire `beforeinstallprompt`
 * (handled elsewhere) or have no per-site install at all.
 *
 * iPadOS 13+ reports a desktop-Mac UA, so we also treat a "Macintosh" UA that
 * exposes multi-touch as an iPad — but that touch check can't be done from the
 * UA string alone, so callers pass the already-touch-detected iPad case via
 * the raw UA when it still contains "iPad". Here we match the UA text only.
 */
export function isIosSafari(ua: string): boolean {
  const isIosDevice = /iPhone|iPad|iPod/.test(ua);
  if (!isIosDevice) return false;
  // Exclude the non-Safari iOS browsers, which all ship their own engine-
  // labelled UA token. They can't install to the Home Screen.
  if (/CriOS|FxiOS|EdgiOS|OPiOS|mercury/.test(ua)) return false;
  // Genuine iOS Safari always carries "Safari" in the UA.
  return /Safari/.test(ua);
}

/**
 * Which affordance to surface, given the runtime facts:
 *  - already running standalone (installed) -> nothing to offer.
 *  - a `beforeinstallprompt` event was captured -> the native prompt.
 *  - iOS Safari, not installed -> the manual Add-to-Home-Screen hint.
 *  - anything else (e.g. Firefox/desktop with no captured prompt) -> nothing.
 */
export function installAffordance(x: {
  standalone: boolean;
  hasInstallPrompt: boolean;
  isIos: boolean;
}): InstallAffordance {
  if (x.standalone) return "none";
  if (x.hasInstallPrompt) return "prompt";
  if (x.isIos) return "ios-hint";
  return "none";
}

/**
 * Whether the one-time nudge should show: only when there's actually an
 * affordance to act on AND the user hasn't dismissed it on this device.
 */
export function shouldShowNudge(x: {
  affordance: InstallAffordance;
  dismissed: boolean;
}): boolean {
  return x.affordance !== "none" && !x.dismissed;
}

// --- URL builders ---------------------------------------------------------
// These MUST match the server routes exactly (routes/manifest.ts +
// routes/conference-icons.ts). Duplicating them here (rather than importing
// server code into the browser bundle) keeps the client link + server route
// in lockstep via the shared unit tests.

/** The per-conference web app manifest URL. */
export function manifestHref(slug: string): string {
  return `/api/manifest/${slug}.webmanifest`;
}

/** A conference icon URL at a given size, cache-busted by the content hash. */
export function confIconHref(slug: string, size: 192 | 512, hash: string): string {
  return `/api/conference-icons/${slug}/${size}/${hash}`;
}

/**
 * The apple-touch-icon href: the conference's custom 192px icon when it has
 * one, else the built-in default. iOS uses this (NOT manifest icons) for the
 * Home Screen icon, so it has to be set independently of the manifest.
 */
export function appleTouchIconHref(slug: string, hash: string | null): string {
  return hash ? confIconHref(slug, 192, hash) : "/icon-192.png";
}
