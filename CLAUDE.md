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

## Stack gotchas you will hit if you forget

- **Prisma adapter:** we use `@prisma/adapter-libsql` (pure JS), not
  `@prisma/adapter-better-sqlite3`. `better-sqlite3` doesn't load in Bun yet
  ([oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)). If you
  switch, the server boots fine but every query throws `ERR_DLOPEN_FAILED`.
- **Prisma 7 config:** the datasource URL lives in [`prisma.config.ts`](prisma.config.ts),
  **not** in `schema.prisma`. The `datasource db {}` block has only `provider`.
- **Prisma CLI in tests:** `prisma db push` in Prisma 7 dropped `--skip-generate`.
  Pass `--url <url>` to override per-test DBs (see `test-helpers.ts`).
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

## Architecture choices that look weird unless you know them

- **Design system is per-conference** (stored on `Conference.designSystem`),
  selected by the owner from the Settings tab. The user-level `colorMode`
  (auto/light/dark) is separate and lives on `User.colorMode`.
- **Assignment algorithm is pure** ([src/server/assignment.ts](src/server/assignment.ts)).
  It takes plain data — `rooms`, `submissions`, `stars: Map<userId, Set<subId>>` —
  and is the most heavily tested piece (15 unit + 3 scale + integration). DB
  wiring lives in `runAssignmentForSlot` in `routes/agenda.ts`.
- **Per-slot unconference scope:** an `AgendaSlot` has
  `unconfUseAllRooms` / `unconfUseAllSubmissions` flags + `SlotRoom` /
  `SlotSubmission` join tables. The assignment respects these so a slot can
  intentionally use only some rooms / some submissions.
- **Calendar layout:** overlapping slots get side-by-side columns (sweep-line
  algorithm). Within a slot, tracks/placements are sub-columns. Both layers
  enable mobile horizontal scroll once columns drop below their min widths
  (`MIN_SLOT_COL_WIDTH`, `MIN_TRACK_SUBCOL_WIDTH`).
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
