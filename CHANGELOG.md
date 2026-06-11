# simple-unconference

## 0.10.0

### Minor Changes

- [#16](https://github.com/enyineer/simple-unconference/pull/16) [`024aa5f`](https://github.com/enyineer/simple-unconference/commit/024aa5facc0a8ae9776a37ccc30260331687c8d9) Thanks [@enyineer](https://github.com/enyineer)! - Redesign the agenda + assignment UX to be understandable for non-technical moderators (while keeping every advanced capability).

  - **Clear two-step model.** The agenda now frames unconference setup as "1 · Place sessions → 2 · Assign attendees", so the per-slot and whole-agenda actions no longer compete. The per-slot button is relabelled "Auto-fill this slot from stars"; the whole-agenda "Assign attendees" action now confirms before re-seating and states that manual placements + people's own picks are kept and participants are notified.
  - **Slot-type chooser.** "Add slot" now offers selectable Planned / Unconference / Mixer cards (each with "what it is" + "use it when"), defaults to Planned, and links inline help — instead of a bare dropdown.
  - **Onboarding.** A dismissible "Set up your agenda" checklist (rooms → publish sessions → add a slot → place sessions) guides first-time owners, and the Rooms/Sessions/Agenda empty states now explain the next step and prerequisites.
  - **Plain-language help.** The "How it works" guide leads with a Start-here summary, collapses the deep mechanics into expandable sections, and adds a glossary. A single shared copy module keeps all this wording consistent.
  - **Placement clarity.** Placed sessions show "placed by you" / "by stars" and "also at HH:MM" (recurrence) badges; the placement control has a heading explaining how to make a session recurring.
  - **Terminology.** User-facing copy now consistently says "session" (not "submission"), softens "track"/"pin" wording, and renames a participant's tag to "chose this".

- [#16](https://github.com/enyineer/simple-unconference/pull/16) [`024aa5f`](https://github.com/enyineer/simple-unconference/commit/024aa5facc0a8ae9776a37ccc30260331687c8d9) Thanks [@enyineer](https://github.com/enyineer)! - Add whole-agenda attendee assignment with moderator-authored placements.

  Moderators can now place a session into a specific slot + room
  (`agenda.placeSubmission` / `unplaceSubmission`, surfaced as the placement
  authoring controls on an unconference slot), including placing the same session
  on multiple slots to build a recurring session. A new **Assign attendees**
  action (`agenda.assignAll`) then routes participants across the entire agenda at
  once instead of one slot at a time.

  The global router (`assignAgenda`, a new pure module) is an integer min-cost
  flow that, unlike the per-slot greedy assigner, sees the whole agenda: it
  **splits a recurring session's starrers evenly across its occurrences** and
  applies **cross-slot look-ahead** (a user starring two same-time sessions, one
  of which also runs later, is sent to the non-recurring one now and caught up
  with the other at its later showing). Hard rules still hold: at most one session
  per overlapping time-band, room capacity, never the same session twice, and
  manual picks + submitter hosting are respected. It writes only `UserAssignment`
  rows — authored placements are preserved. The existing per-slot "Run assignment"
  button is unchanged.

### Patch Changes

- [#16](https://github.com/enyineer/simple-unconference/pull/16) [`024aa5f`](https://github.com/enyineer/simple-unconference/commit/024aa5facc0a8ae9776a37ccc30260331687c8d9) Thanks [@enyineer](https://github.com/enyineer)! - Fix `P2003` foreign-key crash when deleting a conference (and when removing a participant who authored a submission).

  `Submission.submitter` referenced `ConferenceIdentity` with no `onDelete`, so it defaulted to `Restrict`. Deleting a conference cascades into both its identities and its submissions, but the Restrict edge between a submission and its (about-to-be-deleted) submitter blocked the cascade, surfacing as `ForeignKeyConstraintViolation`. The same edge made `conferences.removeParticipant` 500 whenever the removed identity had submitted a session. The relation is now `onDelete: Cascade` (migration `submission_submitter_cascade`): removing an identity removes the sessions they authored.

- [`b44ec19`](https://github.com/enyineer/simple-unconference/commit/b44ec19acbfa960f24ecc2090973fe02ad9b4319) Thanks [@enyineer](https://github.com/enyineer)! - Fix `react-hooks/set-state-in-effect` lint failure in `usePaginatedList`.

  The fetch effect previously called `setLoading(true)` and `setError(null)` synchronously before kicking off the request, which the React ESLint plugin flags as a cascading-render hazard. Page, error, and the inputs they were loaded for now live in a single state object updated atomically from inside the promise callback; `loading` is derived from `(result.key !== currentKey)` so it flips true automatically when inputs change without any synchronous setState. Error display clears in lockstep with new data since both ride on the same update.

## 0.9.0

### Minor Changes

- [`e3c800d`](https://github.com/enyineer/simple-unconference/commit/e3c800d9f415375d2cf9143fbe5267df46c3c277) Thanks [@enyineer](https://github.com/enyineer)! - Ship a starter Grafana dashboard with the Helm chart, auto-imported via the standard Grafana dashboards-sidecar pattern.

  **Why**

  kube-prometheus-stack's bundled dashboards cover the cluster but know nothing about this app's metric names. Operators were left to either query in Explore or build a dashboard from scratch — and rebuild it whenever the app's metric taxonomy changes. Shipping the dashboard from the chart keeps it in lockstep with the metric definitions in [src/server/metrics/aggregate.ts](src/server/metrics/aggregate.ts) and survives Grafana PVC loss.

  **What changed**

  - New file `dashboards/simple-unconference.json` — 11 panels in 4 rows:
    - **Health**: fresh workers, stale workers, global-metrics-stale indicator, uptime.
    - **Realtime**: SSE active connections (total + per worker), bus events published rate by kind.
    - **Storage**: data volume % used gauge, SQLite file size over time, submissions by status donut.
    - **Content & Chat**: users, conferences, identities, chat messages, open chat reports, expert bookings.
  - New template `templates/dashboard.yaml` wrapping the JSON in a ConfigMap labeled `grafana_dashboard: "1"` so kube-prometheus-stack's Grafana sidecar imports it automatically.
  - New `metrics.dashboard.*` values:
    - `enabled` (default `false`) toggle.
    - `namespace` override for when the sidecar is namespace-scoped to Grafana's namespace.
    - `label` / `labelValue` / `extraLabels` for non-default sidecar configurations.
    - `folder` to land the dashboard in a specific Grafana folder.
  - Dashboard uses a `${datasource}` variable rather than hard-coding the Prometheus datasource, so it works under any Grafana install that has at least one Prometheus datasource registered.

- [`e3c800d`](https://github.com/enyineer/simple-unconference/commit/e3c800d9f415375d2cf9143fbe5267df46c3c277) Thanks [@enyineer](https://github.com/enyineer)! - Ship a starter `PrometheusRule` with the Helm chart for instance health, storage capacity, and moderation backlog alerts.

  **Why**

  The chart already wires Prometheus to the dedicated metrics Service via `ServiceMonitor`, but operators were left to write their own alerting rules against series like `app_workers_stale_total` and `storage_pvc_free_bytes`. The aggregation contract for those metrics lives in the app, not the consumer — shipping the rules alongside the chart keeps them in sync as metric names evolve.

  **What changed**

  - New template `templates/prometheusrule.yaml`, gated by `metrics.prometheusRule.enabled` (default `false`). Requires the prometheus-operator CRDs — same prerequisite as `metrics.serviceMonitor.enabled`.
  - Three rule groups:
    - **simple-unconference.health**: `SimpleUnconferenceScrapeDown`, `SimpleUnconferenceNoWorkers`, `SimpleUnconferenceWorkerStale`, `SimpleUnconferenceGlobalMetricsStale`.
    - **simple-unconference.storage**: `SimpleUnconferenceStorageLow` (<15% free), `SimpleUnconferenceStorageCritical` (<5% free).
    - **simple-unconference.moderation**: `SimpleUnconferenceChatReportsBacklog`, threshold tunable via `metrics.prometheusRule.chatReportsBacklogThreshold` (default `10`).
  - All rules scope to the dedicated metrics Service with `{service="<release>-metrics"}` so multiple releases of the chart in one Prometheus stay isolated.
  - Optional `metrics.prometheusRule.labels` lets operators add the discovery label their Prometheus expects (e.g. `release: kube-prometheus-stack`).

## 0.8.0

### Minor Changes

- [`111068a`](https://github.com/enyineer/simple-unconference/commit/111068ac4b49a227d52fc140be1efcdcfe4cf0f3) Thanks [@enyineer](https://github.com/enyineer)! - Add 1-on-1 chat between conference participants, with realtime delivery, moderation, and read receipts.

  **Chat surface**

  A new "Chat" tab in every conference. Participants can message any other participant who has a published profile and hasn't disabled chat. Moderators can DM unpublished participants for moderation outreach. Composer supports edit (15-minute window, with full revision history kept for moderators) and soft-delete. Messages over 4096 bytes are rejected; rate limits cap new conversations at 10/hour and messages at 30/minute per identity (both env-configurable via `CHAT_NEW_CONVERSATIONS_PER_HOUR`, `CHAT_MESSAGES_PER_MINUTE`, `CHAT_MESSAGE_MAX_BYTES`).

  **Privacy model**

  - Two identities can chat iff both have `profilePublished=true`, both have `chatEnabled=true`, neither is banned, and neither has blocked the other. Mods bypass the published check; everything else still applies. Single source of truth: `canChatWith` in `src/server/lib/permissions.ts`.
  - Chat responses never include either participant's canonical email. Read receipts (`Message.readAt`) are stripped from the _sender's_ serialization when the _recipient_ has `chatReadReceiptsEnabled=false`.
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

- [`111068a`](https://github.com/enyineer/simple-unconference/commit/111068ac4b49a227d52fc140be1efcdcfe4cf0f3) Thanks [@enyineer](https://github.com/enyineer)! - Move Prometheus metrics from `/api/metrics` on the main app port to a dedicated `/metrics` endpoint on `METRICS_PORT` (default `9090`), and aggregate them across workers in the cluster launcher.

  **Why**

  With `WORKERS > 1`, every worker behind `SO_REUSEPORT` kept its own in-memory counters. Prometheus scrapes landed on whichever worker the kernel picked that round, so `realtime_sse_active_connections`, `bus_*`, etc. oscillated between workers' local snapshots — dashboards showed ~1/Nth of reality. Moving the endpoint to a launcher-owned port also lets ops keep it off the main `Service` (and Ingress) entirely.

  **What changed**

  - New port `METRICS_PORT` (default `9090`) served by the cluster launcher when `WORKERS > 1`, or by the app process in single-worker mode. Path is `/metrics` (no `/api/` prefix).
  - Workers push per-process snapshots to the launcher over Bun IPC every 5 s. Worker 0 additionally pushes DB row counts + storage stats — single source for the global numbers, no N-way Prisma fan-out.
  - Aggregation produces per-worker series with a `worker="N"` label for per-process metrics (active connections, bus counters, IPC counters) plus unlabeled global metrics for DB + storage counts. Aggregate with PromQL `sum()`.
  - New observability metrics: `app_workers_total`, `app_workers_stale_total`, `app_metrics_global_stale`, `worker_uptime_seconds{worker}`. Removed `app_worker_id` (no longer meaningful at the cluster level).

  **Helm chart**

  - New `metrics.enabled` (default `true`) and `metrics.port` (default `9090`) values.
  - New `ClusterIP` Service `<release>-simple-unconference-metrics` exposing only the metrics port. The main app Service no longer carries a metrics port.
  - `ServiceMonitor` now targets the metrics Service, `port: metrics`, `path: /metrics`.

  **Breaking changes**

  - `/api/metrics` is removed. External scrape configs must move to the new path + port + Service.
  - `app_worker_id` is removed; use `app_workers_total` for cluster size or filter per-worker series via the `worker` label.
  - Per-worker metrics (`realtime_sse_*`, `bus_*`) now carry a `worker` label; dashboards that previously read the raw series will need `sum()` to recover the cluster total.

- [`8c3cf5b`](https://github.com/enyineer/simple-unconference/commit/8c3cf5b532f95c1ca394568ebabad778aad7057a) Thanks [@enyineer](https://github.com/enyineer)! - Paginate + add server-side search to the large list views so big conferences (hundreds-to-thousands of sessions, participants, profiles, rooms, invites, and chat reports) stay responsive.

  **Shared building blocks**

  - New `Page<T> = { items, total, next_cursor }` envelope in `src/shared/contract/types.ts` and a matching `PageInputEntries` valibot primitive (`q`, `cursor`, `limit`) composed into each paginated procedure's input.
  - Server helpers `parsePageInput` / `pageOf` in `src/server/rpc/shared.ts`. `cursor` is an opaque offset token (decimal string); `limit` clamps to `[1, 100]`, default 25.
  - Frontend `usePaginatedList` hook in `src/web/conference/usePaginatedList.ts` — owns search `q` with 200ms debounce, cursor stack so Prev is O(1), stale-fetch suppression via a sequence counter, and a `refresh()` hook callers wire to realtime bus events.
  - `<Pager />` UI in `src/web/conference/ui/Pager.tsx`: "Showing X-Y of N · Page X/Y" + Prev/Next. Drop-in for every list.

  **Paginated + searchable**

  - `rooms.list` — search by name / description / tag.
  - `submissions.list` — search by title / description / submitter name / tag (mods also match submitter email). `status`, `starred_only`, and `tags[]` (AND) are server-side too so paging counts honor them.
  - `profiles.list` — search by name / title / company / tag.
  - `conferences.listParticipants` — search by email / name.
  - `conferences.listInvites` — search by email; new `status: "pending" | "claimed" | "all"` filter.
  - `moderation.listChatReports` — search by reason / reporter name / sender name / message body. Returns compact `MessageReportSummaryOut` rows (no surrounding-message window).
  - `moderation.listChatBans` — search by name / email / ban reason.

  **New escape-hatch procedures**

  Picker / form contexts that genuinely need every row (slot pickers, session room-tag picker, expert/agenda views) keep working via:

  - `rooms.listAll` — unpaginated, `RoomOut[]` (the previous shape of `rooms.list`).
  - `submissions.listAll` — unpaginated, `SubmissionOut[]` (the previous shape of `submissions.list`); honors the same privacy gate.
  - `moderation.getChatReport` — full `MessageReportOut` (revisions + ±5 surrounding messages) loaded lazily when the moderator opens a report from the paginated list.
  - `conferences.exportInvites` — server-streamed CSV-source list of every pending invite matching the current search `q`. The People tab's "Download CSV" button now calls this instead of paging the client through every row, so big rosters export consistently and don't race against creates / claims.

  **UI changes**

  - Rooms tab: search input + pager.
  - Sessions tab: search now hits the server (folds in tag/title/description/speaker matches); status chips and starred-only toggle are server-driven; pager replaces the implicit "everything in memory" model.
  - Directory: pager replaces the old "load everything" pattern; the existing 200ms debounce moves into `usePaginatedList`.
  - People tab: separate search + pager for participants and pending invites; Chat-reports section gets its own search + pager, plus a separate search + pager for the banned-from-chat list. Status chips on reports keep working.

  **Wire-shape changes**

  The `list` procedures above now return `Page<T>` instead of `T[]`. Tests that consumed the array directly use `.items` (or `listAll` where the original semantics matter). All 374 tests pass; `tsc --noEmit` clean.

  **Dev script reliability**

  `bun --hot` reloads file bodies in place, but the oRPC router is built once at module-eval time — `implement(contract)` + the `requireConf(...).foo.list.handler(...)` chain capture references to the contract object then. Reshaping the contract or adding a procedure doesn't propagate to the running router; the API keeps serving the old wire shape while the SPA recompiles against the new types. `scripts/dev.ts` now restarts the API on changes under `src/server/rpc/**` or `src/shared/contract*`, matching the existing Prisma-client watcher pattern. All three watchers share a single 300ms debounced timer.

### Patch Changes

- [`3b0f7de`](https://github.com/enyineer/simple-unconference/commit/3b0f7de9f0cafdea2260fd09b3c02249fc4564e8) Thanks [@enyineer](https://github.com/enyineer)! - Polish the profile page and directory tab for mobile and visual consistency.

  Profile page: the avatar previously rendered at a fixed `256×256`, which dominated narrow viewports. It now sizes responsively (`160×160` on desktop, `88×88` on mobile) and opens in a full-viewport lightbox on click (dismiss with click anywhere or Esc; body scroll is locked while open). Each entry row collapses from `label | value | copy` to a 2-row stack on screens ≤640px so long values get the full width instead of competing with a fixed label column. The "Tags", "Web & socials", and "Contact" sections are now wrapped in `Card` to match the header's chrome, and the in-card heading was demoted from `h1` to `h2` (the page already owns the document-level heading context).

  Directory tab: `YourProfileCard` and `DirectoryRow` now share the same row chrome — the accent-left stripe on the viewer's own row is gone, replaced by an inline "You" badge next to the name, so the directory reads as one consistent list. Rows collapse on screens ≤480px (actions drop below the text instead of being squeezed against the avatar), long names and subtitles ellipsize (subtitle line-clamped to 2 lines), the search input gained a clear (×) button when populated, and a result count line ("12 profiles match your filters") appears above the list.

- [`b9d0ca5`](https://github.com/enyineer/simple-unconference/commit/b9d0ca598df0340f2fcdf6fc487f0f654aa85743) Thanks [@enyineer](https://github.com/enyineer)! - Internal: split the largest source files into focused modules, and fail fast in dev when the API port is already bound.

  The nine largest files (`src/server/rpc.ts` at 4466 lines, `AgendaTab.tsx` at 3448, `SessionsTab.tsx` at 1528, `Calendar.tsx` at 1005, `ExpertsTab.tsx` at 985, `SettingsTab.tsx` at 926, `shared/contract.ts` at 915, `MyAssignmentsTab.tsx` at 718, and `shared/schemas.ts` at 555) have been split by router / component / domain into per-file modules under `src/server/rpc/`, `src/web/conference/tabs/<area>/`, `src/shared/contract/`, and `src/shared/schemas/`. Public exports and import paths used by external consumers are preserved (the shared entry files now re-export from the sub-modules), so no calling code changed. Behavior is identical: typecheck clean, lint clean, all 320 tests pass.

  Dev port guard: `Bun.serve` previously used `reusePort: true` unconditionally, which let a freshly-started dev API silently bind alongside an orphaned old process and answer half the requests. `reusePort` is now enabled only for forked cluster workers (which have `WORKER_ID` set). Single-process mode — `bun dev`, `bun start`, and `WORKERS=1`/unset — leaves it off, so a port collision surfaces as a hard `EADDRINUSE` instead of two backends serving stale code in parallel. Multi-worker production behavior is unchanged.

## 0.7.0

### Minor Changes

- [`4fe5b60`](https://github.com/enyineer/simple-unconference/commit/4fe5b60118e562dd4fbb4fc3c1704a590de4a2ad) Thanks [@enyineer](https://github.com/enyineer)! - Path C follow-ups: parallel-star correctness, auto-room scheduling for planned tracks, and soft capacity warnings.

  **Algorithm correctness (Path C gap fix).** A participant who starred a session that's scheduled as a planned track in an _overlapping_ slot now correctly counts as busy in the unconference algorithm — they're locked into the planned track and will no longer be auto-placed into a parallel unconference session. Previously the busy-user set only considered explicit `UserAssignment` rows, so derived planned-track attendance was invisible to the algo. The same fix applies to `avoidRepeats` cross-slot history: a starred planned-track session counts as already attended for rotation purposes. Submitters and mandatory tracks follow the same rule — if the planned track is mandatory in an overlapping slot, every participant is busy; if you submitted the session, you're busy regardless of stars. No algorithm change in `assignment.ts` — only the route-layer data feed.

  **Auto-room scheduling for planned tracks.** New moderator action _Add session → Auto-assign room_. Mods pick a Submission; the server picks the room using a deterministic priority: `Submission.preAssignedRoomId` (hard pin) → `Submission.roomRequirements` (tag constraints) → largest free room in the slot's effective scope. Conflicts come back as a structured payload — `pin_room_taken`, `pin_room_out_of_scope`, `unsatisfiable_requirements`, or `no_free_room` — surfaced as readable toasts that tell the mod what to clear, repin, or reconfigure. The existing per-room "pin to this room" buttons remain as a secondary affordance. Implemented as a new RPC `agenda.scheduleSubmission`; no schema change. The unconference matcher is untouched.

  **Soft capacity warnings.** When the number of stars on a session exceeds the room's capacity, both moderators and participants now see a clear advisory badge:

  - **Moderator side:** the planned-track editor and the unconference-placement detail both show `⚠ Room may be full (stars/capacity)`. Hovering reveals how many starrers are likely unplaced.
  - **Participant side:** the `My schedule` row for a planned track shows `room may be crowded (stars/capacity)`, signalling that arriving early or watching for an upgrade is worthwhile.

  Capacity is advisory only — the algorithm still places popular sessions in whatever room is largest, and stars are never refused. To clarify a question that came up: a much-starred session is **always placed**. The unconference top-N is purely star-driven; capacity only clips per-user assignments, not the placement itself. So a 100-star, 50-cap session runs as expected; 50 attendees are placed; the remaining starrers either land in another starred session or appear as unplaced (with the option to switch).

  **Internals.** `AssignmentOut` gains `expected_attendance` and `room_capacity` (static rows only). `PlacementOut` gains `star_count` and `room_capacity`. `AssignmentRulesModal` has a new _Planned tracks & soft capacity_ section explaining the unified star model, the cross-slot busy rule, and the advisory nature of the warning. Regression tests cover all four new busy-user paths (star, submitter, mandatory, avoid-repeats derivation) and every conflict reason of `scheduleSubmission`.

- [`884d091`](https://github.com/enyineer/simple-unconference/commit/884d091d8ebfef113f421abca35fe427779391b5) Thanks [@enyineer](https://github.com/enyineer)! - Moderators can now export all pending invites as CSV from the People tab.

  The "Pending invites" section now has a "Download CSV" button (visible to moderators and owners) that downloads every still-unclaimed invite with `email, role, token, url, created_at, expires_at`. The file is RFC 4180-escaped and ships with a UTF-8 BOM so Excel opens non-ASCII addresses correctly. Useful for feeding invite links into mail-merge tools or other systems without copying each row by hand.

- [`60ddda3`](https://github.com/enyineer/simple-unconference/commit/60ddda3e4b6831937cae85913fc57076d94aed4c) Thanks [@enyineer](https://github.com/enyineer)! - Mods and owners no longer count against the per-user session submission cap.

  `MAX_SESSIONS_PER_USER_PER_CONFERENCE` (default 5) exists to prevent participant spam — but it also blocked organizers from seeding the agenda with keynotes, sponsor talks, and prepared workshops before opening submissions to the room. The cap is now skipped server-side for moderator/owner principals (including the mod-on-behalf-of-a-participant path: if a mod explicitly attributes a session to someone else, the attributee's cap doesn't apply either, since the mod has made the trust decision).

  The Sessions tab no longer renders the "X / N submissions used" hint for mods/owners; participants still see their remaining quota and still get a `quota_exceeded` error past the cap.

  Other instance-scale caps (`MAX_PARTICIPANTS_PER_CONFERENCE`, `MAX_PENDING_INVITES_PER_CONFERENCE`, `MAX_ROOMS_PER_CONFERENCE`, `MAX_CONFERENCES_PER_USER`, `WRITES_PER_HOUR_PER_USER`, login lockout) are unchanged — they guard resource bounds, not user behavior, and bypassing them for mods would defeat their actual purpose.

- [`5a39ad7`](https://github.com/enyineer/simple-unconference/commit/5a39ad707dd17206c350b9920f4ed5c13daad829) Thanks [@enyineer](https://github.com/enyineer)! - Mods can now duplicate any agenda slot as a linked offering. Use cases: the same workshop running in a 10am and a 2pm block, a keynote repeated for capacity, an open discussion offered three times a day.

  A duplicated slot joins (or creates) a `SlotSeries`. The series owns the shared config — room pool, eligible submissions, repeat-avoidance flags, type — and is edited once via the series form; per-instance fields (time, title, description) remain on each offering. Each slot in the calendar shows an "Offering N of M" badge with prev/next arrows for jumping between siblings without closing the sheet.

  For planned slots, the source's `TrackAssignment` rows are copied onto the new offering so the duplicate carries the same content (subject to the explicit per-offering placement-cap warning shown when duplicating). When a `setSeries` edit would orphan existing tracks/placements (e.g. removing a room that's already used), the server short-circuits with a confirmation request listing exactly what would be removed; the mod re-submits with `confirm: true` to cascade-delete and apply.

  For unconference + mixer slots, the assignment algorithm picks up a new `avoidRepeatsAcrossSiblings` series-level flag (default on): a participant placed in a session in one sibling won't be re-placed in the same session in another sibling. Turn it off for series where attending twice is the point.

  Mods can detach a single offering back to standalone (snapshots the series's current config onto the slot), or dissolve the series entirely with "Disband series" (keep slots) / "Delete with offerings" (drop everything). A series that ends up with one remaining member auto-detaches — no pointless "Offering 1 of 1."

  Also fixed: duplicating a planned slot used to leave the duplicate empty because `TrackAssignment` rows weren't copied.

- [`60ddda3`](https://github.com/enyineer/simple-unconference/commit/60ddda3e4b6831937cae85913fc57076d94aed4c) Thanks [@enyineer](https://github.com/enyineer)! - App-wide toast notification system, transfer-ownership UI, and TabBar scrollbar fix.

  **Toasts replace status banners across the app.** Action-result feedback (errors, successes, info, warnings) now surfaces as floating cards anchored to the bottom-right (full-width on mobile, safe-area aware) instead of as top-of-tab `<Banner>`s. The old pattern hid errors off-screen when a user was scrolled to a deep action (the Danger zone in Settings was the trigger); toasts decouple feedback from page scroll position. Errors and warnings hang around 8s with `role="alert"` + `aria-live="assertive"`, success/info dismiss after 5s with polite live regions, and every toast is manually dismissable.

  The new `useToast()` hook (imported from `design-system/hooks`) returns `{ error, success, warning, info, dismiss }`. The provider mounts once inside `<DesignSystemProvider>` in `App.tsx`. CSS vars from the active design-system plugin drive the colors so both Primer and Minimal plugins surface toasts identically.

  **Migrated to toasts**: every form-submit / button-click / mutation-result feedback site — Login, ConferenceLogin, Join, Conferences ("New conference"), SettingsTab (all section saves + Danger zone + Join link), RoomsTab (Add/Edit room), PeopleTab (Invite single + bulk + revoke + remove), SessionPicker (pick / unlock), MyAssignmentsTab (CalendarSubscribe reset), ExpertsTab (book / cancel / promote / demote / pool CRUD / timeframe CRUD / expert edit), and AgendaTab (assignment results — clean / partial / conflict — slot create / slot edit / conflict-resolver apply).

  **Stays as inline `<Banner>`**: persistent in-context state, not user-action results — Conference.tsx fatal page-load failure, Join.tsx invite-link-can't-be-used page, ExpertsTab.tsx "you need a room or pool first" precondition warning. Form-level field errors (the `useForm` field-by-field validation) continue to render inline under each input.

  **Other fixes bundled in:**

  - **Owner-side "Transfer ownership" UI** in the Settings Danger zone. The backend `conferences.transferOwnership` endpoint already existed; this wires up a confirm form (email input → click Transfer → navigate back to conferences list) and maps `user_not_found` / `same_user` to friendly messages.
  - **TabBar vertical-scrollbar fix.** `overflow-x: auto` implicitly turns `overflow-y` from `visible` into `auto` per CSS spec; combined with the buttons' `margin-bottom: -1` border-overlap trick, this surfaced a spurious vertical scrollbar in the conference page header. Pinning `overflow-y: hidden` suppresses it.

- [`5a39ad7`](https://github.com/enyineer/simple-unconference/commit/5a39ad707dd17206c350b9920f4ed5c13daad829) Thanks [@enyineer](https://github.com/enyineer)! - Unified the "star" concept. A single star on a Submission now drives BOTH the unconference algorithm AND planned-slot schedule visibility — no more confusion about why starring on the Sessions tab didn't put the talk on your schedule.

  **For participants:** clicking "Star" anywhere (the Sessions tab card or the calendar's star toggle on a planned track) writes the same `Submission.Star` record. Every linked planned-slot `TrackAssignment` that references a session you starred now derives onto your `My schedule` and your iCal feed automatically. Submitters always see their own scheduled speaking gigs without needing to star themselves; mandatory tracks remain force-attended for everyone.

  When the same Submission is scheduled across multiple offerings (sibling slots of a series, or independent placements), one star yields multiple schedule rows; the schedule view groups them with a _"Same session also at HH:MM"_ caption so you know they're the same content. Time-overlapping starred rows surface a _"conflicts with X"_ pill.

  **For mods:** every planned track is now anchored to a Submission. Custom-title tracks are gone — to schedule an invited speaker, create a Submission for them first (the editor surfaces a required session picker; the optional `speakers` field is now for co-presenter / addendum text only).

  The "finished" badge has been split + renamed by cause:

  - **Fully scheduled** — the submission's placement cap is reached (algorithm exclusion only).
  - **Marked complete** — the mod manually flipped `manually_finished`.

  Both are informational only under the new model: participants still see and can star these submissions, and the star still derives any linked planned tracks onto their schedule. Only the unconference algorithm pool excludes them.

  **Internals:** the `StaticStar` table is gone. `TrackAssignment.submissionId` is now `NOT NULL` and the `title` column is dropped (display title comes from the linked Submission). `MyAssignments` derivation joins TrackAssignments against the user's `Star`s + mandatory + submitter-self in a single query. The `agenda.starTrack` / `agenda.unstarTrack` endpoints have been removed from the contract.

  A migration mirrors any existing `StaticStar` rows into Submission stars before dropping the table. Existing custom-title tracks need converting to a Submission first (the migration errors clearly if any remain).

- [`fa8775c`](https://github.com/enyineer/simple-unconference/commit/fa8775c464733d3545bb34c2ae9906799118a3a0) Thanks [@enyineer](https://github.com/enyineer)! - Per-conference user profiles, a directory tab, and link-everywhere navigation.

  Each attendee can now publish a profile with a bio, pronouns, title, company, avatar, free-form web/social links, contact entries, and tags. Profiles are opt-in (a "Published" toggle gates visibility) and per-entry public flags let people share a public LinkedIn while keeping a Signal number visible only to moderators.

  A new **Directory** tab (visible to all members) lists every published profile with debounced search and tag filtering. The viewer's own card is pinned at the top with "View" / "Edit" buttons, so setting up or updating your profile is one click from the directory. People + Rooms tabs remain moderator-only.

  Names in the **Sessions**, **Agenda**, and **Experts** tabs render as profile links when the target has published a profile (moderators always get a link). Unlinked names remain plain text so non-mods never get a dead-end click.

  Avatars are stored as 256×256 WebP under `data/avatars/<conf>/<id>.webp`, served at `/api/avatars/:slug/:identityId[/:hash]` with content-hash-based cache busting. Hashed URLs are publicly cacheable for one year when the profile is published; unpublished or stale-hash requests fall back to private or no-store caching, and any profile not visible to the viewer returns an initials SVG (never a 404) so the existence of an unpublished profile can't be probed.

  Includes 14 server-side privacy regression tests, 11 avatar pipeline tests, schema migrations for `ProfileEntry`, `ProfileTag`, and the new fields on `ConferenceIdentity`, plus permission table + CLAUDE.md updates.

### Patch Changes

- [`5a39ad7`](https://github.com/enyineer/simple-unconference/commit/5a39ad707dd17206c350b9920f4ed5c13daad829) Thanks [@enyineer](https://github.com/enyineer)! - Calendar no longer renders adjacent slots as side-by-side columns when their displayed times read as touching.

  The overlap-clustering algorithm used to compare slot times at millisecond precision while the labels round to `HH:MM`. A slot ending at `18:07:30` (labeled "18:07") next to one starting at `18:07:15` (also "18:07") got rendered side-by-side because they technically overlapped by 15 seconds, even though the labels read as adjacent. Layout now normalizes both edges to whole minutes before deciding overlap, so the rendering matches what the labels show: same-minute touches are no longer treated as overlap.

- [`9168c06`](https://github.com/enyineer/simple-unconference/commit/9168c06f15a02f8812ab0f534529be7261ad45b7) Thanks [@enyineer](https://github.com/enyineer)! - `My schedule` no longer flags adjacent sessions as "conflicts with X" when their labels read as touching.

  Same root cause as the calendar-overlap fix in the previous release: the conflict detector compared raw millisecond timestamps while the displayed times round to `HH:MM`. A session ending at `18:07:30` (labeled "18:07") next to one starting at `18:07:00` got tagged as a 30-second overlap even though the labels read as adjacent.

  Generalized the fix instead of patching each comparison site: every user-set instant (agenda slot starts/ends, expert timeframes, expert bookings) is now clipped to the whole minute that contains it — via a shared `clipToMinute` helper applied at the write boundary (`createSlot` / `updateSlot` / `duplicateSlot` / `createTimeframe` / `book`). Client-side comparators (MyAssignments conflict detector, Calendar overlap layout) use the same helper so display always matches storage.

  Includes a one-time SQL migration that floors existing `agenda_slots`, `expert_timeframes`, and `expert_bookings` timestamps to whole minutes — fixes the rendering immediately for environments that already have sub-minute legacy data without needing app-level backfill.

- [`8d9ebb3`](https://github.com/enyineer/simple-unconference/commit/8d9ebb3063f75e34ad732bc45eede94ab21c7f76) Thanks [@enyineer](https://github.com/enyineer)! - `My schedule`'s "Same session also at …" caption now prefixes the day when sibling offerings span multiple days.

  Previously, a session repeated across days rendered as e.g. "Same sessions also at 17:07, 20:07" with no indication that one of those was the next day — easy to misread as three same-day repeats. When the alternates cross a day boundary in the conference timezone, each entry now reads "Sat 23 May 20:07". Single-day groups are unchanged.

- [`5a39ad7`](https://github.com/enyineer/simple-unconference/commit/5a39ad707dd17206c350b9920f4ed5c13daad829) Thanks [@enyineer](https://github.com/enyineer)! - Every user action now confirms via toast — no more silent deletes, no more leftover inline success banners, no more `alert()` for errors.

  Audited and fixed across SessionsTab (create / delete / publish / unpublish / reject / star / unstar), AgendaTab (slot delete, track set/clear, slot configure save, mixer room selection, mixer avoid-mode), RoomsTab (create / update / delete), and PeopleTab (revoke invite, promote / demote, remove participant). Inline form-validation `Banner`s stay where they belong (next to the form input that's invalid).

  Also extracted a shared `CopyButton` component so every "copy to clipboard" action gives the same feedback shape — inline label toggle (Copy → ✓ Copied for 1.5s) PLUS a success toast PLUS a `window.prompt()` fallback when the clipboard API is blocked. Previously the SettingsTab "Join link" Copy button was completely silent, while the My-schedule "Copy" button had inline-only feedback and the PeopleTab "Copy link" had nothing. All three now use the shared component and behave identically.

## 0.6.5

### Patch Changes

- [`e936dd6`](https://github.com/enyineer/simple-unconference/commit/e936dd626280b6b0f2464db48ffcfd731d739784) Thanks [@enyineer](https://github.com/enyineer)! - Replace the broken "Open in calendar app" button on Firefox for Android with paste-by-URL instructions.

  Firefox for Android deliberately blocks dispatch of non-allowlisted schemes (incl. `webcal://`) to external apps as a Mozilla security policy, so the existing button was a no-op there. Serving the plain `https://` URL would technically "do something" but only as a one-time `.ics` import, losing the auto-update subscription behavior the panel promises.

  On Firefox Android, the green button is now replaced inline with a muted instruction asking the user to copy the URL above and paste it into their calendar app's "Add by URL" / "Add subscription" setting — preserving the real subscribe-with-updates flow. Every other browser keeps the `webcal://` one-click button unchanged.

## 0.6.4

### Patch Changes

- [`04ab3d5`](https://github.com/enyineer/simple-unconference/commit/04ab3d52b1fc22d878b071930828be52952c303a) Thanks [@enyineer](https://github.com/enyineer)! - Mobile layout polish, safe-area handling, and consistent muted-text sizing.

  - **Settings page on mobile.** Settings cards now collapse to a single column under 640px (description above the controls) so inputs aren't crushed by the 280px description column on a narrow viewport.
  - **Sheets on mobile.** Sheets switch from full-height right-drawer to a content-sized bottom sheet (max-height 92dvh, rounded top corners) on `max-width: 640px`, eliminating the empty void below short forms that the user could scroll into. Header and body honor `env(safe-area-inset-*)` for left/right/bottom insets.
  - **Safe-area / gray bar.** Added `viewport-fit=cover` and painted `<html>`/`<body>` with the theme background in both design-system plugins, so the strip under the Android URL bar / iOS gesture area picks up the theme color instead of showing a default gray bar. `PageLayout` padding also picks up the safe-area insets.
  - **"Open in calendar app" on Firefox Android.** Now renders as a real `<a href="webcal://…">` instead of `window.location.assign(...)`, which Firefox Android silently drops for unknown schemes. A real link click dispatches to the OS intent resolver so an installed calendar app can claim it.
  - **Stacked checkbox layout.** Session-edit checkboxes (`Mark as finished`, `Allow placement in overlapping slots`) and the agenda-track `Required for all participants` checkbox now put the muted description on its own line below the bold label, instead of trailing it inline (where it crowded into a tiny column and wrapped awkwardly on narrow viewports).
  - **Consistent muted text size.** `<Text muted>` in both design-system plugins now renders at the hint size (12px / 16px line-height) instead of inheriting Primer's body default. Brings the 25 callsites (loading states, empty states, field-level explanations) in line with the inline `fontSize: 12` hints used throughout forms.

## 0.6.3

### Patch Changes

- [`78f7582`](https://github.com/enyineer/simple-unconference/commit/78f75822a882d62113a49b1f562e5c1a1b7059f5) Thanks [@enyineer](https://github.com/enyineer)! - Chart: annotate the SQLite PVC with `helm.sh/resource-policy: keep` so `helm uninstall` no longer drops the database.

  Local-path (and many other dynamic) storage classes default to `persistentVolumeReclaimPolicy: Delete`. Combined with helm owning the PVC, a stray `helm uninstall` (or a GitOps controller recreating the release) would delete the PVC → PV → on-disk SQLite file with no recourse. The `keep` policy makes Helm leave the PVC alone on uninstall; if you actually want to drop the data, `kubectl delete pvc <name>` it explicitly.

  Existing installs aren't migrated automatically — annotate the PVC in place once:

  ```
  kubectl -n <ns> annotate pvc <release>-simple-unconference-data \
    helm.sh/resource-policy=keep
  ```

## 0.6.2

### Patch Changes

- [`7d8a48b`](https://github.com/enyineer/simple-unconference/commit/7d8a48b98072e7c4f777b0b341ceb0ddcd74a3fc) Thanks [@enyineer](https://github.com/enyineer)! - Add ESLint, a CI workflow that runs typecheck/lint/tests on PRs, and GitHub issue templates (bug report, feature request) adapted from `enyineer/checkstack`.

  ESLint flat config (v9) bundles the de facto standard rulesets: `@eslint/js`, `typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks` v7 (compiler-aligned), and `eslint-plugin-react-refresh`. All resulting violations are fixed at the source rather than silenced.

  Notable refactors driven by the new rules:

  - `useNow()` hook (in `src/web/useNow.ts`) replaces `Date.now()` calls in component render paths for `isPast` / `expired` checks (react-hooks/purity).
  - Async data fetches in `App.tsx`, `Conference.tsx`, `NotificationBell.tsx`, `AgendaTab.tsx`, `MyAssignmentsTab.tsx`, `PeopleTab.tsx`, `RoomsTab.tsx`, `SessionsTab.tsx`, `SettingsTab.tsx`, and the design-system provider now read with `.then(setX)` + cancellation flags instead of awaiting in async helpers, so `setState` no longer fires synchronously in effect bodies. Reset-on-prop-change patterns are reworked into slug-tracked derived state or render-time state adjustment (react-hooks/set-state-in-effect).
  - Design-system plugin files are split into `components.tsx` (component exports) + `index.tsx` (plugin object), and `useDesignSystem` moves to its own `context.tsx`, so component files stay Fast-Refresh-friendly (react-refresh/only-export-components).
  - `useForm`'s generic is constrained to `Record<string, unknown>`, removing `any` casts; remaining design-system `as any` shims were either replaced with proper Primer types or removed where the value was already assignable.

## 0.6.1

### Patch Changes

- [`8a2b12b`](https://github.com/enyineer/simple-unconference/commit/8a2b12bad53b8a092fed3d8ffa519354315d9410) Thanks [@enyineer](https://github.com/enyineer)! - Fix Turnstile race where the form rejected a verified widget with "Please complete the verification challenge before continuing."

  The previous flow stored the token in React state via the widget's `callback`, then read that state at submit time. If the user clicked the submit button between Cloudflare painting the green checkmark and the callback landing in React state, the submit handler saw an empty token and short-circuited with the captcha error.

  `TurnstileWidget` is now a `forwardRef` exposing a `TurnstileWidgetHandle` with `getResponse()` (delegates to `window.turnstile.getResponse(widgetId)`) and `reset()`. `Login.tsx` and `Join.tsx` read the token straight from the widget at submit time instead of from React state, and call `reset()` on error to mint a fresh single-use token for the retry.

## 0.6.0

### Minor Changes

- [`d6ab7eb`](https://github.com/enyineer/simple-unconference/commit/d6ab7eb37efec74a39a8573d1cfdd91649d4bf34) Thanks [@enyineer](https://github.com/enyineer)! - Self-service account lifecycle: two new authenticated RPCs.

  - `auth.deleteSelf` deletes the calling owner's User row. Sessions cascade via the existing FK so all the user's devices are signed out; the response clears the global cookie. **Refuses with `owned_conferences_present` (error data: `{ owned: string[] }`) when the caller still owns conferences** — those carry other people's data and shouldn't be silently orphaned. Caller must first delete or transfer each conference.
  - `conferences.transferOwnership({ new_owner_email })` hands ownership of a conference to another existing global User by email. Owner-only. The new owner's `ConferenceIdentity` auto-mints on their next visit; the previous owner loses owner-level access (re-invite as moderator if needed). Errors: `user_not_found`, `same_user`.

  The loadtest runner now uses `auth.deleteSelf` to teardown the owner account it creates during bootstrap. Combined with the existing `conferences.delete()`, runs leave no trace on the target by default. Pass `--no-cleanup` to skip teardown for debugging. Falls back gracefully (warning, no error) when run against older releases that don't have these endpoints yet.

- [`a97b5ff`](https://github.com/enyineer/simple-unconference/commit/a97b5ff38092d15495fbb434d193e453ead143e8) Thanks [@enyineer](https://github.com/enyineer)! - Prometheus-compatible `/api/metrics` endpoint + larger default PVC.

  - **`GET /api/metrics`** exposes instance-wide gauges: row counts (`users_total`, `conferences_total`, `conference_identities_total`, `submissions_total` plus `submissions_by_status_total{status="…"}`, `stars_total`, `notifications_total`, `rooms_total`, `invites_total`/`invites_unclaimed_total`, `experts_total`, `expert_bookings_total`), storage (`storage_pvc_total_bytes`, `_free_bytes`, `_used_bytes` from `statfs`, plus `storage_db_file_bytes` from the SQLite file), and runtime (`app_uptime_seconds`, `app_worker_id`). Cheap to scrape — Prisma counts + one `statfs` call, computed on demand. Mounted before the oRPC catch-all so it owns `/api/metrics` and never reaches the RPC handler.
  - **`METRICS_TOKEN` env var** (chart: `metrics.token`) optionally gates the endpoint with `Authorization: Bearer <token>`. Unset = open, for in-cluster scrape via the Service.
  - **ServiceMonitor template** rendered when `metrics.serviceMonitor.enabled: true` for prometheus-operator users. Auto-emits a matching `Secret` carrying the token and references it via `spec.endpoints[].authorization` so no manual wiring is needed.
  - **Smart `DATA_DIR` resolution** for local dev: falls back through `/app/data` → `./data` → CWD when not explicitly set, and logs a one-time `[metrics] data dir resolved to …` line at startup so the zeros in `storage_*` gauges never mystify someone running `bun dev`. `statfs` failures also warn once instead of silently zeroing.
  - **PVC default bumped 2Gi → 5Gi** in the chart. Per the row-size math in `docs/loadtest-results.md`, 5Gi gives a public instance ~150 fully-saturated 2000-attendee events of headroom; the previous 2Gi was reasonable but tight for hosted use.
  - **README**: new "Metrics" section with the full table of gauges and a manual scrape-config example for non-operator setups.
  - **Tests**: 4 new cases cover open access, missing Bearer (401), wrong token (401), and valid token (200) plus the Prometheus exposition-format shape. Full suite 259/259.

- [`fcdc3df`](https://github.com/enyineer/simple-unconference/commit/fcdc3df318b9ff438cfa1a2bdfbd66368e5160c2) Thanks [@enyineer](https://github.com/enyineer)! - Public-instance hardening: four layered defenses, all opt-in via env vars (Docker-friendly) and Helm chart values, every one disable-able individually with a `0` / empty value.

  - **Cloudflare Turnstile** gating on `auth.signup`, `auth.login`, `conferences.claimInvite`, and `conferences.signupViaLink`. Set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to enable; leave either empty for a no-op. The site key is exposed through `config.get` so the SPA lazy-loads the widget only when enabled. `claimInvite` is gated too so an abusive moderator can't burn the participant cap by self-inviting + bot-redeeming fake emails they control.
  - **Per-email failed-login lockout** on both global `auth.login` and per-conference `conferences.login`. NAT-blind (per-email, not per-IP) so venue Wi-Fi works fine. Defaults: 5 failures / 15-min window → 15-min lockout (`LOGIN_FAIL_LIMIT`, `LOGIN_FAIL_WINDOW_MIN`, `LOGIN_LOCKOUT_MIN`).
  - **Per-account write rate** (sliding 1-hour window, default 600/user via `WRITES_PER_HOUR_PER_USER`) applied to expensive `create`/`update` operations. Stars and notification marks are exempt — legitimate bursts during agenda review are normal.
  - **Per-account / per-conference quotas**: `MAX_CONFERENCES_PER_USER` (3), `MAX_SESSIONS_PER_USER_PER_CONFERENCE` (5), `MAX_PARTICIPANTS_PER_CONFERENCE` (2500), `MAX_PENDING_INVITES_PER_CONFERENCE` (2500), `MAX_ROOMS_PER_CONFERENCE` (100). Defaults sized for events up to ~2000 attendees; private deployments raise via env or set to `0` for unlimited.

  Helm chart adds `limits:` and `turnstile:` blocks that emit the corresponding env vars. The Login + Join pages render the Turnstile widget when `config.get` reports a site key; the script loads lazily on first mount and is cached for subsequent ones. Error codes returned to the client: `quota_exceeded` (with `data: { resource, limit, current }`), `account_locked`, `rate_limited`, `captcha_required`, `captcha_failed`.

  README adds a [Public-instance hardening](https://github.com/enyineer/simple-unconference#public-instance-hardening) section explaining the four-layer design and why per-IP rate limits would be wrong for the venue-WLAN traffic pattern. The free public instance at <https://unconference.enking.dev> runs with these defaults enabled.

- [`84814ff`](https://github.com/enyineer/simple-unconference/commit/84814fff4d179f6457a64e535b2ab10f63c6fe44) Thanks [@enyineer](https://github.com/enyineer)! - Make quotas visible — error messages, usage panel, threshold notifications.

  - **Specific error messages** for every `quota_exceeded` response. New `src/web/quotaErrors.ts` resource-switches on `data.resource` and renders a real sentence with the actual limit (e.g. "You've reached the limit of 5 sessions for this conference. Delete one of yours before submitting another.") instead of the raw code. Wired into every page that can hit a quota: Login, Conferences, Join, SessionsTab, RoomsTab, PeopleTab.
  - **Mod-only Usage card** in the Settings tab. Shows live counters for Participants, Pending invites, Rooms, and Total sessions against their configured caps, with progress bars that turn yellow at 80% and red at the cap. Reads from a new `usage` field on the `conferences.get` response (populated only when caller is moderator+).
  - **Threshold notifications.** When a `claimInvite`, `signupViaLink`, `createInvite`, or `rooms.create` insert crosses 80% or hits 100% of its cap, all conference moderators get an inbox notification (`kind: "quota_threshold"`) so they can raise the limit before the wall is hit. Fires once per integer crossing — no spam.
  - **Owner-side quota hint** on the global Conferences page. Counts conferences the viewer owns against `MAX_CONFERENCES_PER_USER` (now exposed via `config.get`), with the same yellow-at-80% / red-at-cap colour treatment.
  - **Per-user session cap visibility** on the Sessions tab. Shows "X of N session submissions used" using a new `my_session_count` field on `conferences.get` — counts ALL the viewer's submissions including rejected and finished ones, since those occupy quota slots but aren't returned by `submissions.list` for non-mods. Stays accurate across creates/deletes via an `onSessionMutated` refresh hook.

  Net result: nobody hits a wall as a surprise; the first quota*exceeded is the \_third* signal you've had a chance to act on.

## 0.5.0

### Minor Changes

- [`b11a8fe`](https://github.com/enyineer/simple-unconference/commit/b11a8fef356f910f49c1c0cbadda06a8396cab85) Thanks [@enyineer](https://github.com/enyineer)! - Add multi-worker mode for the container. New `WORKERS` env var (default `1`, byte-identical to previous behavior) spawns N Bun worker processes inside a single pod that share the listening port via `SO_REUSEPORT`. Set `WORKERS=auto` to derive the count from cgroup-reported CPU + memory limits (rule: `min(round(cores), floor(mem_MiB / 192), 8)`; cgroup v1 + v2 supported), or a specific integer to force it. Exposed in the Helm chart as `workers.count`. The launcher supervises children (restart on crash with crash-loop bailout to surface CrashLoopBackOff after 5 failures in 30s) and propagates SIGTERM/SIGINT for graceful shutdown. Each worker's stdout/stderr is piped through the launcher and prefixed with `[wN]` so interleaved log lines stay attributable.

## 0.4.0

### Minor Changes

- [`7c89598`](https://github.com/enyineer/simple-unconference/commit/7c895989992f08c87e71bf69208a43fefdc9986d) Thanks [@enyineer](https://github.com/enyineer)! - Add `DISABLE_SIGNUP` env var to lock down global owner signup. When set to `1`/`true`/`yes`, the signup form is hidden on the login page and `POST /api/auth/signup` returns `403 signup_disabled`. Existing accounts can still sign in. Per-conference participant signup is unaffected. Exposed in the Helm chart as `auth.disableSignup`.

## 0.3.0

### Minor Changes

- [`2c2d8ba`](https://github.com/enyineer/simple-unconference/commit/2c2d8ba83a102269b180e28e4e6fc14d421beb88) Thanks [@enyineer](https://github.com/enyineer)! - Assignment engine: pre-assignment + tag matching + overlap rules

  - **Pre-assignment (pin to room)**: moderators can pin a session to a specific room from the Sessions tab. The pin always wins over star-based room ranking and required features.
  - **Required room features**: sessions can request tag-based features (projector, whiteboard, etc). The picker only offers tags that actually exist on at least one room. The algorithm restricts candidate rooms to those whose tag set is a superset of the requested features.
  - **Bipartite matching with post-processing**: tag-constrained sessions are matched to rooms via Kuhn's algorithm, then a swap pass canonicalizes "popular gets bigger room" among feasible matchings.
  - **Up-front cascade conflict analysis**: when a session can't be matched, the algorithm tries the next-most-starred candidate and surfaces every session that would conflict in one comprehensive resolve panel — no more iterative resolve / re-run rounds.
  - **Overlap rules**: assignment now automatically excludes (a) rooms used by overlapping slots, (b) submitters speaking in overlapping slots, (c) sessions placed in overlapping slots (configurable per session via `allow_overlapping_placements`), and (d) participants assigned to overlapping sessions. Exclusions are reported informationally in the run banner.
  - **Resolve panel redesign**: radio-list per session with clear option descriptions, smarter defaults (skip is preselected for tag conflicts), and an Apply button that's disabled until every conflict group has a non-default action.
  - **"How assignment works" modal**: in-app explanation (with mod-only sections) accessible from the slot detail and Agenda header. Documents every rule the engine applies.
  - **UI polish**: condensed slot action row (help trigger on the meta line, Delete pushed to the right), critical banner severity for blocked runs, disabled Run button when there are no rooms or no eligible sessions, generous sheet bottom padding across both design-system plugins, and grab-to-scroll for horizontally-overflowing calendar rows.
  - **Synthetic seed**: new "Unconference round 3 (conflict demo)" slot with sessions designed to surface both `duplicate_room` and `unsatisfiable_requirements` conflicts, plus a `Recurring Workshop` example with overlapping placements allowed.

  Schema migrations (additive): `Submission.preAssignedRoomId`, `Submission.allowOverlappingPlacements`, new `SubmissionRoomRequirement` table.

- [`65cae8c`](https://github.com/enyineer/simple-unconference/commit/65cae8c41637e5bfcd3206a61bfd4104d18f653e) Thanks [@enyineer](https://github.com/enyineer)! - Helm chart + GHCR publish workflow

  - New `charts/simple-unconference` Helm chart supporting both sqlite (with a PVC for persistence) and postgres backends. The chart wires `DATABASE_URL` from a managed Secret; postgres mode can also reference an `existingSecret`.
  - Sensible defaults: `Recreate` rollout strategy (required for the RWO PVC under sqlite), `/api/health` probes, non-root securityContext, optional Ingress.
  - `Release` workflow now packages the chart and pushes it to `oci://ghcr.io/<owner>/charts` after each app release, with `chart.version` and `chart.appVersion` auto-synced to `package.json` so every release ships a matching chart.
  - New `Helm CI` workflow lints and renders the chart on PRs, and fails the PR if `charts/` was modified without a changeset, so chart changes can't ship without a version bump.

- [`925aa1e`](https://github.com/enyineer/simple-unconference/commit/925aa1e4e00b6cf7959b7f295b3476bd58feb59d) Thanks [@enyineer](https://github.com/enyineer)! - Submitter reassignment, mod fields at create, searchable pickers

  - **Reassign submitter**: moderators can change a session's submitter (the conference identity the session is attributed to). Useful when a mod submits on someone else's behalf — the actual speaker shows up as the author instead of the mod. Available in the session edit sheet via the new "Submitter" picker.
  - **Mod-only fields at submission time**: moderators can now set the submitter, pre-assigned room, max placements, "mark as finished" flag, and overlapping-placements toggle directly on the create form — same UI as edit, no more create-then-edit two-step.
  - **Searchable pickers**: long dropdowns (rooms, conference members, sessions, expert pools, timezones) are now type-to-filter comboboxes with keyboard navigation. Short fixed-option selects (slot type, cap mode, design system, etc.) are unchanged.

  Schema change (additive): `CreateSubmissionSchema` now accepts the same optional mod-only fields as `UpdateSubmissionSchema`; the server enforces role and silently drops them for participants.

- [`c99b950`](https://github.com/enyineer/simple-unconference/commit/c99b950188f8a7c964e5bd17a3feca6228728203) Thanks [@enyineer](https://github.com/enyineer)! - Sessions tab: filter bar with search, tag chips, and starred-only toggle

  - **Search**: type-to-filter input matches across title, description, speaker name, session tags, and requirements. Inline clear button resets the query.
  - **Tag chips**: multi-select chips (AND semantics) populated from the tags that actually appear in the currently visible sessions; tags that no longer apply are pruned automatically when switching status.
  - **Starred only**: one-tap toggle to narrow the list to sessions you've personally starred.
  - **Result count + clear**: when any filter is active, a quiet status line shows "Showing X of Y" with a one-click clear; the empty state offers the same clear action.
  - **Mobile-friendly**: filter row wraps to a stacked layout below ~360px, tag chips wrap freely, and all interactive targets stay above 32px.

### Patch Changes

- [`455376a`](https://github.com/enyineer/simple-unconference/commit/455376ad966acd1e42874534598c6979a0d96d0f) Thanks [@enyineer](https://github.com/enyineer)! - SEO: descriptive page title, meta description, Open Graph + Twitter Card tags, and JSON-LD schema

  - **Title**: "Simple Unconference - Self-hosted Unconference Platform" replaces the bare slug.
  - **Meta**: description, keywords, author, robots, generator, application-name, color-scheme.
  - **Open Graph**: type, site_name, title, description, locale, image (links to the agenda-overview screenshot on GitHub raw) and image alt.
  - **Twitter Card**: summary_large_image variant mirroring the OG fields.
  - **JSON-LD**: SoftwareApplication schema pointing at the GitHub repo and author profile.
  - No canonical/`og:url` set since the app is self-hostable and the URL varies per instance.

## 0.2.1

### Patch Changes

- [`785ecd0`](https://github.com/enyineer/simple-unconference/commit/785ecd0b0442eeaf73825a496fafce83e421fbad) Thanks [@enyineer](https://github.com/enyineer)! - Prune the production Docker image: install only `dependencies` (no `vite`, `@types/*`, or changesets tooling) in the runtime stage. `prisma` is now a regular dependency so `prisma migrate deploy` still runs at boot.

## 0.2.0

### Minor Changes

- [`8974c61`](https://github.com/enyineer/simple-unconference/commit/8974c61d42406048feb6504d304e37df24868030) Thanks [@enyineer](https://github.com/enyineer)! - Initial release. Adds a multi-stage Bun Dockerfile, GitHub Actions release pipeline that publishes images to `ghcr.io/enyineer/simple-unconference`, and a changesets-driven versioning workflow.
