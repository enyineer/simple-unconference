# simple-unconference

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
