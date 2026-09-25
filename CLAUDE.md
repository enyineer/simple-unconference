# Notes for future Claude sessions on this repo

Brief, durable context for working in this codebase. Update when you change
something the next session would need to know.

## Privacy + permission rules (don't regress)

- **Hide the "People" and "Rooms" tabs from non-moderators** in the conference
  UI. Only owners + moderators see them. The tab list lives in `Conference.tsx`
  in `ConferencePage`.
- **Never expose participant emails to non-mods.**
  - `GET /api/conferences/:conf/participants` requires `moderator` role.
  - `GET /api/conferences/:conf/submissions` strips `submitter_email`
    (returns `null`) for participants; mods/owners still see it.
- **Names are OK to expose to everyone.** `submitter_name` is returned to all
  viewers on `/submissions`. The UI uses a `submitterLabel(s)` helper in
  `Conference.tsx` that prefers `name`, falls back to `email` (mods only),
  and renders nothing otherwise. When adding any new place that previously
  showed `submitter_email`, use that helper.
- The permissions table in [README.md](README.md) is the source of truth.
  Keep it in sync with [src/server/lib/permissions.ts](src/server/lib/permissions.ts).
- **`conferences.login` deliberately breaks error-collapsing for three cases**
  (user-approved enumeration tradeoffs): `owner_use_main_login` (email is the
  conference owner's organizer account / password-less auto-minted identity),
  `invite_not_claimed` (unclaimed invite or password-less identity), and
  `organizer_password_used` (typed password verifies against the global
  `User.passwordHash` for that email — safe because it only fires for a
  caller already holding valid organizer credentials). Everything else stays
  `invalid_credentials`. All special paths MUST keep calling
  `recordLoginFailure` first (lockout key `conf:<slug>:<email>`), and the
  global-hash verification MUST double-book failures against the GLOBAL
  lockout key auth.login uses (and skip detection entirely while that account
  is locked) so the conference endpoint can never bypass the global
  brute-force limit. Do NOT add any hint that merely reveals "a global User
  exists with this email" without a verified password — that would let anyone
  enumerate organizer accounts; that case is handled client-side
  (own-session email match in `ConferenceLogin.tsx`) and via copy only. `claimInvite`/`signupViaLink` auto-link the new identity
  (`linkedUserId`) when the request carries a verified global session with
  the same email — the Join page shows an upfront note when that will happen.
- **Expert bookings: never expose other bookers to non-mods.**
  `experts.list` returns `booker_name` / `booker_email` as `null` for every
  slot except (a) the viewer's own booking or (b) when the viewer is mod+.
  The expert's own `email` is also masked from non-mods (parity with
  `submitter_email`). When adding any new endpoint that surfaces an expert
  booking, mirror this rule.
- **Profile privacy.** Unpublished profiles (`profilePublished=false`) are
  invisible to non-mods. `profiles.get` returns `NOT_FOUND` (never
  `FORBIDDEN` — that would leak existence) and `profiles.list` filters them
  out. `ProfileEntry` rows with `isPublic=false` are stripped for non-mods.
  The canonical `ConferenceIdentity.email` is never returned in profile
  responses for non-mods — a public contact email lives in a `ProfileEntry`
  row with `kind="Email"`, `isPublic=true`.
- **Avatars** at `/api/avatars/:slug/:identityId[/:hash]` return an initials
  SVG (not 404) whenever the underlying profile is not visible to the
  viewer — don't leak existence by status code. Hashed URLs get
  `immutable, max-age=31536000` only when the profile is published *and* the
  hash matches; mismatched hashes return `no-store`; unpublished + own-
  identity gets `private` caching only.
- **`submitter_profile_published` on `SubmissionOut`** (and `profile_published`
  on `ExpertOut`) exist so `ProfileLink` can render names as plain text
  when the target has no published profile — non-mods never get a click
  that lands on "Profile not found." Mods always link (server lets them
  see unpublished profiles). Anywhere a name is rendered with
  `ProfileLink`, pass `linkable={isMod || target.profile_published}`.
- **Chat eligibility.** `canChatWith` in
  [src/server/lib/permissions.ts](src/server/lib/permissions.ts) is the
  single source of truth: both sides must be `profilePublished=true` AND
  `chatEnabled=true`, neither banned, no `ChatBlock` either way. Mods
  bypass the published check (for moderation outreach) but still respect
  ban/block. Map reasons: `self` → `BAD_REQUEST`, `not_published` →
  `NOT_FOUND` (never `FORBIDDEN` — would leak existence), everything else →
  `FORBIDDEN`. Any new chat-adjacent endpoint goes through this helper.
