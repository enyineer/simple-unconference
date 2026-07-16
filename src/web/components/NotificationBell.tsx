// In-app notification bell. Polls the server every 30s for the viewer's
// per-conference inbox (publishes/rejections, assignments, expert bookings,
// mod-side "new submission" pings, etc.) and shows them in a dropdown panel.
//
// CTAs use the custom `tab:<key>` href form — the bell calls `onTabChange`
// when clicked, so the conference page can switch in-place without a route
// change. Hrefs that don't match `tab:` are ignored (future-proofing for
// external links if we ever need them).

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useToast } from "../design-system/hooks";
import { realtimeBus } from "../realtime/realtimeBus";
import { useRoute } from "../router";

type NotificationKind =
  | "submission_published"
  | "submission_rejected"
  | "submission_received"
  | "unconf_assigned"
  | "mixer_assigned"
  | "expert_booked"
  | "expert_booking_cancelled"
  | "quota_threshold"
  | "chat_message"
  | "chat_report"
  | "chat_warning"
  | "schedule_changed"
  | "announcement";

interface NotificationItem {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string | null;
  cta_label: string | null;
  cta_href: string | null;
  read_at: number | null;
  created_at: number;
  unread_count: number;
  dedupe_key: string | null;
}

interface NotificationBellProps {
  slug: string;
  /** Called when a notification's CTA targets a tab (`tab:<key>`). The parent
   *  conference page validates the key against the tabs it actually renders. */
  onNavigateTab: (tabKey: string) => void;
}

const POLL_INTERVAL_MS = 30_000;

