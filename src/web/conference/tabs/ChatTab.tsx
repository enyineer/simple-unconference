// Chat tab shell. Two-pane layout on >=768px (list + view side by side);
// stacks on mobile and shows whichever pane is currently focused via the
// `view` state. The URL hash carries the active conversation so the back
// button works (#/conferences/<slug>/chat[/<id>]).
//
// Realtime: subscribes to message.* events at the tab level so the inbox
// list refreshes on push without each row needing its own listener.

import { useEffect, useState } from "react";
import { useRouteMatch, useRoute } from "../../router";
import { api } from "../../api";
import { realtimeBus } from "../../realtime/realtimeBus";
import { Button } from "../../design-system";
import type { ConfMe } from "../../App";
import { ConversationList } from "./chat/ConversationList";
import { ConversationView } from "./chat/ConversationView";

interface ChatTabProps {
  slug: string;
  confMe: ConfMe;
  isMod: boolean;
  /** Switches the active conference tab to "directory" — used by the empty
   * state CTA so the user has a clear next step when their inbox is empty. */
  onBrowseDirectory: () => void;
}

export interface ConversationOut {
  id: number;
  conference_id: number;
  other_identity_id: number;
  other_name: string | null;
  other_profile_published: boolean;
  accepted: boolean;
  last_message_at: number | null;
  last_message_preview: string | null;
  unread_count: number;
  i_blocked: boolean;
  they_blocked: boolean;
  created_at: number;
}