- **Chat email rule.** Chat responses NEVER include either participant's
  canonical email. Names + identity IDs only, matching the wider profile
  privacy contract.
- **Read receipts.** `Message.readAt` is stripped from the *sender's*
  serialization when the *recipient* has `chatReadReceiptsEnabled=false`.
  Receiver always sees their own read state locally (they need it for the
  unread badge). All chat serialization goes through `serializeMessage()`
  in [src/server/rpc/chat-helpers.ts](src/server/rpc/chat-helpers.ts) so
  the rule can't drift between procedures.
- **Chat bans must be enforced at the router level**, not the UI. The
  `chatBannedAt`/`chatBannedReason` fields on `ConferenceIdentity` are
  surfaced via `chat.getSettings`; the actual block happens inside
  `canChatWith`. The UI's only job is to render the disabled composer
  with the reason.
- **Soft-delete cascade.** Don't hard-delete chat messages on identity or
  conference removal directly. `Message.deletedAt` + `deletedReason`
  (`"user"`, `"moderator"`, `"account_deleted"`, `"conference_deleted"`)
  is the audit-friendly path. `MessageReport.messageId` is
  `onDelete: Restrict`, so conference deletion is blocked by open
  reports (`conferences.delete` checks first and returns
  `open_chat_reports` error if any).

## UI conventions

- **Slot detail sheet should not list unassigned rooms.** `StaticBody` only
  renders rooms that have a track; moderators get an `AddTrackPicker` to
  attach a track to an unassigned room when they want to. Don't iterate
  `rooms.map(…)` in slot displays without filtering by `tracks.find`.

## Event Experience Suite (Live Board, broadcast, takeaways, PWA)

- **Live Board privacy + spotlight truth.** The board payload rules live in the
  Realtime section below. The CURRENT spotlight is mod-readable via
  `AgendaOut.spotlight_submission_id` — the Pitch Mode sheet seeds from it;
  never reintroduce client-side spotlight guessing (localStorage etc.).
- **Takeaways UI is ONE component**: `src/web/conference/ui/TakeawaysPanel.tsx`
  (lazy-loads on first Disclosure expand), used by SessionCard and the Me-tab
  RecapSection. Server caps: 500 chars, 10 per identity per submission;
  visibility = published-or-own; author or mod deletes. Payloads carry display
  names only, never emails.
- **conferences.duplicate** clones CONFIG + rooms (tags, availability windows
  offset to the new first day) + slot/series skeleton (incl. SlotRoom/SeriesRoom
  scoping remapped) — never people, submissions, placements, experts, or
  tokens. It shares `generateUniqueSlug` and the conference quota guard with
  `create`; keep them shared.
- **Service worker** (`src/web/public/sw.js`, prod-only registration): bump
  `CACHE_VERSION` whenever its caching behavior changes; NEVER let it cache
  non-GET, `/api/realtime*`, or `/api/board/*/stream`. The static server sends
  `Cache-Control: no-cache` for sw.js — keep that, or stale workers can pin old
  code forever. Read-only offline is the deliberate scope: no write queueing.
- **Announcements** (`announcements.send`) fan out through `createNotifications`
  (kind `announcement`, no dedupeKey). The live toast for in-app users lives in
  NotificationBell's fetch path (baseline-guarded so mounts don't replay the
  backlog) — don't add a second delivery surface.

## Stack gotchas you will hit if you forget

- **Prisma adapter:** we use `@prisma/adapter-libsql` (pure JS), not
  `@prisma/adapter-better-sqlite3`. `better-sqlite3` doesn't load in Bun yet
  ([oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)). If you
  switch, the server boots fine but every query throws `ERR_DLOPEN_FAILED`.
- **Prisma 7 config:** the datasource URL lives in [`prisma.config.ts`](prisma.config.ts),
  **not** in `schema.prisma`. The `datasource db {}` block has only `provider`.
- **Prisma CLI in tests:** `prisma db push` in Prisma 7 dropped `--skip-generate`.
  Pass `--url <url>` to override per-test DBs (see `test-helpers.ts`).
