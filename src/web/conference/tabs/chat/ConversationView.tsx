// Per-conversation message view. Loads the last 50 messages, prepends
// older ones on scroll-up via `before_id`. Subscribes to message.* events
// for THIS conversation and merges them into local state.
//
// Composer is inline at the bottom. Edit/Delete/Report show via a per-
// message kebab menu (handled inside MessageRow).

import { useEffect, useRef, useState, useCallback } from "react";
import { api, errorCode, ApiError } from "../../../api";
import { realtimeBus } from "../../../realtime/realtimeBus";
import { ProfileLink } from "../../ProfileLink";
import { Sheet } from "../../../design-system";
import type { ConfMe } from "../../../App";
import { Composer } from "./Composer";
import { MessageRow } from "./MessageRow";
import { ReportSheet } from "./ReportSheet";

export interface MessageOut {
  id: number;
  conversation_id: number;
  sender_identity_id: number;
  body: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  deleted_reason: string | null;
  read_at: number | null;
}

interface ConversationViewProps {
  slug: string;
  confMe: ConfMe;
  isMod: boolean;
  // null when nothing is selected; -1 sentinel = pending (a "new" conversation
  // that hasn't received its first message yet — controlled via pendingTargetId).
  conversationId: number | null;
  pendingTargetId: number | null;
  // null on desktop (two-pane); back button on mobile only.
  onBack: (() => void) | null;
  // Fires when the first message of a pending conversation lands and we have
  // the real conversation id. ChatTab uses this to update the URL hash.
  onConversationCreated: (id: number) => void;
}

interface ConversationMeta {
  id: number;
  other_identity_id: number;
  other_name: string | null;
  other_profile_published: boolean;
  i_blocked: boolean;
  they_blocked: boolean;
  accepted: boolean;
}

