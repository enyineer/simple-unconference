import { describe, expect, test } from "bun:test";
import {
  appleTouchIconHref,
  confIconHref,
  installAffordance,
  isIosSafari,
  manifestHref,
  shouldShowNudge,
} from "./install";

// Representative real UA strings. Kept literal so a regression in isIosSafari
// shows up against the actual browser strings we mean to (not) match.
const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  firefoxIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  desktopChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  desktopSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
} as const;

describe("isIosSafari", () => {
  test("true for iPhone Safari", () => {
    expect(isIosSafari(UA.iphoneSafari)).toBe(true);
  });
  test("true for iPad Safari", () => {
    expect(isIosSafari(UA.ipadSafari)).toBe(true);
  });
  test("false for Chrome on iOS (CriOS)", () => {
    expect(isIosSafari(UA.chromeIos)).toBe(false);
  });
  test("false for Firefox on iOS (FxiOS)", () => {
    expect(isIosSafari(UA.firefoxIos)).toBe(false);
  });
  test("false for Android Chrome", () => {
    expect(isIosSafari(UA.androidChrome)).toBe(false);
  });
  test("false for desktop Chrome (Mac)", () => {
    expect(isIosSafari(UA.desktopChrome)).toBe(false);
  });
  test("false for desktop Safari (Mac, not an iOS device)", () => {
    expect(isIosSafari(UA.desktopSafari)).toBe(false);
  });
});

describe("installAffordance", () => {
  test("standalone always wins → none", () => {
    expect(installAffordance({ standalone: true, hasInstallPrompt: true, isIos: true })).toBe("none");
    expect(installAffordance({ standalone: true, hasInstallPrompt: false, isIos: false })).toBe("none");
  });
  test("captured prompt (not standalone) → prompt", () => {
    expect(installAffordance({ standalone: false, hasInstallPrompt: true, isIos: false })).toBe("prompt");
    // Prompt beats the iOS hint when both are somehow true.
    expect(installAffordance({ standalone: false, hasInstallPrompt: true, isIos: true })).toBe("prompt");
  });
  test("iOS Safari, not installed, no prompt → ios-hint", () => {
    expect(installAffordance({ standalone: false, hasInstallPrompt: false, isIos: true })).toBe("ios-hint");
  });
  test("nothing available → none", () => {
    expect(installAffordance({ standalone: false, hasInstallPrompt: false, isIos: false })).toBe("none");
  });
});

describe("shouldShowNudge", () => {
  test("shown only when there's an affordance and it isn't dismissed", () => {
    expect(shouldShowNudge({ affordance: "prompt", dismissed: false })).toBe(true);
    expect(shouldShowNudge({ affordance: "ios-hint", dismissed: false })).toBe(true);
  });
  test("hidden when dismissed", () => {
    expect(shouldShowNudge({ affordance: "prompt", dismissed: true })).toBe(false);
    expect(shouldShowNudge({ affordance: "ios-hint", dismissed: true })).toBe(false);
  });
  test("hidden when there's no affordance, dismissed or not", () => {
    expect(shouldShowNudge({ affordance: "none", dismissed: false })).toBe(false);
    expect(shouldShowNudge({ affordance: "none", dismissed: true })).toBe(false);
  });
});

describe("URL builders (must match server routes exactly)", () => {
  test("manifestHref", () => {
    expect(manifestHref("acme")).toBe("/api/manifest/acme.webmanifest");
  });
  test("confIconHref at both sizes", () => {
    expect(confIconHref("acme", 192, "abc123")).toBe("/api/conference-icons/acme/192/abc123");
    expect(confIconHref("acme", 512, "abc123")).toBe("/api/conference-icons/acme/512/abc123");
  });
  test("appleTouchIconHref uses the conference 192 icon when a hash is set", () => {
    expect(appleTouchIconHref("acme", "abc123")).toBe("/api/conference-icons/acme/192/abc123");
  });
  test("appleTouchIconHref falls back to the default icon when no hash", () => {
    expect(appleTouchIconHref("acme", null)).toBe("/icon-192.png");
  });
});