- **Never hand-fabricate migration folders.** Create migrations with
  `bunx prisma migrate dev --name <name>` (or `--create-only` + edit) and
  ALWAYS apply them locally before finishing. Tests bypass migrations
  (`db push` from the schema hash), so an unapplied migration keeps the suite
  green while the dev server crashes with `no such table` — this happened
  once. Prod applies pending migrations via `migrate deploy` at startup, so a
  hand-written-but-locally-validated migration deploys fine; an unvalidated
  one is a gamble.
- **Vite proxy:** use the regex form `"^/api/.*"`. The bare prefix `"/api"`
  matches the source file `/api.ts` too and breaks the dev server.
- **Primer 38 needs primitives CSS explicitly imported.** The React package
  only ships *component* CSS. Without the three imports in
  `src/web/design-system/github/index.tsx`, `--bgColor-default` etc. don't
  resolve and BaseStyles falls back to hardcoded light.
- **Sheet portals + theme variables:** `createPortal` mounts outside the
  Primer/Minimal `ThemeProvider` wrapper. Our github plugin mirrors the
  `data-color-mode` / `data-light-theme` / `data-dark-theme` attributes onto
  `<html>` via `useEffect` so CSS vars cascade from the root and resolve
  inside the portal. If you swap plugins again, do the same.
- **WAL is load-bearing; keep the boot pragma.** `startServer()` runs
  `enableWalMode` (in `db.ts`) before listening, and it's idempotent +
  persistent in the DB file. libsql's default journal mode (`delete`) lets
  ONE writer block ALL readers across every worker — a 2026-09-24 prod
  incident (stalled fsync held the exclusive lock; every request 500'd with
  P1008/SQLITE_BUSY until a pod restart). The multi-worker launcher's design
  notes in `cluster.ts` assume WAL. Don't remove the pragma. Known residual:
  writer-vs-writer still fails instantly (this libsql client build exposes no
  busy_timeout) — acceptable under WAL because commits are short.
- **bun test = ONE process for all files; env mutations leak.** Files run
  sequentially, but `process.env` is shared and pollution persists into later
  files. Restoring with `process.env.X = prev` when `prev` is undefined sets
  the literal string `"undefined"` (push.test.ts once poisoned VAPID keys →
  later suites saw push "configured" and config assertions failed with
  `vapid_public_key: "undefined"`, victims varying with file order). ALWAYS
  guard restores: `if (prev === undefined) delete process.env.X; else
  process.env.X = prev;`

## Realtime (SSE + EventBus)

- **One global SSE connection per browser tab** at `GET /api/realtime/stream`.
  Mounted in [src/web/App.tsx](src/web/App.tsx) via `<RealtimeProvider>`
  inside `<ToastProvider>` and above `<ErrorBoundary>`. Components NEVER
  open their own `EventSource` — browsers cap HTTP/1.1 at 6 connections
  per origin and SSE counts. Subscribe via `realtimeBus.on(kind, handler)`
  in [src/web/realtime/realtimeBus.ts](src/web/realtime/realtimeBus.ts).
- **Server-side fan-out goes through `getBus().publish(...)`** from
  [src/server/realtime/bus.ts](src/server/realtime/bus.ts) — never call
  the SSE handler or local `EventEmitter` directly from a route. Two
  implementations behind the same interface: `InProcessBus` (single
  worker) and `ClusterBus` (multi-worker via Bun IPC). Picked at boot.
- **`Bun.serve` needs `idleTimeout: 0`** for the API server — the default
  ~10s closes SSE before the 20s heartbeat lands. See
  [src/server/index.ts](src/server/index.ts).
- **Multi-worker IPC** is handled by [src/server/cluster.ts](src/server/cluster.ts):
  each worker's `Bun.spawn` has an `ipc(message)` callback; the launcher
  is a dumb mirror that forwards `{type:"bus", event}` to every other
  worker. Backpressure: per-worker bounded queue (1000), drops are logged
  periodically. Client `Last-Event-ID` replay heals any losses.
- **Bus events carry IDs only** (`messageId`, `notificationId`,
  `conversationId`), never full row payloads. SSE delivery fetches the
  current row from Prisma and applies the per-recipient privacy filter
  before writing. Keeps wire payloads small AND avoids stale-data hazards.
- **Client filter on `conversationId`**: every `message.*` BusEvent
  carries the `conversationId` so per-conversation subscribers can filter
  cheaply. Drop a payload without it and ConversationView will silently
  ignore the event.