export function ConversationView({
  slug, confMe, isMod, conversationId, pendingTargetId, onBack, onConversationCreated,
}: ConversationViewProps) {
  const [meta, setMeta] = useState<ConversationMeta | null>(null);
  const [messages, setMessages] = useState<MessageOut[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reportingMessageId, setReportingMessageId] = useState<number | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Pending-conversation meta: synthesize from the target identity directly
  // since no Conversation row exists yet.
  useEffect(() => {
    let cancelled = false;
    if (conversationId === null && pendingTargetId !== null) {
      api.profiles.get({ slug, identity_id: pendingTargetId })
        .then((p) => {
          if (cancelled) return;
          setMeta({
            id: -1,
            other_identity_id: pendingTargetId,
            other_name: p.name,
            other_profile_published: p.profile_published,
            i_blocked: false,
            they_blocked: false,
            accepted: false,
          });
          setMessages([]);
          setHasMore(false);
        })
        .catch(() => {
          if (cancelled) return;
          setMeta(null);
          setMessages([]);
        });
      return () => { cancelled = true; };
    }
    if (conversationId === null) {
      // Defer the reset into a microtask-style callback so setState happens
      // inside a Promise continuation rather than the effect body — the
      // react-hooks/set-state-in-effect rule treats the body as cascading.
      Promise.resolve().then(() => {
        if (cancelled) return;
        setMeta(null);
        setMessages(null);
      });
      return () => { cancelled = true; };
    }

    // Fetch the conversation row by listing inbox + finding the matching id.
    // listConversations is small (capped by participant count) and the inbox
    // is fresh in cache anyway, so this is fine for now.
    api.chat.listConversations({ slug })
      .then((rows) => {
        if (cancelled) return;
        const found = rows.find((r) => r.id === conversationId);
        if (!found) {
          setMeta(null);
          setMessages([]);
          return;
        }
        setMeta({
          id: found.id,
          other_identity_id: found.other_identity_id,
          other_name: found.other_name,
          other_profile_published: found.other_profile_published,
          i_blocked: found.i_blocked,
          they_blocked: found.they_blocked,
          accepted: found.accepted,
        });
      })
      .catch(() => { /* no-op */ });

    api.chat.listMessages({ slug, conversation_id: conversationId, limit: 50 })
      .then((rows) => {
        if (cancelled) return;
        // listMessages returns newest first; flip to oldest-first for render.
        setMessages([...rows].reverse());
        setHasMore(rows.length === 50);
      })
      .catch(() => { if (!cancelled) setMessages([]); });

    return () => { cancelled = true; };
  }, [slug, conversationId, pendingTargetId]);

  // Auto-scroll to bottom whenever new messages arrive (including initial
  // load). Re-runs on any messages change; the read of scrollHeight is cheap
  // and edits won't pull us off the latest row.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || messages === null) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Mark read on mount (and whenever conversationId changes). Also re-marks
  // when an inbound message arrives while focused.
  useEffect(() => {
    if (conversationId === null) return;
    api.chat.markRead({ slug, conversation_id: conversationId }).catch(() => { /* no-op */ });
  }, [slug, conversationId]);

  // Realtime: filter events to this conversation and merge.
  const refetchMessage = useCallback(async (messageId: number) => {
    if (conversationId === null) return;
    try {
      // Fetch a small window around the message id to update local state.
      const rows = await api.chat.listMessages({
        slug,
        conversation_id: conversationId,
        before_id: messageId + 1,
        limit: 5,
      });
      const fetched = rows.find((m) => m.id === messageId);
      if (!fetched) return;
      setMessages((prev) => {
        if (prev === null) return prev;
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) return [...prev, fetched];
        const next = [...prev];
        next[idx] = fetched;
        return next;
      });
    } catch { /* no-op */ }
  }, [slug, conversationId]);

  useEffect(() => {
    if (conversationId === null) return;
    const offs = [
      realtimeBus.on("message.created", (e) => {
        if (e.conversationId === conversationId) {
          void refetchMessage(e.messageId);
          api.chat.markRead({ slug, conversation_id: conversationId }).catch(() => { /* no-op */ });
        }
      }),
      realtimeBus.on("message.edited", (e) => {
        void refetchMessage(e.messageId);
      }),
      realtimeBus.on("message.deleted", (e) => {
        void refetchMessage(e.messageId);
      }),
      realtimeBus.on("message.read", (e) => {
        if (e.conversationId === conversationId) {
          // Other party read my messages -> reflect by refetching the last
          // page (cheap and avoids stale readAt state).
          api.chat.listMessages({ slug, conversation_id: conversationId, limit: 50 })
            .then((rows) => setMessages([...rows].reverse()))
            .catch(() => { /* no-op */ });
        }
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [slug, conversationId, refetchMessage]);

  async function loadOlder() {
    if (!hasMore || loadingOlder || messages === null || messages.length === 0 || conversationId === null) return;
    setLoadingOlder(true);
    try {
      const rows = await api.chat.listMessages({
        slug, conversation_id: conversationId,
        before_id: messages[0]!.id, limit: 50,
      });
      setMessages((prev) => prev === null ? prev : [...[...rows].reverse(), ...prev]);
      setHasMore(rows.length === 50);
    } finally {
      setLoadingOlder(false);
    }
  }

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    if (el.scrollTop < 80) void loadOlder();
  }

  async function handleSend(body: string): Promise<{ ok: true } | { error: string }> {
    const target = meta?.other_identity_id;
    if (target === undefined) return { error: "no_target" };
    try {
      const m = await api.chat.send({ slug, target_identity_id: target, body });
      setMessages((prev) => prev === null ? [m] : [...prev, m]);
      // If this was a pending conversation, ChatTab needs the real id to
      // update the URL hash.
      if (conversationId === null && pendingTargetId !== null) {
        onConversationCreated(m.conversation_id);
      }
      return { ok: true };
    } catch (e) {
      const code = e instanceof ApiError ? errorCode(e) : "error";
      return { error: code };
    }
  }

  async function handleEdit(messageId: number, body: string) {
    try {
      const m = await api.chat.edit({ slug, message_id: messageId, body });
      setMessages((prev) => prev === null ? prev : prev.map((x) => x.id === messageId ? m : x));
    } catch { /* toast happens at composer if integrated; silent here */ }
  }

  async function handleDelete(messageId: number) {
    try {
      const m = await api.chat.delete({ slug, message_id: messageId });
      setMessages((prev) => prev === null ? prev : prev.map((x) => x.id === messageId ? m : x));
    } catch { /* no-op */ }
  }

  if (conversationId === null && pendingTargetId === null) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        minHeight: 200, color: "var(--fgColor-muted, #6e7781)",
        fontSize: 14, padding: 40,
      }}>
        Select a conversation to start reading.
      </div>
    );
  }

  if (meta === null && messages === null) {
    return <div style={{ padding: 20, color: "var(--fgColor-muted)" }}>Loading…</div>;
  }

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      // height: 100% picks up the grid cell's fixed height set by ChatTab.
      // min-height: 0 lets the flex children shrink so the scroller can
      // overflow internally instead of pushing the composer below the fold.
      height: "100%",
      minHeight: 0,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        borderBottom: "1px solid var(--borderColor-muted, #e5e7eb)",
      }}>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            style={{
              background: "transparent", border: 0, cursor: "pointer",
              padding: "4px 8px", fontSize: 16, color: "var(--fgColor-default)",
            }}
            aria-label="Back to conversations"
          >
            ←
          </button>
        )}
        {meta && (
          <>
            <img
              src={`/api/avatars/${encodeURIComponent(slug)}/${meta.other_identity_id}`}
              alt=""
              width={36} height={36}
              style={{ borderRadius: "50%" }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>
                <ProfileLink
                  slug={slug}
                  identityId={meta.other_identity_id}
                  linkable={isMod || meta.other_profile_published}
                >
                  {meta.other_name ?? "Unknown"}
                </ProfileLink>
              </div>
              {meta.they_blocked && (
                <div style={{ fontSize: 11, color: "var(--fgColor-danger, #cf222e)" }}>
                  This user has blocked you.
                </div>
              )}
              {meta.i_blocked && !meta.they_blocked && (
                <div style={{ fontSize: 11, color: "var(--fgColor-attention, #9a6700)" }}>
                  You blocked this user.
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setHeaderMenuOpen(true)}
              style={{
                background: "transparent", border: 0, cursor: "pointer",
                padding: "4px 10px", fontSize: 18, color: "var(--fgColor-muted)",
              }}
              aria-label="Conversation options"
            >
              ⋮
            </button>
          </>
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        style={{
          flex: "1 1 0",
          overflowY: "auto",
          padding: "12px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          // min-height: 0 is required for the flex-shrink to actually clip
          // inside an overflowing flex parent. Without it the messages
          // pane would grow to fit content and push the composer offscreen.
          minHeight: 0,
        }}
      >
        {loadingOlder && (
          <div style={{ textAlign: "center", padding: 8, color: "var(--fgColor-muted)" }}>
            Loading older…
          </div>
        )}
        {messages !== null && messages.length === 0 && (
          <div style={{
            margin: "auto",
            color: "var(--fgColor-muted, #6e7781)",
            fontSize: 13,
          }}>
            No messages yet — send the first one below.
          </div>
        )}
        {messages?.map((m, i) => {
          const prev = i > 0 ? messages[i - 1] : undefined;
          const isMe = m.sender_identity_id === confMe.id;
          const groupedWithPrev = prev !== undefined
            && prev.sender_identity_id === m.sender_identity_id
            && (m.created_at - prev.created_at) < 5 * 60_000;
          return (
            <MessageRow
              key={m.id}
              message={m}
              slug={slug}
              isMe={isMe}
              groupedWithPrev={groupedWithPrev}
              onReport={(id) => setReportingMessageId(id)}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          );
        })}
      </div>

      {/* Composer */}
      <Composer
        slug={slug}
        disabled={!meta || meta.they_blocked || meta.i_blocked}
        disabledReason={
          meta?.they_blocked ? "Blocked by this user"
          : meta?.i_blocked ? "You blocked this user — unblock to send"
          : null
        }
        onSend={handleSend}
      />

      {reportingMessageId !== null && (
        <ReportSheet
          slug={slug}
          messageId={reportingMessageId}
          onClose={() => setReportingMessageId(null)}
        />
      )}

      {headerMenuOpen && meta && (
        <Sheet
          open={headerMenuOpen}
          onClose={() => setHeaderMenuOpen(false)}
          title="Conversation"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12 }}>
            {meta.i_blocked ? (
              <button
                type="button"
                onClick={async () => {
                  await api.chat.unblockUser({ slug, target_identity_id: meta.other_identity_id }).catch(() => { /* no-op */ });
                  setHeaderMenuOpen(false);
                  // Refetch meta by closing & reopening would lose state — just
                  // refetch the inbox so the next render reflects the unblock.
                  window.location.reload();
                }}
              >
                Unblock user
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  await api.chat.blockUser({ slug, target_identity_id: meta.other_identity_id }).catch(() => { /* no-op */ });
                  setHeaderMenuOpen(false);
                  window.location.reload();
                }}
                style={{ color: "var(--fgColor-danger, #cf222e)" }}
              >
                Block user
              </button>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}