export function NotificationBell({
  slug,
  onNavigateTab,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { navigate } = useRoute();
  const toast = useToast();
  // Notification ids seen in a prior fetch. `null` until the first load so we
  // don't toast the whole backlog on mount — only rows that appear *after*
  // we've established a baseline count as "arrived live."
  const seenIdsRef = useRef<Set<number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reset the arrival baseline when switching conferences so the new
    // inbox's existing rows aren't announced as fresh.
    seenIdsRef.current = null;
    const tick = () => {
      api.notifications.list({ slug })
        .then((res) => {
          if (cancelled) return;
          // Surface a live toast for announcements that arrived since the last
          // fetch — in-app users see the broadcast immediately, not just as a
          // bell badge. Guarded by the baseline so mount/first-load is silent.
          const seen = seenIdsRef.current;
          if (seen) {
            for (const it of res.items) {
              if (it.kind === "announcement" && it.read_at === null && !seen.has(it.id)) {
                toast.info(it.body ?? it.title);
              }
            }
          }
          seenIdsRef.current = new Set(res.items.map((i) => i.id));
          setItems(res.items);
          setUnread(res.unread_count);
        })
        // Stale/unauthorized: bell goes empty rather than throwing into the
        // page. The next poll either recovers or stays empty silently.
        .catch(() => {});
    };
    tick();
    // Long-interval poll as a fallback for cases where the SSE stream is down
    // (proxy misconfig, dev without server, etc). The primary refresh path
    // is the realtimeBus subscription below.
    const id = setInterval(tick, POLL_INTERVAL_MS);
    // Push refresh: any notification upsert or read event triggers an
    // immediate refetch. Debounce to one refetch per ~250ms so a flurry of
    // events (e.g. a moderator dismissing many reports) doesn't hammer
    // the server.
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const queueRefetch = () => {
      if (refetchTimer) return;
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        tick();
      }, 250);
    };
    const offs = [
      realtimeBus.on("notification.upserted", queueRefetch),
      realtimeBus.on("notification.read", queueRefetch),
    ];
    return () => {
      cancelled = true;
      clearInterval(id);
      if (refetchTimer) clearTimeout(refetchTimer);
      for (const off of offs) off();
    };
  }, [slug, toast]);

  // Close on outside click + Escape (same pattern as AccountMenu).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleItemClick(item: NotificationItem) {
    if (item.read_at === null) {
      // Optimistic — flip unread count immediately so the badge feels live.
      setItems((prev) =>
        prev.map((n) => (n.id === item.id ? { ...n, read_at: Date.now() } : n)),
      );
      setUnread((c) => Math.max(0, c - 1));
      try {
        await api.notifications.markRead({ slug, id: item.id });
      } catch {
        /* swallow — next poll reconciles */
      }
    }
    if (item.cta_href) {
      if (item.cta_href.startsWith("tab:")) {
        onNavigateTab(item.cta_href.slice("tab:".length));
      } else if (item.cta_href.startsWith("/")) {
        // Hash-route navigation for deep links into the SPA (chat
        // notifications use `/conferences/<slug>/chat/<id>` so clicking
        // the row jumps straight to the conversation).
        navigate(item.cta_href);
      } else if (item.cta_href.startsWith("#")) {
        navigate(item.cta_href.slice(1));
      }
      setOpen(false);
    }
  }

  async function markAll() {
    setItems((prev) =>
      prev.map((n) => (n.read_at === null ? { ...n, read_at: Date.now() } : n)),
    );
    setUnread(0);
    try {
      await api.notifications.markAllRead({ slug });
    } catch {
      /* next poll reconciles */
    }
  }

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const borderMuted =
    "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";
  const borderDefault =
    "var(--borderColor-default, var(--uncon-border, #d0d7de))";
  const bgDefault = "var(--bgColor-default, var(--uncon-bg, #fff))";
  const bgSubtle =
    "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))";
  const fgDefault = "var(--fgColor-default, var(--uncon-fg, inherit))";

  return (
    <div
      ref={rootRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        title="Notifications"
        style={{
          appearance: "none",
          width: 32,
          height: 32,
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          border: `1px solid ${open ? borderDefault : borderMuted}`,
          background: bgSubtle,
          color: fgDefault,
          position: "relative",
          cursor: "pointer",
          transition: "border-color 120ms, background 120ms",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path
            d="M8 1.5a4 4 0 0 0-4 4v2.05c0 .4-.16.78-.44 1.06L2.5 9.67V11h11V9.67l-1.06-1.06A1.5 1.5 0 0 1 12 7.55V5.5a4 4 0 0 0-4-4Zm-1.75 11a1.75 1.75 0 1 0 3.5 0h-3.5Z"
            fill="currentColor"
          />
        </svg>
        {unread > 0 && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              // Anchor center-of-badge near the bell's top-right corner so the
              // badge grows leftward as the digit count rises (1 → 99+) without
              // pulling its right edge off the button.
              top: -4,
              right: -4,
              minWidth: 18,
              height: 18,
              padding: "0 5px",
              boxSizing: "border-box",
              borderRadius: 999,
              border: `2px solid ${bgDefault}`,
              background: "var(--bgColor-danger-emphasis, #cf222e)",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              // Flex centering avoids line-height vs box-sizing drift that the
              // `lineHeight: "16px"` approach hits once a border is involved.
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: 340,
            maxHeight: 440,
            display: "flex",
            flexDirection: "column",
            padding: 0,
            borderRadius: 10,
            border: `1px solid ${borderDefault}`,
            background: bgDefault,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
            zIndex: 100,
            overflow: "hidden",
          }}
        >
          {/* header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 12px",
              borderBottom: `1px solid ${borderMuted}`,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>Notifications</div>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAll}
                style={{
                  appearance: "none",
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  color: "var(--fgColor-accent, #2563eb)",
                  fontFamily: "inherit",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {/* list */}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {items.length === 0 ? (
              <div
                style={{
                  padding: "32px 16px",
                  textAlign: "center",
                  color: muted,
                  fontSize: 13,
                }}
              >
                You&apos;re all caught up.
              </div>
            ) : (
              items.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  onClick={() => handleItemClick(item)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  item,
  onClick,
}: {
  item: NotificationItem;
  onClick: () => void;
}) {
  const unread = item.read_at === null;
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const borderMuted =
    "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";
  const accent = "var(--fgColor-accent, #2563eb)";

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        width: "100%",
        textAlign: "left",
        padding: "10px 12px",
        border: "none",
        borderBottom: `1px solid ${borderMuted}`,
        background: unread
          ? "var(--bgColor-accent-muted, rgba(64,132,246,0.08))"
          : "transparent",
        color: "inherit",
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "background 120ms",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = unread
          ? "var(--bgColor-accent-muted, rgba(64,132,246,0.16))"
          : "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = unread
          ? "var(--bgColor-accent-muted, rgba(64,132,246,0.08))"
          : "transparent";
      }}
    >
      <KindIcon kind={item.kind} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: "18px" }}>
            {item.title}
          </div>
          {unread && (
            <span
              aria-label="unread"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: accent,
                flexShrink: 0,
                marginTop: 5,
              }}
            />
          )}
        </div>
        {item.body && (
          <div
            style={{
              fontSize: 12,
              lineHeight: "16px",
              marginTop: 2,
              color: muted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {item.body}
          </div>
        )}
        <div
          style={{
            marginTop: 4,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            color: muted,
          }}
        >
          <span>{formatRelative(item.created_at)}</span>
          {item.cta_label && (
            <span style={{ color: accent, fontWeight: 600 }}>
              {item.cta_label} →
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function KindIcon({ kind }: { kind: NotificationKind }) {
  const bgByKind: Record<NotificationKind, string> = {
    submission_published: "var(--bgColor-success-muted, rgba(31,136,61,0.14))",
    submission_rejected: "var(--bgColor-danger-muted, rgba(207,34,46,0.14))",
    submission_received: "var(--bgColor-attention-muted, rgba(187,128,9,0.16))",
    unconf_assigned: "var(--bgColor-accent-muted, rgba(64,132,246,0.16))",
    mixer_assigned: "var(--bgColor-accent-muted, rgba(64,132,246,0.16))",
    expert_booked: "var(--bgColor-success-muted, rgba(31,136,61,0.14))",
    expert_booking_cancelled:
      "var(--bgColor-danger-muted, rgba(207,34,46,0.14))",
    quota_threshold: "var(--bgColor-attention-muted, rgba(187,128,9,0.16))",
    chat_message: "var(--bgColor-accent-muted, rgba(64,132,246,0.16))",
    chat_report: "var(--bgColor-attention-muted, rgba(187,128,9,0.16))",
    chat_warning: "var(--bgColor-danger-muted, rgba(207,34,46,0.14))",
    schedule_changed: "var(--bgColor-accent-muted, rgba(64,132,246,0.16))",
    announcement: "var(--bgColor-accent-muted, rgba(64,132,246,0.16))",
  };
  const fgByKind: Record<NotificationKind, string> = {
    submission_published: "var(--fgColor-success, #1f883d)",
    submission_rejected: "var(--fgColor-danger, #cf222e)",
    submission_received: "var(--fgColor-attention, #9a6700)",
    unconf_assigned: "var(--fgColor-accent, #2563eb)",
    mixer_assigned: "var(--fgColor-accent, #2563eb)",
    expert_booked: "var(--fgColor-success, #1f883d)",
    expert_booking_cancelled: "var(--fgColor-danger, #cf222e)",
    quota_threshold: "var(--fgColor-attention, #9a6700)",
    chat_message: "var(--fgColor-accent, #2563eb)",
    chat_report: "var(--fgColor-attention, #9a6700)",
    chat_warning: "var(--fgColor-danger, #cf222e)",
    schedule_changed: "var(--fgColor-accent, #2563eb)",
    announcement: "var(--fgColor-accent, #2563eb)",
  };
  const glyph: Record<NotificationKind, string> = {
    submission_published: "✓",
    submission_rejected: "×",
    submission_received: "!",
    unconf_assigned: "→",
    mixer_assigned: "→",
    expert_booked: "★",
    expert_booking_cancelled: "×",
    quota_threshold: "%",
    chat_message: "✉",
    chat_report: "⚑",
    chat_warning: "!",
    schedule_changed: "→",
    announcement: "📣",
  };
  return (
    <span
      style={{
        width: 24,
        height: 24,
        flexShrink: 0,
        borderRadius: "50%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: bgByKind[kind],
        color: fgByKind[kind],
        fontSize: 13,
        fontWeight: 700,
        lineHeight: 1,
      }}
      aria-hidden
    >
      {glyph[kind]}
    </span>
  );
}

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
