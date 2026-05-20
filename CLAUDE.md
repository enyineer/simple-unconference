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
