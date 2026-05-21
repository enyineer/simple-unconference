# simple-unconference

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
