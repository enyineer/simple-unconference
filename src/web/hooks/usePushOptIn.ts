// Web Push opt-in state + actions for one conference, shared by the bell footer
// toggle (PushOptIn) and the proactive PushNudge so they never drift. Renders
// nothing to the DOM — it only wires the standard Web Push handshake:
//   Notification.requestPermission()
//     → registration.pushManager.subscribe({ userVisibleOnly, applicationServerKey })
//     → api.push.subscribe(...)
// and the mirror-image teardown for disable().

import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../design-system/hooks";

// VAPID public keys are URL-safe base64; subscribe()'s applicationServerKey
// wants raw bytes.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export interface UsePushOptIn {
  /** null while resolving; then whether push is usable at all (supported +
   *  SW registration exists + the instance has VAPID configured). */
  available: boolean | null;
  subscribed: boolean;
  /** The browser permission is set to "denied" — we can't re-prompt. */
  denied: boolean;
  busy: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

export function usePushOptIn(slug: string): UsePushOptIn {
  const toast = useToast();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pushSupported()) {
        if (!cancelled) setAvailable(false);
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        if (!cancelled) setAvailable(false);
        return;
      }
      let key: string | null;
      try {
        key = (await api.config.get()).vapid_public_key;
      } catch {
        key = null;
      }
      if (cancelled) return;
      if (!key) {
        setAvailable(false);
        return;
      }
      setVapidKey(key);
      setDenied(Notification.permission === "denied");
      // The browser subscription (endpoint) is shared across this origin's
      // conferences, so its mere existence doesn't mean THIS conference is on.
      // Ask the server whether this conference's identity has that endpoint.
      const existing = await reg.pushManager.getSubscription();
      if (cancelled) return;
      if (!existing) {
        setSubscribed(false);
      } else {
        try {
          const { subscribed } = await api.push.status({ slug, endpoint: existing.endpoint });
          if (!cancelled) setSubscribed(subscribed);
        } catch {
          if (!cancelled) setSubscribed(false);
        }
      }
      if (!cancelled) setAvailable(true);
    })().catch(() => {
      if (!cancelled) setAvailable(false);
    });
    return () => { cancelled = true; };
  }, [slug]);

  async function enable() {
    if (!vapidKey) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      // Reuse the shared browser subscription if one already exists (from
      // another conference) — no need to re-prompt for permission. Only create
      // one (and ask permission) when the browser has none yet.
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setDenied(permission === "denied");
          return;
        }
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
      }
      const json = sub.toJSON();
      const p256dh = json.keys?.p256dh;
      const auth = json.keys?.auth;
      if (!json.endpoint || !p256dh || !auth) {
        throw new Error("subscription missing keys");
      }
      await api.push.subscribe({
        slug,
        endpoint: json.endpoint,
        keys: { p256dh, auth },
        user_agent: navigator.userAgent,
      });
      setSubscribed(true);
      toast.success("Push notifications on for this conference.");
    } catch {
      toast.error("Could not enable push notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const endpoint = sub?.endpoint ?? null;
      // Drop ONLY this conference's server registration. Leave the browser
      // subscription intact — it's shared across the origin, so unsubscribing it
      // here would silently break every other conference the user turned on.
      if (endpoint) await api.push.unsubscribe({ slug, endpoint });
      setSubscribed(false);
    } catch {
      toast.error("Could not turn off push notifications.");
    } finally {
      setBusy(false);
    }
  }

  return { available, subscribed, denied, busy, enable, disable };
}
