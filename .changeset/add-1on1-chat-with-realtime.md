---
"simple-unconference": minor
---

Add 1-on-1 chat between conference participants, with realtime delivery, moderation, and read receipts.

**Chat surface**

A new "Chat" tab in every conference. Participants can message any other participant who has a published profile and hasn't disabled chat. Moderators can DM unpublished participants for moderation outreach. Composer supports edit (15-minute window, with full revision history kept for moderators) and soft-delete. Messages over 4096 bytes are rejected; rate limits cap new conversations at 10/hour and messages at 30/minute per identity (both env-configurable via `CHAT_NEW_CONVERSATIONS_PER_HOUR`, `CHAT_MESSAGES_PER_MINUTE`, `CHAT_MESSAGE_MAX_BYTES`).

**Privacy model**

- Two identities can chat iff both have `profilePublished=true`, both have `chatEnabled=true`, neither is banned, and neither has blocked the other. Mods bypass the published check; everything else still applies. Single source of truth: `canChatWith` in `src/server/lib/permissions.ts`.
- Chat responses never include either participant's canonical email. Read receipts (`Message.readAt`) are stripped from the *sender's* serialization when the *recipient* has `chatReadReceiptsEnabled=false`.
- Per-user blocks (separate from the global chat-enabled toggle) hide the conversation both ways and prevent new conversations.

**Moderation**

Reported messages land in the People tab for moderators with the message, its full revision chain, and 5 surrounding messages from the conversation. Actions: Dismiss, Warn (sends a `chat_warning` notification with the report reason), Ban (sets `chatBannedAt` on the sender's identity and soft-deletes the offending message). Banned identities can't send but the conversation stays visible. Unban from the same surface.

**Realtime infrastructure**

New `EventBus` abstraction with two implementations: `InProcessBus` for single-worker dev/test, `ClusterBus` for production (`WORKERS > 1`). `ClusterBus` rides Bun's built-in `ipc` callback on `Bun.spawn` — the launcher in `src/server/cluster.ts` mirrors `{type:"bus", event}` messages to every other worker. Per-worker bounded queue (1000 events) with logged drop counters; client `Last-Event-ID` replay heals any losses.

One global SSE connection per browser tab at `GET /api/realtime/stream`. Mounted at App level via `<RealtimeProvider>`. Multiplexed by event kind via a small client `realtimeBus` (`message.created`, `message.edited`, `message.deleted`, `message.read`, `notification.upserted`, `notification.read`). The existing notification bell now refreshes on push (with a 30s poll as fallback). Bun.serve `idleTimeout: 0` so the API can hold long-lived SSE connections through the 20s heartbeat.

**Schema additions**

5 new models — `Conversation`, `Message`, `MessageRevision`, `MessageReport`, `ChatBlock` — plus 5 columns on `ConferenceIdentity` (`chatEnabled`, `chatReadReceiptsEnabled`, `chatBannedAt`, `chatBannedReason`, `chatBannedByUserId`) and 2 on `Notification` (`dedupeKey`, `unreadCount` — generalized coalescing so chat events collapse into one bell row per conversation). Single migration: `20260523082627_add_chat_models`.

**Notification coalescing**

`Notification.@@unique([identityId, dedupeKey])` enforces at most one row per conversation per identity. `upsertChatNotification` reuses the existing row regardless of read state: unread → increment count; previously read → reset to a fresh unread cycle. `markRead` nulls the `dedupeKey` so the slot frees for future cycles.

**Retention**

Conference deletion blocks when any unresolved chat reports exist (`open_chat_reports` error). Resolved reports are pre-deleted as part of the cascade. Identity removal pre-deletes reports filed against that user's messages — they're leaving entirely, the audit trail closes with them.

**Frontend routing**

Migrated from the hand-rolled `matchRoute` helper to `wouter` (~1.5KB) so tabs can be real routes (`/conferences/:slug/chat`, `/conferences/:slug/sessions`, etc.) instead of local `useState`. Deep links, the back/forward buttons, and the bell's "Open chat" CTA all line up with the visible tab. The legacy `useRoute()` / `matchRoute()` helpers are still exported as thin wouter wrappers so older callers keep compiling.

**New Prometheus metrics**

Per-worker — `chat_conversations_total`, `chat_conversations_accepted_total`, `chat_messages_total`, `chat_messages_deleted_total`, `chat_reports_total`, `chat_reports_open_total` (alert when sustained), `chat_blocks_total`, `chat_banned_identities_total`, `chat_disabled_identities_total`, `realtime_sse_active_connections`, `realtime_sse_total_connections`, `realtime_sse_replay_message_events_total`, `realtime_sse_replay_notification_events_total`, `bus_active_subscriptions`, `bus_ipc_sent_total`, `bus_ipc_received_total`, `bus_published_total{kind=…}`, `bus_delivered_total{kind=…}`.

**Operational notes**

- Unexpected procedure errors now log to console via a new oRPC interceptor (`[rpc] procedure threw …`); intentional `ORPCError` throws stay quiet.
- `Bun.serve { idleTimeout: 0 }` is required for SSE to survive past the default ~10s. Don't lower it.