- **Board SSE is POLL-FIRST.** The board page (`startBoardLive` in
  [src/web/board/boardLive.ts](src/web/board/boardLive.ts)) starts in
  POLLING mode (snapshot refetch every 5s via the existing debounce) and
  opens the SSE only as a parallel probe. Promotion to live requires the
  first HEARTBEAT over the stream — the server sends a named `ping` event
  immediately at open + every 20s; `onopen` does NOT count (it fires on
  headers alone, exactly what a black-holing proxy delivers). A promoted
  stream silent beyond 45s (or erroring) drops back to polling, and the
  watchdog also recycles probes that open but never heartbeat, re-probing
  every 30s. The header dot shows amber "Polling" until promotion. Don't
  revert the ping to an SSE comment — comments are invisible to the JS
  EventSource API, so the watchdog couldn't see them.
- **Live Board topic events** (`agenda.changed`, `board.spotlight`) are
  routed on a CONFERENCE key, not an identity: `recipientId =
  boardTopicKey(confId)` (a NEGATIVE number, so it never collides with a
  positive ConferenceIdentity.id). The board SSE
  ([src/server/routes/board.ts](src/server/routes/board.ts)) is the only
  subscriber; the notification/chat stream never sees them. Publish via
  `publishAgendaChanged(confId)` / `publishBoardSpotlight(confId, subId)`
  from [src/server/realtime/bus.ts](src/server/realtime/bus.ts), AFTER the
  mutating tx commits. `publishAgendaChanged` is wired into every agenda
  mutation (slot/track/placement/series writes, per-slot assign, mixer run,
  `assignAll`, refit, spotlight) PLUS `submissions.star`/`unstar` (star
  counts drive the board). Grep for `publishAgendaChanged(` before adding a
  new agenda-mutating path — it must call it too.
- **The public board payload MUST stay email-free.** `GET /api/board/:slug`
  is token-gated (`Conference.boardToken`) but PUBLIC — display names, titles,
  room names, star/attendee counts ONLY. Never add an email or unpublished-
  profile-sensitive field. A spotlighted session is hidden once unpublished.
  Late board joiners get current state from the payload route, so the board
  SSE does NO replay — it only forwards events that arrive after connect.
