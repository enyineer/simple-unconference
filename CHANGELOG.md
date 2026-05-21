# simple-unconference

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
