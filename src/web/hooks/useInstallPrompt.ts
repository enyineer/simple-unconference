// Thin DOM glue over the pure install-decision module (src/web/pwa/install.ts).
// Captures the browser's `beforeinstallprompt` event (Android/desktop
// Chromium), tracks standalone/installed state, and detects iOS Safari — then
// defers every "what to show" decision to `installAffordance`. Nothing here
// branches on product rules; it only wires events and reports facts.

import { useCallback, useEffect, useState } from "react";
import {
  canManualInstall,
  installAffordance,
  isFirefoxDesktop,
  isIosSafari,
  type InstallAffordance,
} from "../pwa/install";

// The `beforeinstallprompt` event isn't in the DOM lib typings, so we model
// exactly the two members we use (no `any`, no cast). `prompt()` shows the
// native install dialog; `userChoice` resolves once the user answers.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: readonly string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Safari exposes `navigator.standalone` (legacy iOS Home Screen flag) outside
// the standard Navigator type. Narrow to it without widening to `any`.
function iosStandalone(): boolean {
  const nav: Navigator & { standalone?: boolean } = navigator;
  return nav.standalone === true;
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    iosStandalone()
  );
}

export interface UseInstallPrompt {
  affordance: InstallAffordance;
  /** Fire the captured native prompt. No-op when nothing was captured. */
  promptInstall: () => void;
  /** True on iOS Safari — lets callers word the hint for iPhone/iPad. */
  isIos: boolean;
}

export function useInstallPrompt(): UseInstallPrompt {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState<boolean>(detectStandalone);

  const isIos =
    typeof navigator === "undefined" ? false : isIosSafari(navigator.userAgent);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      // Keep the browser from showing its own mini-infobar so our button owns
      // the moment; stash the event to fire on click.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // React to the display-mode flipping to standalone (e.g. the user launches
    // the installed app in the same session).
    const mql = window.matchMedia?.("(display-mode: standalone)");
    const onDisplayModeChange = () => setStandalone(detectStandalone());
    mql?.addEventListener?.("change", onDisplayModeChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      mql?.removeEventListener?.("change", onDisplayModeChange);
    };
  }, []);

  const promptInstall = useCallback(() => {
    if (!deferred) return;
    void deferred.prompt();
    // Chromium lets a captured prompt fire only once; drop it so the button
    // hides after the user has answered.
    void deferred.userChoice.finally(() => setDeferred(null));
  }, [deferred]);

  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const affordance = installAffordance({
    standalone,
    hasInstallPrompt: deferred !== null,
    isIos,
    canManualInstall: canManualInstall(ua),
    isFirefoxDesktop: isFirefoxDesktop(ua),
  });

  return { affordance, promptInstall, isIos };
}