- **Shown-days filter (`Conference.boardDays`)**: comma-separated YYYY-MM-DD
  keys (conference timezone), null = all days. Applied SERVER-side in
  `buildBoardPayload` (slots by start-in-[midnight,next-midnight), entries
  filtered to surviving slots); the spotlight is deliberately NOT day-bound
  (explicit mod action). The mod picker lives in the Pitch Mode sheet's
  Live Board section, fed by that conference's slot days. `setBoardLink` and
  `rotateBoardLink` publish `agenda.changed` after commit so open walls
  refetch and apply config changes live (disable → walls hit 404 → "not
  active" screen; rotate → same, immediately).
- **Board density: caps + skip-empty are CLIENT-side pagination rules** in
  [src/web/board/useBoardPages.ts](src/web/board/useBoardPages.ts) (pure
  `buildBoardPages`, unit-tested). Pages cap at 6 room columns / 6 slot rows
  regardless of wall size — overflow becomes more pages, never smaller cells.
  `Conference.boardSkipEmpty` (default ON, toggled in the Pitch Mode sheet's
  Live Board section, rides `BoardPayloadOut.skip_empty`) prunes empty room
  columns / slot rows DAY-SCOPED and BEFORE chunking (fixed-point), so sparse
  days merge into fewer denser pages; a per-page polish pass then drops rows
  whose sessions landed in another page's room chunk. If EVERY day prunes
  away (nothing placed at all) the unpruned pages render so the wall never
  blanks.

## Notifications (single entrypoint)

- **NEVER call `prisma.notification.create()` directly.** All notification
  writes go through `createNotification` / `createNotifications` in
  [src/server/notifications.ts](src/server/notifications.ts). The helper is
  the single place that (a) publishes the `notification.upserted` bus event
  for realtime SSE delivery, and (b) handles dedupe-key coalescing safely
  (read OR unread existing rows are reused, never collide with P2002).
  Notifications are realtime-critical; the central helper makes that
  guarantee impossible to forget.
- **Use `dedupeKey` when multiple events should collapse into one bell
  row** (e.g. `conv:<id>` for chat messages, `report:<conf>` for reports).
  Omit it for one-shot events that should always produce a distinct row
  (warnings, bookings, quota crossings).
- **If creating notifications from inside `prisma.$transaction`**, capture
  the data needed for the notification inside the tx and call
  `createNotification` AFTER the tx commits — that way the SSE event
  references row state that's actually visible to other readers, and a
  rollback won't leave a phantom bell entry. See `experts.book` for the
  pattern.
- **Planned-slot schedule changes go through one helper.**
  `notifyPlannedScheduleChange` in [src/server/rpc/agenda.ts](src/server/rpc/agenda.ts)
  is the single place that fans out `schedule_changed` notifications when a
  talk is scheduled into / moved within / removed from a PLANNED (type
  "normal") slot. Recipients = the submission's starrers ∪ its submitter;
  for a `mandatory` track it's EVERY conference identity. Always coalesced
  per `(slot, submission)` via `dedupeKey: "track:<slotId>:<submissionId>"`
  so a burst of edits (scheduled → moved → …) collapses into one bell row.
  Wired into `scheduleSubmission`, `setTrack` (replace only — a same-
  submission edit sends nothing), `clearTrack`, and `refitRooms`. The
  unconference `placeSubmission` room-move reuses the same kind + dedupeKey
  but targets the currently-SEATED users (UserAssignment rows), not starrers.
  Call it AFTER the surrounding transaction commits (the standard rule above).

- **Web Push AUGMENTS the bell — it never replaces it.** `createNotification`
  fire-and-forgets `sendPushForNotification` (in
  [src/server/lib/webpush.ts](src/server/lib/webpush.ts)) after the row write +
  bus publish. It's BEST-EFFORT: wrapped so a push failure can never affect the
  notification write, and fully INERT (zero DB work) when VAPID isn't
  configured (`webPushConfigured()` gates on `VAPID_PUBLIC_KEY` +
  `VAPID_PRIVATE_KEY`). It reuses the notification's own `title`/`body`/`ctaHref`
  — no duplicated copy — and the payload is privacy-safe (names/titles only,
  NEVER emails; mirror this in any new push surface). `ctaHref` → hash deep-link
  via `deepLinkForNotification`. Subscriptions live on `PushSubscription` (one
  per device, unique `(identity, endpoint)`); a 404/410 from the push service
  deletes the stale row. RPC opt-in: `push.subscribe`/`unsubscribe`
  ([src/server/rpc/push.ts](src/server/rpc/push.ts), participant role). Client
  opt-in is `PushOptIn` in the notification bell (self-hides unless
  `config.vapid_public_key` + `PushManager` + a SW registration exist). The SW
  (`sw.js`) handles `push`/`notificationclick` — bump `CACHE_VERSION` if you
  touch it. Generate keys with `bun run scripts/gen-vapid.ts`.

## Room constraints (dedication + availability)

- **Room constraint logic lives in
  [src/server/lib/room-constraints.ts](src/server/lib/room-constraints.ts).**
  Every room-consuming path must consult `expertDedicatedRoomIds` +
  `unavailableRoomIds` (or `roomAvailableFor` for a single interval) after
  resolving its room scope. The five agenda paths (`runAssignmentForSlot`,
  `runMixerForSlot`, `scheduleSubmission`, `placeSubmission`, `refitRooms`)
  and `experts.book` all do this; a new room-selecting path must too.
- **Expert-dedicated rooms** (member of any `ExpertRoomPool` via
  `ExpertRoomPoolRoom`, OR any per-expert `ExpertRoom` row) are excluded from
  EVERY slot assignment. Automatic paths drop them silently; manual paths
  (setTrack target, scheduleSubmission/placeSubmission explicit or pin,
  refit pin targets) return a `room_expert_dedicated` conflict. Pin writes
  (`submissions.create`/`update` `pre_assigned_room_id`) reject dedicated
  rooms with a BAD_REQUEST. **Mutual exclusion is enforced on both write
  directions:** dedicating a room that already has slot usage
  (`experts.createPool`/`updatePool`/`promote`/`update`) is blocked with a
  structured `rooms_in_use` error naming the offenders.
- **Availability windows** (`RoomAvailability` rows): **no rows = always
  available** (the hard default — existing conferences are unaffected). With
  windows, an interval is usable only when it fits fully inside a single
  window. Availability edits (`rooms.create`/`update`) that would strand an
  existing track / placement / booking are rejected with
  `availability_strands_usage`; clearing to empty always succeeds.

## Architecture choices that look weird unless you know them

- **Design system is per-conference** (stored on `Conference.designSystem`),
  selected by the owner from the Settings tab. The user-level `colorMode`
  (auto/light/dark) is separate and lives on `User.colorMode`.
- **Assignment algorithm is pure** ([src/server/assignment.ts](src/server/assignment.ts)).
  It takes plain data — `rooms`, `submissions`, `stars: Map<userId, Set<subId>>` —
  and is the most heavily tested piece (15 unit + 3 scale + integration). DB
  wiring lives in `runAssignmentForSlot` in `rpc/agenda.ts`. This pure fn does
  BOTH per-slot placement (which session → which room) AND user routing.
- **Placing and seating are SEPARATE actions — don't confuse them:**
  - *Per-slot PLACEMENT* (`assignUnconferenceSlot` + `runAssignmentForSlot`,
    `agenda.assign` RPC, per-slot "Run assignment"): PLACEMENT-ONLY. It decides
    which session runs in which room for ONE slot and writes only
    `UnconferencePlacement` rows. It NEVER seats attendees. The pure
    `assignUnconferenceSlot` still emits a candidate seating internally (and is
    the most-tested module — never weaken its tests), but the route DROPS that
    output: it writes placements, flags the slot `seatingStale = true`, and
    deletes only the seats whose session is no longer placed (still-placed
    sessions keep their seats). It still receives the slot's `manual:true`
    placements as `fixedPlacements` (never re-placed, rooms reserved) and still
    runs the conflict gates + overlap-exclusion reporting.
  - *Global SEATING* (`assignAgenda` in
    [src/server/assignment-agenda.ts](src/server/assignment-agenda.ts) +
    `runAssignmentForAgenda`, `agenda.assignAll` RPC, "Update seating" button):
    the ONE seating action. Writes only `UserAssignment`; never touches
    placements. Targets = unconference slots that HAVE placements, start in the
    FUTURE (server clock), and are `seatingStale` (or `include_unchanged:true`
    opts in unchanged future slots). Past/started slots are NEVER re-seated.
    Every OTHER slot with `UserAssignment` rows is FROZEN as a hard constraint:
    its seats add their band to `busyBands` (mandatory planned tracks freeze the
    whole conference into their band) and its unconference seats build
    `priorAttendance` — so a user is never re-seated into a session they already
    attend in a frozen slot, across the freeze boundary. `priorAttendance` ALSO
    absorbs DERIVED planned-track (Path-C) attendance — stars on a tracked
    submission, its submitter, and mandatory tracks (all identities), lifted
    from `runAssignmentForSlot` — so nobody is seated into an unconference
    occurrence of a session they already attend as a planned talk. Only
    MANDATORY planned tracks add to `busyBands`; soft-starred planned tracks
    stay non-blocking for bands. Bands are computed over ALL slots. Writes clear
    the re-seated slots' `seatingStale` in the same transaction. Notifications
    DIFF: capture target slots' old seats BEFORE the tx, then notify only
    identities whose `(slot→submission)` seat set changed (coalesced
    `dedupeKey assign:<confId>`); untouched users are never notified.
    It's an integer min-cost flow (Dijkstra + Johnson potentials); the
    ≤1-per-band gate is the LAST per-user node so it can't double-book;
    per-submission-once is enforced upstream + a deterministic dedup. NP-hard at
    full generality → a high-quality deterministic heuristic, not provably
    optimal.
  - **Staleness lifecycle:** any placement mutation flags the affected slot
    stale — per-slot `agenda.assign`, `placeSubmission`, `unplaceSubmission`,
    `updateSeries` orphan cleanup, and `submissions.delete` / `rooms.delete`
    (which collect the affected slots before cascading). Host-set changes
    flag stale too: `submissions.update` when `speakers` or `submitter_id`
    are edited, and `conferences.removeParticipant` (speaker rows cascade
    away with the identity). Mixer writes never flag stale.
    `SlotOut.seating_stale` surfaces it to the UI.
  - **Note:** the per-slot `unconf_avoid_repeats` / series
    `avoid_repeats_across_siblings` flags shaped the OLD per-slot seating only.
    Global seating always enforces attend-each-submission-at-most-once for
    ATTENDEES and does NOT consult those flags — they persist as config but no
    longer steer seating. (Planned-track derived attendance IS honored,
    unconditionally — see `priorAttendance` above.) HOSTS are the one exempt:
    host duty seats every effective speaker (`speaker_ids` via
    `effectiveSpeakerIdentityIds`, defaulting to `[submitter_id]` only when
    the session has NO speaker rows at all; a session whose speaker rows are
    ALL free-form names gets `[]` = explicitly unhosted — confirmed product
    decision, the real presenters self-manage) into EVERY placed occurrence
    of their session, in both
    the agenda solver and the per-slot candidate seating. Host pins are
    duty seats: capacity-free (never displace an attendee, never blocked by a
    full/cap-0 room), exempt from attend-once/priorAttendance, but still
    band-gated — a host is seated into at most one session per time-band
    (parallel twin occurrence, another session's pin, or a fixed pick wins by
    the priority→stars→id host order), and one occurrence of a parallel twin
    can end up unhosted.
- **Session priority** (`Submission.priority`: `high`/`normal`/`low`, mod-only
  override like `maxPlacements`): the LEADING sort key for the per-slot top-N
  placement cut (before star count), plus a routing bias so high-priority
  sessions fill first / low fill last — only among a user's starred options;
  it never overrides manual placements, fixed picks, host-duty pinning,
  or capacity. The priority→stars→id ordering lives in TWO mirrored sorts
  that must stay in sync: `submissionsByPopularity` in `assignment.ts` and
  the route-side `subsByPopularity` in `rpc/agenda.ts`. The whole-agenda
  bias is `PRIORITY_BONUS` in `assignment-agenda.ts`, which must stay above
  `SEAT_STEP·maxCapacity` but well below `USER_DIMINISH`. Enum→weight mapping
  goes through `priorityWeight()` exported from `assignment.ts` — don't
  re-implement it.
- **Placement authoring:** mods author the occurrence set via
  `agenda.placeSubmission` / `unplaceSubmission` (UI: `PlacementAuthor` in the
  unconference slot body). `UnconferencePlacement.manual=true` marks
  mod-authored placements so the per-slot auto-assign preserves them
  (`placementWriteOps` deletes only `manual:false`).
- **Planned-slot room refit** (`agenda.refitRooms`) is a STABLE, minimal-move
  REPAIR of a normal slot's room assignment — NOT a re-rank. A track is a
  "misfit" when its interest exceeds its room, its `preAssignedRoomId` pin
  points elsewhere, its `roomRequirements` aren't met, or its room is
  double-booked by a time-overlapping slot (`overlapHeldRoomIds` — tracks +
  placements + `UserAssignment.roomId`, the last covering mixer rooms since
  mixers write no placement rows). Non-misfits NEVER move (zero misfits → zero
  moves, zero writes). Each misfit goes to the SMALLEST free room that still
  covers its interest (best fit — preserves big-room headroom), else the
  largest satisfying free room (only if strictly bigger for a pure overfill),
  else a single swap with a strictly less-starred non-pinned track. Pins
  override tag requirements + overfill; a pin only ever lands on its pin room.
  Genuine pin config errors (pin out of scope, pin room held by an overlapping
  slot / another pin / a non-misfit) still abort with a conflict + ZERO writes;
  misfits that can't be improved stay put and are returned in `unresolved`
  (`overfilled` | `double_booked` | `requirements`).
- **Overlap-held rooms block ALL room authoring, not just refit.**
  `overlapHeldRoomIds(prisma, confId, slotId, window)` is the shared source of
  truth (overlapping slots' tracks + unconference placements +
  `UserAssignment.roomId`, the last covering mixer rooms since mixers write no
  placement rows). It's folded into the taken-room set of `scheduleSubmission`
  (auto + pin), `placeSubmission` (auto + explicit + pin), and — as of the
  setTrack overlap gate — `setTrack` itself. `setTrack` returns a structured
  `SetTrackResult` (`{kind:"ok"} | {kind:"conflict", reason:"room_overlap_taken",
  holder}`) naming the holding slot's time + talk/session title + room via
  `findRoomOverlapHolder`, so the UI can say WHAT's using the room. The gate
  fires only when placing into a room this slot doesn't already use (`!existing`)
  — editing/replacing a track already in a room is never blocked by its own room
  (a pre-existing double-book stays editable). When adding a NEW overlap-aware
  room-authoring endpoint, fold `overlapHeldRoomIds` in the same way.
  **Caveat:
  `TrackAssignment.id` is NOT stable across a refit** — the `@@unique([slotId,
  roomId])` makes in-place room swaps collide transiently, so the write is
  delete-all-tracks + recreate with new roomIds (requirements re-created too).
  That's fine because nothing persists track ids: the ICS/VEVENT calendar
  export ([src/server/routes/calendar.ts](src/server/routes/calendar.ts)) keys
  its planned-track UID on the STABLE `(slotId, submissionId, identityId)`
  triple — NOT the track id — so a refit updates a moved talk's calendar event
  in place instead of dropping + re-adding it. Keep any new consumer off the
  track id for the same reason.
- **Per-slot unconference scope:** an `AgendaSlot` has
  `unconfUseAllRooms` / `unconfUseAllSubmissions` flags + `SlotRoom` /
  `SlotSubmission` join tables. The assignment respects these so a slot can
  intentionally use only some rooms / some submissions.
- **Calendar layout:** overlapping slots get side-by-side columns (sweep-line
  algorithm). Within a slot, tracks/placements are sub-columns. Both layers
  enable mobile horizontal scroll once columns drop below their min widths
  (`MIN_SLOT_COL_WIDTH`, `MIN_TRACK_SUBCOL_WIDTH`). Block height floors at
  `MIN_SLOT_HEIGHT_PX` (= `SNAP_MIN`) with a micro one-line variant under
  `MICRO_MAX_HEIGHT_PX`, and `layoutSlots` (extracted to
  [src/web/conference/tabs/calendar/layoutSlots.ts](src/web/conference/tabs/calendar/layoutSlots.ts))
  treats the rendered height as the effective end so clamped short blocks get
  side-by-side columns instead of painting over their neighbors.
- **`NowIndicator`** in `Calendar.tsx` only renders when the day being drawn
  is today. Aligned to whole-minute ticks via `setTimeout` then `setInterval`.

## Code organization

- **Keep files small and DRY.** This codebase is intentionally split by
  router (`src/server/rpc/*.ts`), tab area (`src/web/conference/tabs/<area>/*.tsx`),
  and schema domain (`src/shared/schemas/*.ts`) so each file has one focus.
  Reach for that pattern when adding new code: drop a new sub-component into
  the relevant `tabs/<area>/` directory instead of growing the tab's main
  file; add a new procedure to the right `rpc/<router>.ts` instead of
  reopening a megafile.
- **Soft cap ~500 lines per file.** Once a file passes that, look for natural
  seams (per-component, per-router, per-domain helper) and split. Don't
  carve a 200-line file into five files just to hit a target — premature
  splitting buys nothing and forces readers to chase indirection. Split when
  the file is genuinely doing two things, not because it's "long."
- **Don't duplicate logic** that another module already exposes. If you find
  yourself copying a helper, lift it into the nearest shared module
  (`src/server/rpc/shared.ts`, `src/web/conference/helpers.ts`, etc.) and
  import it. The privacy / permission helpers in
  [src/server/lib/permissions.ts](src/server/lib/permissions.ts) are the
  canonical example — never re-implement role checks inline.
- **Entry-file re-exports are the integration seam.** `src/shared/contract.ts`
  and `src/shared/schemas.ts` are thin re-exporters over their sub-module
  directories so external import paths stay stable. When you add a new
  schema/type, put it in the right sub-file and let the entry file pick it
  up via `export *`; don't add it directly to the entry file.

## Validation

- All form-shaped routes parse the body through valibot schemas in
  [src/shared/schemas.ts](src/shared/schemas.ts) and return 400 with
  `{ error: "validation", fields: { … } }` on failure.
- Client forms (`useForm` hook in [src/web/useForm.ts](src/web/useForm.ts))
  validate locally on submit, and merge server-returned field errors via
  `applyServerErrors`.
- **When adding a new field, edit the shared schema first.** The route and
  the form both consume it; if you only update one, the other will silently
  diverge.

## Testing rhythm

- `bun test` runs everything. Keep `bun:test`'s `describe`/`test` shape.
- Integration tests use a per-`describe` temp SQLite + isolated `PrismaClient`
  (see `setupTestApp` in `test-helpers.ts`).
- The "no email leak" check is in
  `src/server/routes.test.ts` → "privacy: non-mods can't list participants…"
  — if you change submission/participant responses, run that test first.
