// "Enable push notifications" opt-in, rendered in the NotificationBell dropdown
// footer. Renders NOTHING unless the instance has Web Push configured
// (config.vapid_public_key present), the browser supports PushManager, AND a
// service worker registration exists (prod-only — dev has no SW). Calm copy, no
// nagging: a single toggle line the user can ignore.
//
// Flow mirrors the standard Web Push handshake:
//   Notification.requestPermission()
//     → registration.pushManager.subscribe({ userVisibleOnly, applicationServerKey })
//     → api.push.subscribe(...)
// The off-path unsubscribes both the browser and the server.

import { useEffect, useState } from "react";
import { api } from "../api";
import { Button } from "../design-system";
import { useToast } from "../design-system/hooks";

// VAPID public keys are URL-safe base64; the subscribe() applicationServerKey
// wants raw bytes.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Allocate an explicit ArrayBuffer (not the ambient ArrayBufferLike) so the
  // result satisfies BufferSource for applicationServerKey.
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

export function PushOptIn({ slug }: { slug: string }) {
  const toast = useToast();
  // `null` = still resolving support/config; once resolved it's true/false.
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
      const existing = await reg.pushManager.getSubscription();
      if (cancelled) return;
      setVapidKey(key);
      setSubscribed(existing !== null);
      setDenied(Notification.permission === "denied");
      setAvailable(true);
    })().catch(() => {
      if (!cancelled) setAvailable(false);
    });
    return () => { cancelled = true; };
  }, [slug]);

  async function enable() {
    if (!vapidKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setDenied(permission === "denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
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
      toast.success("Push notifications on for this device.");
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
      if (sub) await sub.unsubscribe();
      if (endpoint) await api.push.unsubscribe({ slug, endpoint });
      setSubscribed(false);
    } catch {
      toast.error("Could not turn off push notifications.");
    } finally {
      setBusy(false);
    }
  }

  if (!available) return null;

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const borderMuted =
    "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "10px 12px",
        borderTop: `1px solid ${borderMuted}`,
      }}
    >
      <div style={{ fontSize: 12, color: muted, lineHeight: "16px" }}>
        {denied && !subscribed
          ? "Push is blocked in your browser settings."
          : subscribed
            ? "Push on for this device."
            : "Get notified when the app is closed."}
      </div>
      {!denied || subscribed ? (
        <Button
          size="small"
          variant={subscribed ? "invisible" : "default"}
          disabled={busy}
          onClick={subscribed ? disable : enable}
        >
          {subscribed ? "Turn off" : "Enable"}
        </Button>
      ) : null}
    </div>
  );
}
