# simple-unconference

A self-hostable app for running unconferences end-to-end:

- Create conferences with an **owner** + optional **moderators**.
- Add participants manually or via CSV import.
- Rooms with capacity.
- Participants submit unconference session ideas; others **star** the ones they want to attend.
- Moderators **publish** submissions.
- Mixed agenda: **normal slots** (e.g. keynotes / multi-track talks moderators pick) and **unconference slots**.
- For unconference slots: a balanced assignment algorithm places sessions in appropriately-sized rooms and assigns each starring user to one of their starred sessions. Users whose stars are all full are listed with a hint to pick another.
- **Per-conference design system** — owners pick a theme that applies to that conference's UI for everyone. Two ship by default (GitHub Primer + Minimal); adding a new one is a single file (see below).

## Stack

- **Runtime + package manager**: [Bun](https://bun.sh)
- **API**: [Hono](https://hono.dev) on `Bun.serve`
- **DB**: SQLite via **Prisma 7** with the `@prisma/adapter-libsql` driver adapter — pure JS so it runs in Bun (`better-sqlite3` doesn't, [oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)).
- **Validation**: [valibot](https://valibot.dev) — schemas shared between server and client.
- **Frontend**: React 19 bundled by **Vite** (separate dev server, proxies `/api` to Bun).
- **Design system**: pluggable contract with two implementations — GitHub [Primer](https://primer.style/react) and a Minimal one. Both honor `prefers-color-scheme: dark`.

## Quick start

```bash
bun install
bunx prisma generate
bunx prisma db push
bun run dev    # Vite at http://localhost:5173, API at http://localhost:3000
```

Vite proxies `/api/*` to the Bun API; open <http://localhost:5173>.

To run a production build:

```bash
bun run build  # outputs dist/
bun run start  # Bun serves /api + dist/ at http://localhost:3000
```

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Boots Hono (`--hot`) on :3000 AND Vite on :5173 in parallel |
| `bun run build` | Vite production build → `dist/` (code-split per page + per DS plugin) |
| `bun run start` | Bun serves API + `dist/` statically (production) |
| `bun test` | Run all tests (assignment + scale + integration) |
| `bun test src/server/assignment.test.ts` | Assignment algorithm unit tests |
| `bun test src/server/assignment.scale.test.ts` | Assignment scale tests |
| `bun test src/server/routes.test.ts` | HTTP integration tests |

## Test coverage

The assignment algorithm is the highest-risk piece, so it is the most heavily tested:

- **15 unit tests** covering placement, capacity, balancing, fallback, "no fit → unplaced" hints, deterministic ordering, and degenerate inputs (no rooms / no submissions / no users).
- **3 scale tests** validating capacity invariants and bounded time at 1 000 / 5 000 user scenarios (completes in ~25ms).
- **10 HTTP integration tests** covering auth, role enforcement, CSV import, the publish → star → assign happy path, slot-type guards, and the per-conference design-system PATCH.

```
28 passed total
```

## Migrations

Schema lives in [`prisma/schema.prisma`](prisma/schema.prisma). Database connection is configured in [`prisma.config.ts`](prisma.config.ts) (Prisma 7 moved the URL out of `schema.prisma`).

```bash
bunx prisma migrate dev --name <change>
bunx prisma db push                         # for fresh dev/test DBs
```

The default DB lives at `data/dev.sqlite` (configured via `.env` → `DATABASE_URL`).

## Architecture

```
src/
  shared/
    types.ts                # Types shared by server + web
    schemas.ts              # ⭐ Valibot schemas — used by both server and forms
  server/
    db.ts                   # Prisma client + libSQL adapter
    auth.ts                 # Session cookies + Bun.password
    assignment.ts           # ⭐ The unconference assignment algorithm (pure)
    assignment.test.ts      # Unit tests
    assignment.scale.test.ts
    routes.test.ts          # HTTP integration tests
    index.ts                # Hono app + Bun.serve entrypoint (API + prod static)
    routes/
      auth.ts
      conferences.ts        # Conferences, participants, rooms, moderators, settings
      submissions.ts        # Submissions, stars, publish
      agenda.ts             # Slots, normal-slot tracks, unconference assignment
    lib/
      permissions.ts        # Conference role middleware
      csv.ts                # Minimal CSV parser
  web/
    index.html              # Vite entry
    client.tsx              # ReactDOM.createRoot
    App.tsx                 # Auth gate + lazy routes + DesignSystemProvider
    api.ts                  # Fetch wrapper; surfaces field-level validation errors
    router.tsx              # Tiny hash router (no extra deps)
    useForm.ts              # ⭐ Valibot-backed form hook (field errors + server merge)
    design-system/
      core/contract.tsx     # The component contract every plugin implements
      core/registry.ts      # Plugin list (each `import()` is a separate chunk)
      github/index.tsx      # GitHub Primer implementation (uses CSS vars, dark-aware)
      minimal/index.tsx     # Minimal plain-HTML implementation (CSS vars, dark-aware)
      index.tsx             # Provider + component wrappers (delegate to active plugin)
    pages/
      Login.tsx
      Conferences.tsx
      Conference.tsx        # Sessions / Agenda / My-schedule / People / Rooms / Settings
prisma/
  schema.prisma
  migrations/
prisma.config.ts            # Prisma 7 datasource URL
vite.config.ts              # Vite + React; dev proxies /api to Bun :3000
scripts/dev.ts              # Boots Hono + Vite in parallel
```

## The assignment algorithm

[`src/server/assignment.ts`](src/server/assignment.ts) is a **pure function**: takes plain data (rooms, submissions, star sets) and returns placements + per-user assignments + an unplaced list. The Prisma wiring is done by `runAssignmentForSlot` in `routes/agenda.ts`.

Approach:

1. Count stars per submission. Take the top *N* (where *N* = number of rooms) most-starred submissions; the rest are dropped for this slot.
2. Pair each kept submission with a room: most-starred → largest room, ties broken by id ascending (deterministic).
3. Walk users in order of **fewest candidates first** (the most constrained users have the fewest options, so they go first). For each user, pick the candidate with the **lowest current load** that still has remaining capacity. Capacity ties → larger remaining capacity → smallest submission id.
4. Users whose candidate set is empty *or* whose every candidate filled up are added to `unplaced_users`. The UI surfaces this as "pick another starred session and ask a moderator to re-run".

Same input always produces the same output — important for tests and for participants who might re-load the page.

## Shared validation

Both server and client validate with the same valibot schemas in [`src/shared/schemas.ts`](src/shared/schemas.ts). Server returns 400 with:

```json
{ "error": "validation", "fields": { "email": "Enter a valid email." } }
```

Client forms use [`useForm`](src/web/useForm.ts) which validates locally on submit and accepts server-returned field errors via `applyServerErrors`. Field errors render inline next to the input.

## Per-conference design system

Each conference has a `designSystem` field (default `"github"`). Owners change it from the **Settings** tab of the conference page; the swap is immediate for everyone viewing the conference.

The App reads the conference's `design_system` and passes it to `<DesignSystemProvider pluginId={…}>`. Unscoped pages (login, conference list) use the default.

**Both shipped plugins honor `prefers-color-scheme: dark`** by sourcing colors from CSS custom properties — Primer's via `<BaseStyles>` + Primer's CSS vars, Minimal's via a small inline `<style>` block with a `@media (prefers-color-scheme: dark)` override.

### Adding a design system

1. Create `src/web/design-system/<your-system>/index.tsx` and export an object implementing every method on the `DesignSystem` interface — see [`github/index.tsx`](src/web/design-system/github/index.tsx) or [`minimal/index.tsx`](src/web/design-system/minimal/index.tsx).
2. Register it in [`design-system/core/registry.ts`](src/web/design-system/core/registry.ts):

   ```ts
   { id: "your-system", label: "Your System", load: () => import("../your-system").then((m) => m.yourSystem) }
   ```

3. Add the id to the allowlist in [`src/server/routes/conferences.ts`](src/server/routes/conferences.ts) (`allowed = ["github", "minimal", ...]`).

The plugin gets its own chunk thanks to the dynamic `import()` — it never ships in the initial bundle.

## Bundle splits (production)

`bun run build` produces:

| Chunk | Size (gzipped) | Loaded |
| --- | --- | --- |
| `index-*.js` (entry) | ~62 KB | always |
| `Login-*.js` | ~3 KB | logged-out only |
| `Conferences-*.js` | ~1 KB | logged-in landing |
| `Conference-*.js` | ~4 KB | inside a conference |
| `github-*.js` + `github-*.css` | ~118 KB | only when a conference uses Primer |
| `minimal-*.js` | ~2.5 KB | only when a conference uses Minimal |

A conference using the Minimal theme pays ~67 KB total; using Primer is ~180 KB. The unused plugin never loads.

## Permissions

| Action | participant | moderator | owner |
| --- | :-: | :-: | :-: |
| View conference, sessions, agenda | ✓ | ✓ | ✓ |
| Submit session, star session | ✓ | ✓ | ✓ |
| View experts list, book / cancel own booking | ✓ | ✓ | ✓ |
| Add / remove participants, CSV import | | ✓ | ✓ |
| Add / edit / delete rooms | | ✓ | ✓ |
| Publish / reject submissions | | ✓ | ✓ |
| Add / delete agenda slots | | ✓ | ✓ |
| Pick talks for normal-slot tracks | | ✓ | ✓ |
| Run unconference assignment | | ✓ | ✓ |
| Manage expert room pools | | ✓ | ✓ |
| Promote / demote experts, manage timeframes | | ✓ | ✓ |
| Cancel any expert booking | | ✓ | ✓ |
| Remove another moderator | | | ✓ |
| Promote / demote moderator | | | ✓ |
| Change conference design system | | | ✓ |

## License

MIT.
