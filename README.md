# Simple Unconference Web App - Unconf

A self-hostable platform for running unconferences end-to-end: people, rooms, sessions, scheduling, mixers, expert bookings and notifications — all in one app.

> **Public instance:** A free, public, hosted instance lives at **<https://unconference.enking.dev>** — feel free to try it before deciding to self-host. The instance runs the same chart this repo ships, with [Public-instance hardening](#public-instance-hardening) enabled (per-account quotas, login lockout, Cloudflare Turnstile on signup/login/join). It targets events up to ~2000 attendees; for larger events please self-host.

![Agenda overview](screenshots/agenda-overview.webp)

## Stack

Bun · Hono · Prisma 7 (SQLite + libSQL driver-adapter) · valibot · React 19 · Vite · per-conference pluggable design system (GitHub Primer + Minimal ship by default, both dark-mode aware).

## Quick start

```bash
bun install
bunx prisma generate
bunx prisma db push
bun run dev   # Vite :5173 + Bun API :3000 (Vite proxies /api → :3000)
```

Production build:

```bash
bun run build  # → dist/
bun run start  # Bun serves API + dist/ at :3000
```

Want a populated demo conference for screenshots? Run `bun scripts/seed-synthetic.ts` after `db push`.

## Deploy with Docker

Each release is published to GitHub Container Registry at [`ghcr.io/enyineer/simple-unconference`](https://ghcr.io/enyineer/simple-unconference). Tags: `latest`, the semver version (`x.y.z`), the major (`x`), the major.minor (`x.y`), and a short commit sha. Images are built for `linux/amd64` and `linux/arm64`.

The SQLite database lives at `/app/data/prod.sqlite` inside the container. Mount a volume there so it survives container restarts and image upgrades. On startup the container runs `prisma migrate deploy`, so upgrading is just a `docker pull` + restart.

```bash
docker run -d \
  --name simple-unconference \
  -p 3000:3000 \
  -v simple-unconference-data:/app/data \
  --restart unless-stopped \
  ghcr.io/enyineer/simple-unconference:latest
```

Or with Compose:

```yaml
services:
  app:
    image: ghcr.io/enyineer/simple-unconference:latest
    ports:
      - "3000:3000"
    volumes:
      - data:/app/data
    restart: unless-stopped

volumes:
  data:
```

Override `DATABASE_URL` if you want to point at libSQL/Turso instead of the bundled SQLite file. Override `PORT` to bind a different port inside the container. The image exposes a healthcheck at `GET /api/health`.

### Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/prod.sqlite` | libSQL URL. Use `file:…` for local SQLite, or a `libsql://…` URL for Turso. |
| `PORT` | `3000` | TCP port the Bun/Hono server binds to inside the container. |
| `SERVE_STATIC` | `1` | Set to `0` in dev to let Vite serve the SPA; production images keep this on. |
| `DISABLE_SIGNUP` | _unset_ | When set to `1`/`true`/`yes`, disables **global owner signup**. The signup form is hidden on the login page and `POST /api/auth/signup` returns `403 signup_disabled`. Existing accounts can still log in. Does **not** affect per-conference participant signup; conference-level joining is controlled by each conference's own settings. |
| `WORKERS` | `1` | Number of Bun worker processes inside the container. `1` runs single-process (no fork). `auto` derives the count from cgroup CPU + memory limits: `min(round(cores), floor(mem_MiB / 192), 8)`. A specific integer (e.g. `4`) forces that count, clamped to 8. Workers share the listening port via `SO_REUSEPORT`. SQLite WAL serializes writes across workers; reads fan out fully. Bump `resources.limits.memory` by ~150Mi per additional worker. |

**Public-instance hardening** — all of these are opt-in via env and default to values that work for a free public instance running events up to ~2000 attendees. Set any value to `0` to disable that specific cap. See [Public Instance Hardening](#public-instance-hardening) for the full design.

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_CONFERENCES_PER_USER` | `3` | Hard cap on conferences a single global User may own. Throws `quota_exceeded` on `conferences.create` when reached. |
| `MAX_SESSIONS_PER_USER_PER_CONFERENCE` | `5` | Hard cap on sessions a single submitter may create in one conference (covers mod-on-behalf-of attribution too). |
| `MAX_PARTICIPANTS_PER_CONFERENCE` | `2500` | Hard cap on `ConferenceIdentity` rows per conference. Enforced on `claimInvite` + `signupViaLink`. |
| `MAX_PENDING_INVITES_PER_CONFERENCE` | `2500` | Hard cap on unclaimed invites per conference. Prevents an abusive moderator from spamming invites then bot-redeeming them. |
| `MAX_ROOMS_PER_CONFERENCE` | `100` | Hard cap on rooms per conference. |
| `LOGIN_FAIL_LIMIT` | `5` | Failed logins per email within `LOGIN_FAIL_WINDOW_MIN` before the email is locked for `LOGIN_LOCKOUT_MIN`. NAT-blind (per-email, not per-IP). `0` disables. |
| `LOGIN_FAIL_WINDOW_MIN` | `15` | Window the failure counter accumulates over, in minutes. |
| `LOGIN_LOCKOUT_MIN` | `15` | How long the email is locked after hitting the failure limit, in minutes. |
| `WRITES_PER_HOUR_PER_USER` | `600` | Sliding-window cap on expensive write operations per User per hour (`conferences.create`, `submissions.create`, etc). Catches scripted abuse from compromised accounts. `0` disables. |
| `TURNSTILE_SITE_KEY` | _unset_ | Cloudflare Turnstile public key. Sent to the SPA so it can render the widget on signup / login / join pages. |
| `TURNSTILE_SECRET_KEY` | _unset_ | Cloudflare Turnstile secret key. When set, the server requires a valid Turnstile token on `auth.signup`, `auth.login`, `conferences.claimInvite`, and `conferences.signupViaLink`. Leave unset for a no-op. |

## Deploy to Kubernetes (Helm)

A Helm chart is published alongside each release at [`oci://ghcr.io/enyineer/charts/simple-unconference`](https://github.com/enyineer/simple-unconference/pkgs/container/charts%2Fsimple-unconference). Chart and `appVersion` are kept in lockstep with the app version, so the chart tag matches the image tag (`0.3.0`, `0.4.0`, …).

```bash
# install with defaults (sqlite + 1Gi PVC at /app/data)
helm install unconf oci://ghcr.io/enyineer/charts/simple-unconference --version <version>

# upgrade
helm upgrade unconf oci://ghcr.io/enyineer/charts/simple-unconference --version <new-version>
```

Useful values:

```yaml
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: unconference.example.org
      paths: [{ path: /, pathType: Prefix }]

database:
  type: sqlite
  sqlite:
    persistence:
      enabled: true
      size: 5Gi
      storageClass: standard  # or: existingClaim: my-pvc

auth:
  # Lock down owner signup once the first account is created. Maps to the
  # DISABLE_SIGNUP env var on the container.
  disableSignup: true

workers:
  # "1" (default), "auto" (derive from cpu/memory limits), or a specific
  # integer. Adds horizontal fan-out inside the single pod via SO_REUSEPORT.
  # See the WORKERS row in the env-var table above for the auto-calc rule.
  count: "auto"
```

Source: [`charts/simple-unconference/`](charts/simple-unconference/). The chart provisions a `Deployment` (Recreate strategy so the RWO PVC hands cleanly between pods), `Service`, optional `Ingress`, the SQLite `PersistentVolumeClaim`, and a `Secret` carrying `DATABASE_URL`. Probes hit `/api/health`.

**Postgres mode is wired but not yet usable.** `database.type: postgres` will assemble a `DATABASE_URL` from `host`/`user`/`password`/`database`/`sslmode` (or pull a full URL from an `existingSecret`), but the app currently uses the [`@prisma/adapter-libsql`](src/server/db.ts) driver-adapter and the Prisma schema is pinned to `provider = "sqlite"`. Until those are swapped (and the migrations regenerated for the postgres provider), running the chart in postgres mode will boot the app against a connection it can't speak. Tracked as a future enhancement; sqlite mode is the supported path today.

## One-click PaaS deploys

The app needs a **persistent disk** (for `/app/data/prod.sqlite`) and a **long-running process** (Bun + Hono), so serverless platforms like **Vercel** and **Netlify** are not a fit — their ephemeral filesystems would lose the database on every cold start, and the Hono server isn't a function. Use a PaaS that runs containers with attached volumes:

| Provider | How |
| --- | --- |
| **Railway** | New Service → *Deploy from Docker image* → `ghcr.io/enyineer/simple-unconference:latest`. Attach a Volume mounted at `/app/data`. Expose port `3000`. |
| **Render** | New Web Service → *Deploy an existing image* → `ghcr.io/enyineer/simple-unconference:latest`. Add a Persistent Disk mounted at `/app/data`. Health check path: `/api/health`. |
| **Fly.io** | `fly launch --image ghcr.io/enyineer/simple-unconference:latest --internal-port 3000` then `fly volumes create data --size 1` and mount it at `/app/data` in `fly.toml`. |
| **DigitalOcean App Platform** | Create App → *Container Image* (DOCR or external registry) → `ghcr.io/enyineer/simple-unconference:latest`. Add a persistent volume at `/app/data`. |
| **Hetzner / Scaleway / any VM** | Use the [Docker Compose](#deploy-with-docker) snippet above. |

A true "Deploy to …" button needs a provider-specific config file (`render.yaml`, Railway template, `fly.toml`, …) and isn't shipped yet — file an issue if you'd like one for a specific provider.

## Features

### Sessions

Anyone can submit a session idea. Moderators publish, reject, or delete; participants star the ones they want to attend. Tags + per-session requirements (e.g. *laptop*, *github account*) are surfaced wherever the talk shows up.

A per-conference cap (`submission_max_placements_default`) limits how many times a published session can be placed before it drops out of the unconference pool; mods can override per-submission or mark one *manually finished*.

**Per-session assignment controls (mod-only):**

- **Pre-assign to a room** — pin a session to a specific room. The pin always wins over star-based room ranking and tag matching.
- **Required room features** — pick from the conference's actual room tags (no free text; picker only offers tags that exist on at least one room). The assignment algorithm restricts the session's candidate rooms to those whose tag set is a superset of the requested features. Approval is implicit when the session is published — submitters can't edit a published session's tag set, mods can.
- **Allow overlapping placements** — opt-in for sessions meant to run in parallel (e.g. recurring workshops). Off by default, in which case the same session is never placed in two overlapping slots and its submitter never hosts two different sessions in overlapping slots.

| Sessions list | Submit a session |
| --- | --- |
| ![Sessions](screenshots/session-overview.webp) | ![Create](screenshots/session-create.webp) |

### Agenda + slot types

The agenda mixes three slot types on a single timeline:

- **normal** — moderators pick which talk runs in which room. Tracks can be `mandatory` (forced onto everyone's schedule) and carry their own requirements.
- **unconference** — a [pure, deterministic algorithm](src/server/assignment.ts) places the most-starred sessions into appropriately-sized rooms, then assigns each starring user. The route layer ([`runAssignmentForSlot`](src/server/rpc.ts)) adds pin / tag / overlap pre-processing before the pure algorithm runs (see [Assignment algorithm](#assignment-algorithm) below). `avoidRepeats` keeps people out of sessions they've already attended; per-slot `selectedRooms` / `selectedSubmissions` scope the assignment to a subset.
- **mixer** — capacity-aware even split of every participant across selected rooms. *Exclusive* mode prefers rooms with the fewest previously-paired people; *fresh* mode ignores history.

A **"How assignment works"** modal (the `?` icon next to the slot's actions and in the Agenda header) renders a plain-language explanation of every rule the algorithm applies — including the mod-only conflict-resolution flow when sessions can't be placed.

| Static slot | Unconference slot | Mixer slot |
| --- | --- | --- |
| ![Static](screenshots/agenda-static-detail.webp) | ![Unconference](screenshots/agenda-unconference-detail.webp) | ![Mixer](screenshots/agenda-mixer-detail.webp) |

### My schedule

Each participant gets a personal schedule that unions their starred static tracks, mandatory tracks, unconference + mixer placements, and expert bookings. When an unconference runs but someone couldn't be placed (all their stars filled up), they see a *Pick a session* banner with the available rooms. Manual picks are preserved across re-runs. A per-identity iCal feed is one click away.

| Schedule | Pick a session | Room detail |
| --- | --- | --- |
| ![Schedule](screenshots/schedule-overview.webp) | ![Manual pick](screenshots/schedule-manual-pick.webp) | ![Room](screenshots/schedule-room-detail.webp) |

### People

Per-conference identities — the same email can exist in multiple conferences as fully independent accounts (passwords, names, calendar feeds, color-mode prefs, role). Moderators invite by email; owners can additionally enable a public join-link with optional usage cap. Pending invites stay visible until claimed.

| People | Invite | Pending |
| --- | --- | --- |
| ![People](screenshots/people-overview.webp) | ![Invite](screenshots/people-invite.webp) | ![Pending](screenshots/people-pending-invites.webp) |

### Rooms

Rooms have a name, capacity, free-text description and tags (*projector*, *wheelchair-accessible*, *quiet*, …). Capacity feeds directly into the assignment algorithm.

| Rooms | Add room |
| --- | --- |
| ![Rooms](screenshots/room-overview.webp) | ![Add room](screenshots/room-add-room.webp) |

### Experts (1:1 bookings)

Promote any identity to an *expert*; give them a room pool (or a fixed set of rooms) and one or more bookable timeframes. Slots are derived deterministically from each timeframe; participants book one with a single click. Room allocation is locked at booking time so re-shuffling expert room config doesn't strand bookings.

| Experts | Promote | Room pools |
| --- | --- | --- |
| ![Experts](screenshots/expert-overview.webp) | ![Promote](screenshots/expert-promote.webp) | ![Pools](screenshots/expert-pools.webp) |

### Notifications

Per-identity in-app inbox with unread badges. Events covered: submission received / published / rejected, unconference + mixer placement, expert booking confirmed / cancelled. Each notification carries an optional CTA that deep-links to the relevant tab.

### Settings (per-conference, owner-only)

Timezone, design system, mixer-avoid-repeats default, submission placement cap default, participant-submissions toggle. Settings auto-save with inline checkmark feedback — no save buttons.

![Settings](screenshots/conference-settings.webp)

## Assignment algorithm

The unconference / mixer assignment runs in two layers:

1. **Pure algorithm** ([src/server/assignment.ts](src/server/assignment.ts)) — given rooms, submissions, stars, and a per-submission `preAssignments` map, produces a deterministic `{ placements, user_assignments, unplaced_users }` result. Same input → same output (no random reshuffle on re-run; mixer slots use a stable per-slot seed).
2. **Route layer** ([`runAssignmentForSlot`](src/server/rpc.ts) / `runMixerForSlot`) — loads DB state, applies the rules below, computes `preAssignments`, then calls the pure algorithm and persists the result.

Steps the route layer runs, in order:

1. **Eligibility filter.** Drop sessions that are *finished* (placement cap reached or manually flagged) or in the call's `exclude_submission_ids` set.
2. **Overlap exclusions** (silent, reported informationally — never blocking):
   - *Same room:* a room used by an overlapping slot is removed from the candidate pool.
   - *Same submitter:* a submitter already hosting a session in an overlapping slot is excluded for any **different** session.
   - *Same session:* a session already placed in an overlapping slot is excluded — unless its `allow_overlapping_placements` flag is set.
   - *Same participant:* a user already assigned in an overlapping slot is dropped from the stars map for this slot.
3. **Top-N selection by stars.** N = min(rooms, sessions); the rest are dropped from this slot's pool.
4. **Pin conflict pre-screen** (blocking):
   - `duplicate_room` — two pinned top-N sessions want the same room.
   - `out_of_scope` — a pinned room isn't in the slot's effective room set.
5. **Bipartite matching for tag-constrained sessions** ([Kuhn's algorithm](https://cp-algorithms.com/graph/kuhn_maximum_bipartite_matching.html)) with a post-processing swap pass for "most-popular gets the largest matching room." Unconstrained sessions don't enter the matching — they fill remaining rooms by star → largest-room zip.
6. **Cascade conflict analysis.** If any tag-constrained top-N session can't be matched, it's recorded as `unsatisfiable_requirements` and replaced by the next-most-starred candidate. The matching re-runs. Mods see every session that would conflict in **one** comprehensive resolve panel — no iterative resolve / re-run rounds.
7. **Persist.** The pure algorithm receives the cascaded top-N + `preAssignments` and returns the final placements and user assignments.

When the route returns `{ kind: "conflict", conflicts: [...] }`, no DB writes happen. The frontend `ResolveConflictsPanel` ([src/web/conference/tabs/AgendaTab.tsx](src/web/conference/tabs/AgendaTab.tsx)) offers per-session actions: **skip this run** (one-shot, no DB change), **move pin**, **clear pin**, or **pin to a specific room** (overrides tag requirements). Apply-and-rerun batches the persistent edits and re-runs in one click.

> Keep [`src/web/conference/ui/AssignmentRulesModal.tsx`](src/web/conference/ui/AssignmentRulesModal.tsx) in sync whenever this section changes — it's the in-app source of truth shown to mods and participants.

## Validation

Server and client share valibot schemas in [`src/shared/schemas.ts`](src/shared/schemas.ts). The server returns `{ error: "validation", fields: {...} }`; the client's [`useForm`](src/web/useForm.ts) merges field errors inline.

## Permissions

| Action | participant | moderator | owner |
| --- | :-: | :-: | :-: |
| View conference, sessions, agenda | ✓ | ✓ | ✓ |
| Submit session, star session | ✓ | ✓ | ✓ |
| View experts, book / cancel own booking | ✓ | ✓ | ✓ |
| Invite / remove participants | | ✓ | ✓ |
| Add / edit / delete rooms | | ✓ | ✓ |
| Publish / reject submissions | | ✓ | ✓ |
| Edit a session's *required room features* (after publish) | | ✓ | ✓ |
| Pin a session to a room / allow overlapping placements / mark finished | | ✓ | ✓ |
| Add / delete agenda slots | | ✓ | ✓ |
| Pick talks for static-slot tracks | | ✓ | ✓ |
| Run unconference / mixer assignment, resolve pre-assignment conflicts | | ✓ | ✓ |
| Manage expert pools, promote experts, manage timeframes | | ✓ | ✓ |
| Cancel any expert booking | | ✓ | ✓ |
| Promote / demote moderator, remove a moderator | | | ✓ |
| Change conference settings (design system, timezone, …) | | | ✓ |

The table mirrors [`src/server/lib/permissions.ts`](src/server/lib/permissions.ts) — keep them in sync.

## Tests

```bash
bun test                                    # all
bun test src/server/assignment.test.ts      # algorithm units
bun test src/server/assignment.scale.test.ts
bun test src/server/routes.test.ts          # HTTP integration
```

The assignment algorithm is a pure function and the most heavily covered piece (units + scale + integration). Integration tests run against a fresh per-describe SQLite file.

## Load testing

A self-contained load runner ships in [`scripts/loadtest.ts`](scripts/loadtest.ts). It bootstraps a known scenario (one owner, one conference, eight published sessions — created on first run, reused on subsequent runs) and then hammers the read paths an attendee actually hits from `--users` concurrent virtual users for `--duration` seconds.

```bash
# defaults: 50 users, 30s, http://localhost:3000
bun run loadtest

# remote target, longer run
bun run loadtest -- --base https://unconf.example.com --users 200 --duration 90s

# add per-VU pause to simulate think time
bun run loadtest -- --users 500 --think-ms 100
```

Output is a per-endpoint latency table plus a capacity verdict:

```
=== Capacity ===
State:                HEALTHY | STRESSED | OVERLOADED
Estimated capacity:   ~N active users at this configuration
Note:                 …
```

The active-user estimate assumes ~0.5 req/s per attendee (the `NotificationBell` polls every 30s plus light interactive traffic). For "what resources do I need" runs, point the script at different chart configurations (`workers.count`, `resources.limits.cpu/memory`) and compare the verdict + estimate across runs. The script needs a running server (local `bun run start` or a deployed instance) and is idempotent across runs — leftover data is harmless.

If `DISABLE_SIGNUP` is set on the target, the script tries `auth.login` directly so re-runs against locked-down instances still work as long as the owner account already exists.

### Sweep multiple configs in Docker

For "which `workers.count` + `resources.limits` combo do I actually need" answers, use the sweep runner. It builds the image, then for each config in the matrix it spins up a fresh container with the right `--cpus`/`--memory`/`WORKERS=` and runs the same load logic, then prints a comparison table:

```bash
bun run loadtest:sweep                                       # default matrix (6 configs, ~4 min)
bun run loadtest:sweep -- --users 200 --duration 30s
bun run loadtest:sweep -- --configs "1@0.5/512m 4@2/2g"      # custom matrix
bun run loadtest:sweep -- --image simple-unconference:dev --no-build
```

The default matrix walks `1w/0.5c/512Mi` (chart default) up to `4w/4c/2Gi`. Output shape:

```
=== Sweep results ===
  config                  thrpt    P50      P95      P99     err   state        users
  1w / 0.5c / 512Mi       180r/s    8ms     22ms     35ms    0.0%  HEALTHY      ~360
  1w / 1.0c / 512Mi       340r/s    5ms     14ms     22ms    0.0%  HEALTHY      ~680
  2w / 1.0c / 1Gi         420r/s    5ms     16ms     28ms    0.0%  HEALTHY      ~840
* 2w / 2.0c / 1Gi         720r/s    3ms     12ms     20ms    0.0%  HEALTHY     ~1440
  4w / 2.0c / 1Gi         750r/s    3ms     11ms     19ms    0.0%  HEALTHY     ~1500
  4w / 4.0c / 2Gi        1100r/s    2ms      9ms     15ms    0.0%  HEALTHY     ~2200
```

Requires `docker` on `PATH` (a `docker`-aliased `podman` also works). Each iteration uses an ephemeral container with no mounted volume, so the database is fresh per run — no carry-over between configs. Press Ctrl-C and the in-flight container is stopped before exit.

A reference sweep on a developer laptop is checked in at [docs/loadtest-results.md](docs/loadtest-results.md) to give a feel for how `workers.count` and `resources.limits` interact for this workload. Results from that machine are **not representative of production** — different hardware, the PVC storage class, ingress/TLS in the request path, and whether the client lives inside or outside the cluster will all move the numbers. Run the sweep against your own infrastructure for actual capacity-planning numbers.

## Public Instance Hardening

If you're hosting the app on the open internet (like the free instance at <https://unconference.enking.dev>) the defaults aim to keep you safe from the realistic abuse vectors without breaking the venue-WLAN traffic pattern where dozens-to-hundreds of legitimate attendees share one NAT. Four layers, each addressing a different scenario:

1. **Cloudflare Turnstile** at the edge of the high-abuse endpoints — invisible to most users, challenges suspicious traffic. Configure both [`TURNSTILE_SITE_KEY`](#configuration-environment-variables) and `TURNSTILE_SECRET_KEY` to enable. When set, gated endpoints are `auth.signup`, `auth.login`, `conferences.claimInvite`, and `conferences.signupViaLink`. Per-conference identity login (`conferences.login`) and all read endpoints stay un-gated because the conference slug + email combination already scopes them tightly and read traffic doesn't write to the DB.
2. **Per-email failed-login lockout** for credential stuffing. NAT-blind by design (per-email, not per-IP), so a venue Wi-Fi can have hundreds of attendees logging in concurrently without anyone getting locked out. Defaults to 5 failures / 15 min → 15 min lockout. Tune via `LOGIN_FAIL_*` env vars.
3. **Per-account write rate** (sliding 1-hour window, default 600 writes/account) catches a compromised real account being used as a spam vehicle. Applied to expensive `create`/`update` operations only; stars and notification marks are exempt because legitimate bursts during agenda review are normal.
4. **Per-account / per-conference quotas** are the hard ceilings on what one user or conference can accumulate. Defaults are sized for ~2000-attendee events with ~5 sessions per attendee; raise them via env for private instances if you need more, or lower for stricter public hosting.

Why per-IP is **not** in the list: hundreds of attendees share one outbound IP from the venue Wi-Fi. Per-IP limits on interactive paths would 429 everyone exactly when the app needs to work. The only IP-adjacent thing here is Turnstile, which Cloudflare scores adaptively — it's designed for exactly this scenario.

Every individual layer can be disabled by setting its env var to `0` (or leaving Turnstile's keys empty), so private deployments where you trust your users can run wide-open. The Helm chart's [`limits:`](charts/simple-unconference/values.yaml) and [`turnstile:`](charts/simple-unconference/values.yaml) blocks emit these env vars on the container.

## Adding a design system

1. Implement [`DesignSystem`](src/web/design-system/core/contract.tsx) in `src/web/design-system/<id>/index.tsx`.
2. Register it in [`design-system/core/registry.ts`](src/web/design-system/core/registry.ts).
3. Add the id to the allowlist in the conference update handler ([`src/server/rpc.ts`](src/server/rpc.ts)).

Each plugin ships as its own dynamic-import chunk — the unused one never loads.

## Releases

Versioning is driven by [changesets](https://github.com/changesets/changesets). When you open a PR with user-visible changes, add one with:

```bash
bun run changeset
```

On merge to `main`, the `Release` workflow opens a `Version Packages` PR that bumps `package.json` and updates `CHANGELOG.md`. Merging that PR creates a git tag + GitHub release and pushes a new Docker image to GHCR.

## License

MIT — see [LICENSE.md](LICENSE.md).
