// Pure, dependency-free decision logic for the per-conference PWA install
// affordance. The repo has no DOM/component test harness, so ALL the logic
// that decides *whether* and *what* to show — plus the URL builders that must
// stay byte-for-byte in lockstep with the server routes — lives here and is
// unit-tested (see install.test.ts). The hook + components in
// hooks/useInstallPrompt.ts and components/Install*.tsx are thin wrappers that
// only wire browser events and render; they carry no branching worth testing.

/** The states the install affordance can be in.
 *  - "prompt":       we captured `beforeinstallprompt` -> fire the native dialog.
 *  - "ios-hint":     iOS Safari -> show the Add-to-Home-Screen steps.
 *  - "manual":       a desktop browser that CAN install but didn't give us a
 *                    prompt (Chrome fires `beforeinstallprompt` only
 *                    heuristically) -> point at the browser's install control.
 *  - "firefox-hint": desktop Firefox, which can't install web apps at all ->
 *                    explain and point at Chrome/Edge/Safari. (Header button
 *                    only, not the proactive nudge — see shouldShowNudge.)
 *  - "none":         already installed, or a browser with no path we can help. */
export type InstallAffordance =
  | "prompt"
  | "ios-hint"
  | "manual"
  | "firefox-hint"
  | "none";

/**
 * Desktop browsers that can install/add a web app but do NOT reliably expose
 * `beforeinstallprompt`, so we guide the user to the browser's own control
 * instead of showing nothing: desktop Chromium (Chrome/Edge/Brave/Opera) and
 * desktop Safari ("Add to Dock", Sonoma+). Mobile is excluded — Android fires
 * the prompt, iOS is handled by `ios-hint` — and Firefox has no web-app install.
 */
export function canManualInstall(ua: string): boolean {
  if (/Android|iPhone|iPad|iPod/.test(ua)) return false;
  if (/Firefox/.test(ua)) return false;
  const chromium = /Chrome|Chromium|Edg|OPR/.test(ua);
  const desktopSafari = /Safari/.test(ua) && /Macintosh/.test(ua) && !/Chrome/.test(ua);
  return chromium || desktopSafari;
}

/**
 * Which desktop browser's install steps to show for the "manual" affordance.
 * Only meaningful when `canManualInstall(ua)` is true. Lets the hint show ONE
 * browser's exact steps (Chromium's address-bar / menu install, or Safari's
 * Add to Dock) instead of a confusing list of every browser.
 */
export function desktopInstallKind(ua: string): "chromium" | "safari" {
  return /Chrome|Chromium|Edg|OPR/.test(ua) ? "chromium" : "safari";
}

/**
 * Desktop Firefox — which can't install web apps at all. We can't help it
 * install, but we can explain (and point at a browser that can) instead of
 * showing nothing. Mobile Firefox is excluded (Android's menu can add to home
 * screen; not worth a separate flow here).
 */
export function isFirefoxDesktop(ua: string): boolean {
  return /Firefox/.test(ua) && !/Mobile|Android|iPhone|iPad|iPod/.test(ua);
}

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
 *  - iOS Safari, not installed -> the Add-to-Home-Screen hint.
 *  - a desktop browser that can install but gave us no prompt -> a "use your
 *    browser's install control" hint (Chrome's prompt is heuristic; this keeps
 *    an install path discoverable instead of showing nothing).
 *  - anything else (e.g. desktop Firefox) -> nothing.
 */
export function installAffordance(x: {
  standalone: boolean;
  hasInstallPrompt: boolean;
  isIos: boolean;
  canManualInstall: boolean;
  isFirefoxDesktop: boolean;
}): InstallAffordance {
  if (x.standalone) return "none";
  if (x.hasInstallPrompt) return "prompt";
  if (x.isIos) return "ios-hint";
  if (x.canManualInstall) return "manual";
  if (x.isFirefoxDesktop) return "firefox-hint";
  return "none";
}

/**
 * Whether the one-time nudge should show: only when there's an affordance that
 * actually leads to an install AND the user hasn't dismissed it on this device.
 * "firefox-hint" is excluded — we won't prominently nudge a Firefox user toward
 * something their browser can't do (the header button still offers the
 * explanation on demand).
 */
export function shouldShowNudge(x: {
  affordance: InstallAffordance;
  dismissed: boolean;
}): boolean {
  return x.affordance !== "none" && x.affordance !== "firefox-hint" && !x.dismissed;
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