export function ChatTab({ slug, confMe, isMod, onBrowseDirectory }: ChatTabProps) {
  const [conversations, setConversations] = useState<ConversationOut[] | null>(null);
  // Track viewport so we know whether to stack panes.
  const [isWide, setIsWide] = useState(() => globalThis.window?.innerWidth >= 768);
  const { navigate } = useRoute();

  // URL-driven state. wouter exposes path params via useRouteMatch;
  // - "/conferences/:slug/chat/:rest" matches sub-paths like "/chat/42" or
  //   "/chat/new". When `rest` is numeric → activeId; when "new" → pending.
  // The pending target id lives in the ?to=<id> query — a real search param
  // under path routing (/conferences/foo/chat/new?to=42).
  const [, restMatch] = useRouteMatch<{ slug: string; rest: string }>(
    "/conferences/:slug/chat/:rest",
  );
  // Defensively strip any `?query` / `#fragment` tail off the matched segment.
  const restSegment = restMatch?.rest?.split(/[?#]/)[0];
  const activeId = (() => {
    if (!restSegment || restSegment === "new") return null;
    const n = Number(restSegment);
    return Number.isInteger(n) && n > 0 ? n : null;
  })();
  const pendingTargetId = (() => {
    if (restSegment !== "new") return null;
    const raw = new URLSearchParams(window.location.search).get("to");
    const n = Number(raw);
    return raw !== null && Number.isInteger(n) && n > 0 ? n : null;
  })();

  useEffect(() => {
    function onResize() {
      setIsWide(globalThis.window.innerWidth >= 768);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Initial + push-driven inbox refresh.
  useEffect(() => {
    let cancelled = false;
    function refresh() {
      api.chat.listConversations({ slug })
        .then((r) => { if (!cancelled) setConversations(r); })
        .catch(() => { if (!cancelled) setConversations([]); });
    }
    refresh();
    // Debounced refresh on any chat event — keeps the inbox list (unread
    // counts + previews + sort order) in sync without per-row subscribers.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const queue = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; refresh(); }, 250);
    };
    const offs = [
      realtimeBus.on("message.created", queue),
      realtimeBus.on("message.edited", queue),
      realtimeBus.on("message.deleted", queue),
      realtimeBus.on("message.read", queue),
      realtimeBus.on("notification.read", queue),
    ];
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [slug]);

  function openConversation(id: number) {
    navigate(`/conferences/${encodeURIComponent(slug)}/chat/${id}`);
  }
  function backToList() {
    navigate(`/conferences/${encodeURIComponent(slug)}/chat`);
  }

  const showList = isWide || (activeId === null && pendingTargetId === null);
  const showView = isWide || activeId !== null || pendingTargetId !== null;

  // Gate the entire tab when the viewer's profile is unpublished. canChatWith
  // requires both sides to be published, so even existing conversations are
  // inaccessible in this state — silently showing the empty inbox + composer
  // would let the user click "Send" only to see a generic FORBIDDEN later.
  // This takes precedence over /chat/new?to=X so the Message button in the
  // Directory lands on a clear explanation instead of a non-functional pane.
  if (!confMe.profile_published) {
    return (
      <div style={{
        height: "calc(100dvh - 240px)",
        minHeight: 320,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}>
        <ChatPublishGate
          onEditProfile={() => navigate(`/conferences/${encodeURIComponent(slug)}/p/${confMe.id}`)}
        />
      </div>
    );
  }

  // Unified empty state: when the inbox is loaded, has zero rows, and nothing
  // is selected/composing, render one centered tile spanning both panes
  // instead of two awkward placeholder lines (list + view) sitting side by
  // side with nothing to do.
  const fullyEmpty = conversations !== null
    && conversations.length === 0
    && activeId === null
    && pendingTargetId === null;

  if (fullyEmpty) {
    return (
      <div style={{
        height: "calc(100dvh - 240px)",
        minHeight: 320,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}>
        <ChatEmptyState onBrowseDirectory={onBrowseDirectory} />
      </div>
    );
  }

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: isWide ? "minmax(280px, 360px) 1fr" : "1fr",
      gap: isWide ? 16 : 0,
      // Fixed height so the inner messages scroller can actually overflow.
      // `dvh` accounts for the mobile browser chrome correctly. The ~240px
      // budget leaves room for the page header + tab bar + safe area.
      // Children must also constrain (min-height: 0 on the flex chain) so
      // overflow-y: auto on the messages list has somewhere to clip against.
      height: "calc(100dvh - 240px)",
      minHeight: 320,
    }}>
      {showList && (
        <ConversationList
          slug={slug}
          conversations={conversations}
          activeId={activeId}
          pendingTargetId={pendingTargetId}
          isMod={isMod}
          onOpen={openConversation}
        />
      )}
      {showView && (
        <ConversationView
          slug={slug}
          confMe={confMe}
          isMod={isMod}
          conversationId={activeId}
          pendingTargetId={pendingTargetId}
          onBack={isWide ? null : backToList}
          onConversationCreated={(id) => {
            // First send on a "new" conversation: switch to the real id.
            openConversation(id);
          }}
        />
      )}
    </div>
  );
}

function ChatPublishGate({ onEditProfile }: { onEditProfile: () => void }) {
  return (
    <div style={{
      maxWidth: 460,
      width: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      textAlign: "center",
      gap: 16,
      padding: 32,
      borderRadius: 12,
      border: "1px dashed var(--borderColor-muted, #d0d7de)",
      background: "var(--bgColor-muted, transparent)",
    }}>
      <div
        aria-hidden
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bgColor-attention-muted, rgba(212,167,44,0.16))",
          color: "var(--fgColor-attention, #9a6700)",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>
      <div style={{
        fontSize: 16,
        fontWeight: 600,
        color: "var(--fgColor-default, inherit)",
      }}>
        Publish your profile to start chatting
      </div>
      <div style={{
        fontSize: 13,
        color: "var(--fgColor-muted, #6e7781)",
        lineHeight: 1.5,
      }}>
        Direct messages are only available between members with a published
        profile. Publish yours so other attendees can see who they&apos;re
        talking to — you control what details are shared.
      </div>
      <Button variant="primary" onClick={onEditProfile}>
        Edit your profile
      </Button>
    </div>
  );
}

function ChatEmptyState({ onBrowseDirectory }: { onBrowseDirectory: () => void }) {
  return (
    <div style={{
      maxWidth: 420,
      width: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      textAlign: "center",
      gap: 16,
      padding: 32,
      borderRadius: 12,
      border: "1px dashed var(--borderColor-muted, #d0d7de)",
      background: "var(--bgColor-muted, transparent)",
    }}>
      <div
        aria-hidden
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bgColor-accent-muted, rgba(64,132,246,0.12))",
          color: "var(--fgColor-accent, #2563eb)",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      </div>
      <div style={{
        fontSize: 16,
        fontWeight: 600,
        color: "var(--fgColor-default, inherit)",
      }}>
        No conversations yet
      </div>
      <div style={{
        fontSize: 13,
        color: "var(--fgColor-muted, #6e7781)",
        lineHeight: 1.5,
      }}>
        Find someone in the Directory and open their profile to start a 1-on-1 chat.
        Messages stay inside this conference.
      </div>
      <Button variant="primary" onClick={onBrowseDirectory}>
        Browse Directory
      </Button>
    </div>
  );
}
