// "Enable push notifications" toggle, rendered in the NotificationBell dropdown
// footer. Renders NOTHING unless the instance has Web Push configured
// (config.vapid_public_key present), the browser supports PushManager, AND a
// service worker registration exists (prod-only — dev has no SW). Calm copy, no
// nagging: a single toggle line the user can ignore. The proactive attention-
// getter is PushNudge; this stays as the persistent on/off control. All the
// subscribe/unsubscribe wiring lives in usePushOptIn so the two stay in sync.

import { Button } from "../design-system";
import { usePushOptIn } from "../hooks/usePushOptIn";

export function PushOptIn({ slug }: { slug: string }) {
  const { available, subscribed, denied, busy, enable, disable } = usePushOptIn(slug);

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
            ? "Push on for this conference."
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
