// Inbox view. Two buckets: accepted conversations on top, pending Requests
// (collapsible) below. Each row shows: avatar, name, preview, time, unread.
// Click navigates to the conversation view; the URL hash is the source of
// truth for "what's open" (kept in sync by ChatTab).
//
// When the user is composing a fresh conversation (URL ends with
// /chat/new?to=X but no Conversation row exists yet), the list renders a
// pinned "Composing → <name>" entry so the inbox doesn't look empty while
// they're staring at the composer pane.

import { useState, useEffect } from "react";
import { api } from "../../../api";
import type { ConversationOut } from "../ChatTab";

interface ConversationListProps {
  slug: string;
  conversations: ConversationOut[] | null;
  activeId: number | null;
  pendingTargetId: number | null;
  isMod: boolean;
  onOpen: (conversationId: number) => void;
}

export function ConversationList({
  slug, conversations, activeId, pendingTargetId, isMod, onOpen,
}: ConversationListProps) {
  const [requestsOpen, setRequestsOpen] = useState(true);
  // Keyed by identity id so a stale fetch from a previous target doesn't
  // leak into the next render. The derived `pendingName` is null until a
  // fetch for the *current* target lands.
  const [fetchedPending, setFetchedPending] = useState<{ id: number; name: string | null } | null>(null);

  useEffect(() => {
    if (pendingTargetId === null) return;
    let cancelled = false;
    api.profiles.get({ slug, identity_id: pendingTargetId })
      .then((p) => { if (!cancelled) setFetchedPending({ id: pendingTargetId, name: p.name }); })
      .catch(() => { if (!cancelled) setFetchedPending({ id: pendingTargetId, name: null }); });
    return () => { cancelled = true; };
  }, [slug, pendingTargetId]);

  const pendingName = fetchedPending?.id === pendingTargetId ? fetchedPending.name : null;

  // Suppress the inbox pending row when a real conversation already exists
  // for this target — switching to that row is the right UX (handled by
  // ChatTab) and we don't want the composer to look like a separate thread.
  const pendingAlreadyExists = pendingTargetId !== null
    && conversations?.some((c) => c.other_identity_id === pendingTargetId);

  if (conversations === null) {
    return <div style={{ padding: 24, color: "var(--fgColor-muted)" }}>Loading…</div>;
  }

  const accepted = conversations.filter((c) => c.accepted);
  const requests = conversations.filter((c) => !c.accepted);
  const showPending = pendingTargetId !== null && !pendingAlreadyExists;
  const empty = accepted.length === 0 && requests.length === 0 && !showPending;

  // True "no conversations" empty state is handled by ChatTab as a unified
  // tile across both panes. Here we render nothing — ConversationList only
  // mounts when there's at least one row, or a pending compose, or an active
  // selection that needs the list visible on desktop.
  if (empty) return null;

  return (
    <div style={{
      borderRight: "1px solid var(--borderColor-muted, #e5e7eb)",
      paddingRight: 12,
      // Fills the grid cell set by ChatTab; the inner scroll handles
      // overflow when the inbox grows past the visible area.
      height: "100%",
      minHeight: 0,
      overflowY: "auto",
    }}>
      {showPending && pendingTargetId !== null && (
        <PendingRow
          slug={slug}
          targetIdentityId={pendingTargetId}
          name={pendingName}
        />
      )}
      {accepted.length > 0 && (
        <div>
          {accepted.map((c) => (
            <ConversationRow
              key={c.id}
              c={c}
              slug={slug}
              active={c.id === activeId}
              isMod={isMod}
              onClick={() => onOpen(c.id)}
            />
          ))}
        </div>
      )}
      {requests.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={() => setRequestsOpen((v) => !v)}
            style={{
              width: "100%",
              textAlign: "left",
              background: "transparent",
              border: 0,
              padding: "8px 12px",
              color: "var(--fgColor-muted, #6e7781)",
              fontSize: 12,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              cursor: "pointer",
            }}
          >
            {requestsOpen ? "▾" : "▸"} Requests ({requests.length})
          </button>
          {requestsOpen && requests.map((c) => (
            <ConversationRow
              key={c.id}
              c={c}
              slug={slug}
              active={c.id === activeId}
              isMod={isMod}
              onClick={() => onOpen(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationRow({
  c, slug, active, isMod, onClick,
}: {
  c: ConversationOut;
  slug: string;
  active: boolean;
  isMod: boolean;
  onClick: () => void;
}) {
  const linkable = isMod || c.other_profile_published;
  const displayName = c.other_name ?? "Unknown";
  const preview = c.last_message_preview ?? (
    c.last_message_at === null ? "" : "Message removed"
  );
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        width: "100%",
        background: active
          ? "var(--bgColor-accent-muted, rgba(64,132,246,0.12))"
          : "transparent",
        border: 0,
        borderRadius: 8,
        padding: "10px 12px",
        textAlign: "left",
        cursor: "pointer",
        color: "var(--fgColor-default, inherit)",
      }}
    >
      <Avatar slug={slug} identityId={c.other_identity_id} linkable={linkable} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          fontWeight: c.unread_count > 0 ? 600 : 500,
          fontSize: 14,
        }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayName}
          </span>
          {c.last_message_at !== null && (
            <span style={{
              fontSize: 11,
              color: "var(--fgColor-muted, #6e7781)",
              fontWeight: 400,
              flexShrink: 0,
            }}>
              {formatRelative(c.last_message_at)}
            </span>
          )}
        </div>
        <div style={{
          fontSize: 13,
          color: c.unread_count > 0
            ? "var(--fgColor-default)"
            : "var(--fgColor-muted, #6e7781)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {preview || <em>No messages yet</em>}
        </div>
      </div>
      {c.unread_count > 0 && (
        <span style={{
          background: "var(--bgColor-accent-emphasis, #2563eb)",
          color: "white",
          fontSize: 11,
          fontWeight: 600,
          borderRadius: 999,
          padding: "2px 8px",
          minWidth: 20,
          textAlign: "center",
          flexShrink: 0,
        }}>
          {c.unread_count}
        </span>
      )}
    </button>
  );
}

function Avatar({ slug, identityId, linkable }: { slug: string; identityId: number; linkable: boolean }) {
  // Always render a 32px circle — the avatars endpoint returns an initials
  // SVG when the profile isn't visible, so it never falls back to a broken
  // image even for unpublished targets. `linkable` doesn't change the avatar
  // — the row itself is the clickable target.
  void linkable;
  return (
    <img
      src={`/api/avatars/${encodeURIComponent(slug)}/${identityId}`}
      alt=""
      width={32}
      height={32}
      style={{ borderRadius: "50%", flexShrink: 0, background: "var(--bgColor-muted, #f0f0f0)" }}
    />
  );
}

function formatRelative(timestampMs: number): string {
  const now = Date.now();
  const diff = now - timestampMs;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(timestampMs).toLocaleDateString();
}

// Pinned row that represents an in-flight composer for a target the user
// hasn't messaged before. Visually distinct from accepted/request rows so
// the user can tell this isn't a real conversation yet (no message has
// been sent). Always "active" — the composer pane is open for it.
function PendingRow({ slug, targetIdentityId, name }: {
  slug: string;
  targetIdentityId: number;
  name: string | null;
}) {
  const displayName = name ?? "Composing…";
  return (
    <div style={{
      display: "flex",
      gap: 10,
      alignItems: "center",
      width: "100%",
      background: "var(--bgColor-accent-muted, rgba(64,132,246,0.12))",
      borderRadius: 8,
      padding: "10px 12px",
      marginBottom: 8,
      fontSize: 14,
      color: "var(--fgColor-default, inherit)",
    }}>
      <img
        src={`/api/avatars/${encodeURIComponent(slug)}/${targetIdentityId}`}
        alt=""
        width={32} height={32}
        style={{ borderRadius: "50%", flexShrink: 0 }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{displayName}</div>
        <div style={{ fontSize: 12, color: "var(--fgColor-muted, #6e7781)" }}>
          New conversation — send to start
        </div>
      </div>
    </div>
  );
}
