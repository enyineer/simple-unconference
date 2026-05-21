// Cloudflare Turnstile widget. Renders a small (often invisible) verification
// box that mints a token the parent submits with the form. Lazy-loads the
// Cloudflare script on first mount; subsequent mounts reuse the cached promise.
// When the server's PublicConfig.turnstile_site_key is null, the parent should
// not render this component at all — it has no purpose without a site key.

import { useEffect, useRef } from "react";

interface TurnstileApi {
  render(
    container: HTMLElement | string,
    options: {
      sitekey: string;
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
      size?: "normal" | "compact" | "flexible";
    },
  ): string;
  remove(widgetId: string): void;
  reset(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    // If someone else already added it, just wait for window.turnstile to appear.
    const existing = document.querySelector<HTMLScriptElement>(`script[src^="${SCRIPT_URL.split("?")[0]}"]`);
    if (existing && window.turnstile) { resolve(); return; }
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("turnstile script error")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("turnstile script failed to load"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileWidgetProps {
  siteKey: string;
  onVerify: (token: string) => void;
  theme?: "light" | "dark" | "auto";
}

export function TurnstileWidget({ siteKey, onVerify, theme = "auto" }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest onVerify in a ref so the script-loaded effect doesn't
  // re-render the widget every time the parent re-creates the callback.
  const onVerifyRef = useRef(onVerify);
  onVerifyRef.current = onVerify;

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | null = null;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          callback: (token: string) => onVerifyRef.current(token),
          "expired-callback": () => onVerifyRef.current(""),
          "error-callback": () => onVerifyRef.current(""),
        });
      })
      .catch(() => {
        // Script failed to load (network/CSP/etc). Treat as never-verified;
        // parent's submit will get blocked by captcha_required on the server.
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try { window.turnstile.remove(widgetId); } catch { /* widget already gone */ }
      }
    };
  }, [siteKey, theme]);

  return <div ref={containerRef} style={{ minHeight: 65 }} />;
}
