# Simple Unconference Web App - Unconf

A self-hostable platform for running unconferences end-to-end: people, rooms, sessions, custom speakers, scheduling, mixers, expert bookings, a public live projector board, day-of broadcasts, web-push + offline PWA, and notifications — all in one app.

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
  -e APP_URL=https://unconf.example.com \
  -v simple-unconference-data:/app/data \
  --restart unless-stopped \
  ghcr.io/enyineer/simple-unconference:latest
```

`APP_URL` is required — set it to the public origin where users reach this
instance (for a purely local trial, `http://localhost:3000`). The server
refuses to start without it so email links can't silently point at the wrong
host.

Or with Compose:

```yaml
services:
  app:
    image: ghcr.io/enyineer/simple-unconference:latest
    ports:
      - "3000:3000"
    environment:
      APP_URL: https://unconf.example.com
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
| `APP_URL` | **required** | Public base URL of this instance, used to build links in outgoing email (password-reset, email verification). **No default** — the server refuses to start without it, so a misconfigured rollout can't silently send broken/loopback links. Set to your real origin (e.g. `https://unconf.example.com`). The dev launcher (`bun run dev`) sets it to `http://localhost:5173` automatically. |
| `EMAIL_TRANSPORT` | _auto_ | Email backend: `resend`, `smtp`, `memory`, or `none`. When unset, defaults to `resend` if `RESEND_API_KEY` is set, else `none`. `memory` enables email-dependent features (verification, account linking) but only records mail to an in-memory outbox + logs (handy for dev/demos). `none` disables delivery (links are logged). **With no real transport, email verification and cross-conference account linking are switched off; everything else works.** |
| `RESEND_API_KEY` | _unset_ | [Resend](https://resend.com) API key (used when `EMAIL_TRANSPORT=resend`). |
| `SMTP_URL` | _unset_ | Full SMTP connection URL (e.g. `smtp://user:pass@host:587`), used when `EMAIL_TRANSPORT=smtp`. Alternatively set `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE`. Delivered via lazy-loaded `nodemailer`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | _unset_ / `587` / _unset_ / _unset_ / `false` | Discrete SMTP settings (alternative to `SMTP_URL`). |
| `EMAIL_FROM` | `Unconference <onboarding@resend.dev>` | From-address for outgoing email. Set to an address on a domain you've verified (Resend) or that your SMTP server can send as. |
| `VAPID_PUBLIC_KEY` | _unset_ | Web Push VAPID public key. Sent to the SPA (via `config.get`) so browsers can subscribe. Set together with `VAPID_PRIVATE_KEY` to enable OS-level push notifications; leave unset for a no-op (the opt-in never renders). Generate a keypair with `bun run scripts/gen-vapid.ts`. |
| `VAPID_PRIVATE_KEY` | _unset_ | Web Push VAPID private key. **Secret** - kept server-side, never exposed to clients. Required alongside `VAPID_PUBLIC_KEY`. |
| `VAPID_SUBJECT` | _APP_URL / `mailto:admin@example.com`_ | VAPID `sub` claim: a `mailto:` address or `https:` URL identifying the sender to push services. Defaults to `APP_URL` when it's an https origin, otherwise a mailto placeholder. |

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
| `TURNSTILE_SECRET_KEY` | _unset_ | Cloudflare Turnstile secret key. When set, the server requires a valid Turnstile token on `auth.signup`, `auth.login`, `conferences.claimInvite`, `conferences.signupViaLink`, and the password-reset endpoints. Leave unset for a no-op. |
| `PASSWORD_RESET_TOKEN_TTL_MIN` | `30` | Lifetime of a password-reset link, in minutes. Tokens are single-use and cleared on the next successful login. |
| `PASSWORD_RESET_PER_HOUR_PER_EMAIL` | `3` | Sliding-window cap on reset-link requests per email per hour. `0` disables. |
| `PASSWORD_RESET_PER_HOUR_PER_IP` | `0` (off) | Sliding-window cap on reset-link requests per client IP per hour (read from `x-forwarded-for` / `x-real-ip`). **Off by default and NAT-blind on purpose:** participants reset per-conference passwords too, and a venue full of attendees shares one public IP, so a per-IP cap would lock out the crowd at event start. Per-email throttling + Turnstile are the real defenses. Set a positive value only if you know your users aren't behind a shared NAT and want a coarse anti-spray backstop. |
| `EMAIL_VERIFY_CODE_TTL_MIN` | `15` | Lifetime of the 6-digit email-verification code, in minutes. The code is capped at 5 wrong attempts before a resend is required. |
| `EMAIL_VERIFY_LINK_TTL_MIN` | `30` | Lifetime of the email-verification magic link, in minutes. |
| `VERIFY_RESEND_PER_HOUR_PER_EMAIL` | `5` | Sliding-window cap on verification-resend requests per email per hour (plus a hard 30s cooldown between sends). `0` disables. |
| `VERIFY_RESEND_PER_HOUR_PER_IP` | `20` | Sliding-window cap on verification-resend requests per client IP per hour. Verification only ever applies to global accounts (of which a venue has very few), so this is safe to keep on. `0` disables. |

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

A per-conference cap (`submission_max_placements_default`) limits how many times a published session can be placed before it drops out of the unconference algorithm pool. Capped sessions get a *Fully scheduled* badge (or *Marked complete* when the mod flips the manual override) — informational only: participants can still see and star them, and the star still derives any linked planned-slot offerings onto their schedule.

**Custom & multiple speakers (mod-only).** A moderator can set a session's speaker list — any mix of registered participants and free-form typed names for guests who aren't in the system — separate from whoever authored the submission. With no speakers set, the session's speaker defaults to its submitter, so nothing changes for existing sessions. The scheduler keeps each *real* speaker (not just the author) out of two overlapping rooms at once, which lets a mod who created several sessions on other people's behalf schedule them in parallel. Hand-scheduling a session whose speaker is already presenting in an overlapping slot shows a non-blocking heads-up instead of silently double-booking.

**Session priority (mod-only).** A moderator can mark a session `high` / `normal` / `low`. High-priority sessions fill rooms first (and low fill last) in the per-slot placement cut and the seating router — only among a user's starred options; it never overrides manual placements, pins, or capacity.

#### What “star” means {#stars}

A single concept, two effects. Starring a published session on the Sessions tab or via the star toggle in the Agenda calendar both write the same record:

- **Unconference signal.** Star counts rank Submissions when a moderator runs an unconference slot — the most-starred sessions get rooms, and you get auto-assigned to one of yours.
- **Planned-slot schedule derivation.** Every planned-slot `TrackAssignment` that links to a session you starred lands on your *My schedule* (and your iCal feed) automatically. No second action.

Three derivation rules together produce your schedule for planned slots:

1. **Mandatory tracks** (mod-flagged keynote / opening / closing) — on everyone's schedule regardless of stars.
2. **Starred submissions** — every linked planned track derives onto your schedule.
3. **Submitter-self** — if you're the submission's submitter, you see your scheduled speaking gigs without needing to star yourself.

When the same Submission is scheduled in multiple offerings (sibling slots of a series, or independent placements), one star yields multiple schedule rows; *My schedule* groups them with a *Same session also at HH:MM* caption so you can decide which to attend. Overlapping starred entries get a *conflicts with X* pill.

**Per-session assignment controls (mod-only):**

- **Pre-assign to a room** — pin a session to a specific room. The pin always wins over star-based room ranking and tag matching.
- **Required room features** — pick from the conference's actual room tags (no free text; picker only offers tags that exist on at least one room). The assignment algorithm restricts the session's candidate rooms to those whose tag set is a superset of the requested features. Approval is implicit when the session is published — submitters can't edit a published session's tag set, mods can.
- **Allow overlapping placements** — opt-in for sessions meant to run in parallel (e.g. recurring workshops). Off by default, in which case the same session is never placed in two overlapping slots and its submitter never hosts two different sessions in overlapping slots.

| Sessions list | Submit a session | Speakers |
| --- | --- | --- |
| ![Sessions](screenshots/session-overview.webp) | ![Create](screenshots/session-create.webp) | ![Speakers](screenshots/session-speakers.webp) |

### Agenda + slot types

The agenda mixes three slot types on a single timeline:

- **normal** — moderators pick which published Submission runs in which room. Every planned-slot track is anchored to a Submission (the Submission supplies the title and the submitter credit; mods who want an invited speaker without a participant account first create a Submission for them). Tracks can be `mandatory` (forced onto everyone's schedule) and carry their own requirements.
- **unconference** — a [pure, deterministic algorithm](src/server/assignment.ts) places the most-starred sessions into appropriately-sized rooms, then assigns each starring user. The route layer ([`runAssignmentForSlot`](src/server/rpc.ts)) adds pin / tag / overlap pre-processing before the pure algorithm runs (see [Assignment algorithm](#assignment-algorithm) below). `avoidRepeats` keeps people out of sessions they've already attended; per-slot `selectedRooms` / `selectedSubmissions` scope the assignment to a subset.
- **mixer** — capacity-aware even split of every participant across selected rooms. *Exclusive* mode prefers rooms with the fewest previously-paired people; *fresh* mode ignores history.

Moderators can also **duplicate any slot as a linked offering**, which forms a `SlotSeries`: shared room pool / submission pool / config across the offerings, edited once via the series form. Sibling offerings can rotate participants (`avoidRepeatsAcrossSiblings`, default on) so the same starred person doesn't land on the same Submission twice across siblings, or explicitly allow re-attendance for open-discussion-style repeats.

A **"How assignment works"** modal (the `?` icon next to the slot's actions and in the Agenda header) renders a plain-language explanation of every rule the algorithm applies — including the mod-only conflict-resolution flow when sessions can't be placed.

**Planned-slot room refit** (mod-only) is a stable, minimal-move repair of a normal slot's room assignment — not a re-rank. It moves only the tracks that no longer fit (interest outgrew the room, a pin points elsewhere, room requirements aren't met, or a time-overlapping slot double-books the room) into the best free room, leaving every non-misfit put. No room is ever double-booked across time-overlapping slots: an overlap-held room is off-limits to every room-authoring path (refit, track picks, and unconference placement alike).

| Static slot | Unconference slot | Mixer slot |
| --- | --- | --- |
| ![Static](screenshots/agenda-static-detail.webp) | ![Unconference](screenshots/agenda-unconference-detail.webp) | ![Mixer](screenshots/agenda-mixer-detail.webp) |

### My schedule

Each participant gets a personal schedule that unions, for this conference:

- their unconference + mixer placements (algorithm output);
- every planned-slot track derived from the [unified Star concept](#stars) — mandatory, starred-submission, or you're-the-submitter;
- their expert bookings (as booker or as expert).

When an unconference runs but someone couldn't be placed (all their stars filled up), they see a *Pick a session* banner with the available rooms. Manual picks are preserved across re-runs. Same-submission rows (sibling offerings / repeats) are grouped with a *Same session also at HH:MM* caption; time-overlapping starred rows surface a *conflicts with X* pill. A per-identity iCal feed exposes the same union to external calendar apps.

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

**Room constraints.** Two optional limits keep the scheduler off rooms it shouldn't touch:

- **Expert-dedicated rooms** — any room in an expert's booking pool (or pinned to an expert) is excluded from *every* slot assignment, so a 1:1 room is never grabbed by an unconference session. Automatic assignment drops them silently; a manual placement onto one is refused with a clear conflict.
- **Availability windows** — optionally give a room one or more time windows in which it's usable (no windows = always available, so existing conferences are unaffected). The scheduler only places a session in a room when the slot fits fully inside one of its windows; an availability edit that would strand an existing track / placement / booking is rejected.

| Rooms | Add room |
| --- | --- |
| ![Rooms](screenshots/room-overview.webp) | ![Add room](screenshots/room-add-room.webp) |

### Experts (1:1 bookings)

Promote any identity to an *expert*; give them a room pool (or a fixed set of rooms) and one or more bookable timeframes. Slots are derived deterministically from each timeframe; participants book one with a single click. Room allocation is locked at booking time so re-shuffling expert room config doesn't strand bookings.

| Experts | Promote | Room pools |
| --- | --- | --- |
| ![Experts](screenshots/expert-overview.webp) | ![Promote](screenshots/expert-promote.webp) | ![Pools](screenshots/expert-pools.webp) |

### Notifications

Per-identity in-app inbox with unread badges. Events covered: submission received / published / rejected, unconference + mixer placement, expert booking confirmed / cancelled, schedule changes, and broadcast announcements. Each notification carries an optional CTA that deep-links to the relevant tab.

### Live Board & Pitch Mode

A public, token-gated projector board for the hallway screen: a read-only schedule grid that fills in live (no reload) and carries a join QR so anyone can pull the agenda onto their phone. The board is email-free by design — display names, titles, room names, and star / attendee counts only. It auto-fits any screen: rooms and time windows are paginated into pages that each fit the display and auto-rotate on a calm cadence, headlining the current day and a "Rooms X of Y" indicator, and a multi-day conference never mixes two days on one page. **Pitch Mode** lets a moderator spotlight the session currently being pitched — the wall highlights it and shows its star count climb in real time.

Owners enable the board from Settings; the link can be rotated to revoke old copies.

| Live Board | Pitch Mode spotlight |
| --- | --- |
| ![Live Board](screenshots/board-live.webp) | ![Pitch Mode spotlight](screenshots/board-pitch-spotlight.webp) |

### Day-of live mode

Everything to run the event on the day. The Me / *My schedule* tab gets a **Right Now** card that anchors each participant to their current session and room with up-next preview and one-tap switching. Moderators get a **broadcast** megaphone: one short announcement fans out as an in-app notification (and toast) to every participant instantly.

| Right Now | Broadcast |
| --- | --- |
| ![Right Now](screenshots/right-now.webp) | ![Broadcast](screenshots/broadcast.webp) |

### Wrap-up & takeaways

Each session collects **takeaways** — short notes anyone who attended can add — which roll up into a personal post-event recap on the Me tab. Moderators get an **Event report** sheet that turns the conference into printable numbers: participants, seats filled, stars, top sessions, and room utilization.

![Event report](screenshots/event-report.webp)

### Onboarding & duplication

First-time participants get a three-step **welcome rail** that orients them (star sessions, check your schedule, explore people). Owners can **duplicate** a past conference — rooms, slots, and settings are cloned and re-anchored to a new date; people, submissions, placements, and tokens are never copied.

![Welcome rail](screenshots/welcome-rail.webp)

### Web Push & offline (PWA)

The app installs as a PWA and keeps showing your schedule when the venue wifi drops (read-only offline; no write queueing). It also supports opt-in OS-level **Web Push**, enabled per browser from the notification bell, so notifications reach participants even when the app is closed. Push augments — never replaces — the in-app bell and toast, is best-effort (a push failure never affects the in-app notification), and stays privacy-safe (names and titles only, never emails). It's fully inert until the instance configures VAPID keys (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — see [Configuration](#configuration-environment-variables)).

### Settings (per-conference, owner-only)

Timezone, design system, mixer-avoid-repeats default, submission placement cap default, participant-submissions toggle, the public Live Board link (enable / rotate), and one-click conference duplication. Settings auto-save with inline checkmark feedback — no save buttons.

![Settings](screenshots/conference-settings.webp)

## Assignment algorithm

The unconference / mixer assignment runs in two layers:

1. **Pure algorithm** ([src/server/assignment.ts](src/server/assignment.ts)) — given rooms, submissions, stars, and a per-submission `preAssignments` map, produces a deterministic `{ placements, user_assignments, unplaced_users }` result. Same input → same output (no random reshuffle on re-run; mixer slots use a stable per-slot seed).
2. **Route layer** ([`runAssignmentForSlot`](src/server/rpc.ts) / `runMixerForSlot`) — loads DB state, applies the rules below, computes `preAssignments`, then calls the pure algorithm and persists the result.

Steps the route layer runs, in order:

1. **Eligibility filter.** Drop sessions tagged *Fully scheduled* (placement cap reached) or *Marked complete* (manual `manually_finished` flag), and any in the call's `exclude_submission_ids` set. These sessions stay visible to participants and remain starrable — the filter only gates the algorithm pool.
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
| Submit session, star a session (unified — drives unconference ranking AND planned-track schedule visibility; see [Stars](#stars)) | ✓ | ✓ | ✓ |
| View experts, book / cancel own booking | ✓ | ✓ | ✓ |
| Invite / remove participants | | ✓ | ✓ |
| Add / edit / delete rooms | | ✓ | ✓ |
| Publish / reject submissions | | ✓ | ✓ |
| Edit a session's *required room features* (after publish) | | ✓ | ✓ |
| Pin a session to a room / allow overlapping placements / mark finished / set assignment priority | | ✓ | ✓ |
| Set a session's speakers (custom / multiple presenters) | | ✓ | ✓ |
| Add / delete agenda slots | | ✓ | ✓ |
| Pick talks for static-slot tracks, refit planned-slot rooms | | ✓ | ✓ |
| Set per-room availability windows (dedicated rooms via expert pools) | | ✓ | ✓ |
| Run unconference / mixer assignment, resolve pre-assignment conflicts | | ✓ | ✓ |
| Spotlight a session on the Live Board (Pitch Mode) | | ✓ | ✓ |
| Send broadcast announcements | | ✓ | ✓ |
| View / print the event report | | ✓ | ✓ |
| Manage expert pools, promote experts, manage timeframes | | ✓ | ✓ |
| Cancel any expert booking | | ✓ | ✓ |
| Add session takeaways, view own post-event recap | ✓ | ✓ | ✓ |
| Promote / demote moderator, remove a moderator | | | ✓ |
| Change conference settings (design system, timezone, …) | | | ✓ |
| Enable / rotate the public Live Board link, duplicate a conference | | | ✓ |
| View own profile + published profiles in the directory | ✓ | ✓ | ✓ |
| Edit own profile (bio, links, contacts, tags, avatar) | ✓ | ✓ | ✓ |
| View unpublished profiles, see members' canonical emails | | ✓ | ✓ |
| Edit any member's profile / upload avatar on their behalf | | ✓ | ✓ |
| 1-on-1 chat (send / edit / delete own messages, block, report) | ✓ | ✓ | ✓ |
| DM unpublished members (e.g. moderation outreach) | | ✓ | ✓ |
| Review chat reports + ban / unban identities from chat | | ✓ | ✓ |

Profile entries (links / contacts) have a per-row `is_public` flag: non-mods
only see entries marked public; mods + the profile owner see all. The
`/api/avatars/:slug/:identityId` endpoint mirrors `profiles.get` visibility
and falls back to an initials SVG (never 404) so the existence of an
unpublished profile can't be probed via status code.

Chat eligibility (`canChatWith` in
[src/server/lib/permissions.ts](src/server/lib/permissions.ts)) requires both
identities to be published, both to have chat enabled, neither banned, and no
block in either direction. Mods bypass only the *published* check (so they
can DM unpublished members for moderation outreach); every other gate
still applies. Rate limits: 10 new conversations/hour and 30 messages/minute
per identity; messages capped at 4096 bytes (`CHAT_NEW_CONVERSATIONS_PER_HOUR`,
`CHAT_MESSAGES_PER_MINUTE`, `CHAT_MESSAGE_MAX_BYTES` env vars).

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

## Metrics (Prometheus)

Metrics live on a **dedicated port** (`METRICS_PORT`, default `9090`) at `GET /metrics` — **not** on the main API port. The Helm chart provisions a separate `ClusterIP` Service (`<release>-simple-unconference-metrics`) so the scrape path stays in-cluster regardless of whether the app's main Service is exposed via Ingress. Set `METRICS_TOKEN` to require `Authorization: Bearer <token>` if your scrape network is not fully trusted.

When `WORKERS > 1`, the cluster launcher aggregates per-worker snapshots received over IPC: every worker pushes its in-memory counters every 5 s, worker 0 additionally pushes DB + storage counts, and the launcher serves the merged result on every scrape. This avoids the Prometheus "oscillating values" problem you'd get from `SO_REUSEPORT` plus per-worker counters, and keeps the active gauges (`realtime_sse_active_connections`, `bus_active_subscriptions`) honest as `sum(metric)` in PromQL.

Exposed metrics:

| Metric | Description |
| --- | --- |
| `app_uptime_seconds` | Seconds since the metrics server started (launcher in cluster mode, app in single-worker). |
| `app_workers_total` | Workers that have reported a fresh snapshot within the staleness threshold. |
| `app_workers_stale_total` | Workers known to the launcher but with snapshots older than the threshold — non-zero = the worker is wedged. |
| `app_metrics_global_stale` | 1 when the global counts come from a stale snapshot, 0 otherwise. |
| `worker_uptime_seconds{worker="N"}` | Per-worker uptime as reported in its latest snapshot. |
| `realtime_sse_active_connections{worker="N"}` | Open SSE connections served by worker N. Aggregate with `sum()`. |
| `realtime_sse_total_connections{worker="N"}` | Lifetime SSE connections accepted by worker N. |
| `realtime_sse_replay_message_events_total{worker="N"}` / `realtime_sse_replay_notification_events_total{worker="N"}` | Events emitted via Last-Event-ID replay on reconnect. |
| `bus_active_subscriptions{worker="N"}` | Active EventBus subscriptions on worker N (one per SSE connection per identity). |
| `bus_ipc_sent_total{worker="N"}` / `bus_ipc_received_total{worker="N"}` | IPC bus message counters per worker. |
| `bus_published_total{worker="N",kind="…"}` / `bus_delivered_total{worker="N",kind="…"}` | Publish + handler-invocation counts split by event kind. |
| `users_total`, `conferences_total`, `conference_identities_total`, `submissions_total`, `submissions_by_status_total{status="…"}`, `stars_total`, `notifications_total`, `rooms_total`, `invites_total`, `invites_unclaimed_total`, `experts_total`, `expert_bookings_total` | Instance-wide row counts. |
| `chat_conversations_total`, `chat_conversations_accepted_total`, `chat_messages_total`, `chat_messages_deleted_total`, `chat_reports_total`, `chat_reports_open_total`, `chat_blocks_total`, `chat_banned_identities_total`, `chat_disabled_identities_total` | Chat row counts. |
| `storage_pvc_total_bytes` / `storage_pvc_free_bytes` / `storage_pvc_used_bytes` | Data volume from `statfs`. |
| `storage_db_file_bytes` | SQLite file size on disk (WAL/SHM excluded). |

The chart's `metrics:` block configures this:

```yaml
metrics:
  enabled: true          # set false to disable the port + Service
  port: 9090             # METRICS_PORT (container port; not exposed on the main Service)
  token: ""              # METRICS_TOKEN — empty = open endpoint
  serviceMonitor:
    enabled: true        # render a ServiceMonitor for prometheus-operator
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
  prometheusRule:
    enabled: true        # render a PrometheusRule with starter alerts
    labels:
      release: kube-prometheus-stack
    chatReportsBacklogThreshold: 10
  dashboard:
    enabled: true        # render a ConfigMap that Grafana's dashboards-sidecar imports
    folder: "Apps"       # Grafana folder name (empty = General)
```

When `metrics.token` is set, the chart also renders a `Secret` named `<release>-simple-unconference-metrics` carrying the token, and the ServiceMonitor references it via `spec.endpoints[].authorization` — no manual Secret wiring required.

### Alerts (PrometheusRule)

With `metrics.prometheusRule.enabled: true`, the chart ships a [`PrometheusRule`](charts/simple-unconference/templates/prometheusrule.yaml) with seven starter alerts grouped by concern, all scoped to `{service="<release>-metrics"}` so multiple releases of the chart in one Prometheus stay isolated:

| Group | Alert | Fires when |
| --- | --- | --- |
| health | `SimpleUnconferenceScrapeDown` | `up == 0` for 2 m |
| health | `SimpleUnconferenceNoWorkers` | `app_workers_total == 0` for 2 m |
| health | `SimpleUnconferenceWorkerStale` | `app_workers_stale_total > 0` for 5 m |
| health | `SimpleUnconferenceGlobalMetricsStale` | `app_metrics_global_stale == 1` for 10 m |
| storage | `SimpleUnconferenceStorageLow` | data volume <15% free for 10 m |
| storage | `SimpleUnconferenceStorageCritical` | data volume <5% free for 5 m |
| moderation | `SimpleUnconferenceChatReportsBacklog` | `chat_reports_open_total > threshold` for 1 h |

The chat-reports threshold defaults to `10` and is tunable via `metrics.prometheusRule.chatReportsBacklogThreshold`. No Alertmanager receivers are configured by the chart — wire your own Slack / email / PagerDuty routes in your `kube-prometheus-stack` values.

### Grafana dashboard

With `metrics.dashboard.enabled: true`, the chart renders a `ConfigMap` carrying [`dashboards/simple-unconference.json`](charts/simple-unconference/dashboards/simple-unconference.json), labeled `grafana_dashboard: "1"` so the standard Grafana dashboards-sidecar (default in `kube-prometheus-stack`) auto-imports it within ~10 s. The dashboard has 11 panels across four rows:

- **Health** — fresh workers, stale workers, global-metrics-stale indicator, uptime.
- **Realtime** — SSE active connections (total + per worker), bus events published rate by event kind.
- **Storage** — data volume % used gauge, SQLite file size over time, submissions-by-status donut.
- **Content & Chat** — users, conferences, identities, chat messages, open chat reports, expert bookings.

The dashboard uses a `${datasource}` template variable rather than hard-coding a Prometheus datasource, so it works under any Grafana install that has at least one Prometheus datasource registered. Stable URL: `…/d/simple-unconference`.

If your Grafana's dashboards-sidecar is namespace-scoped (not the kube-prometheus-stack default), set `metrics.dashboard.namespace` to the Grafana namespace so the ConfigMap lands where the sidecar looks. Non-default sidecar label keys/values can be configured via `metrics.dashboard.label` / `labelValue`.

For non-operator Prometheus setups, scrape the dedicated Service:

```yaml
scrape_configs:
  - job_name: simple-unconference
    metrics_path: /metrics
    static_configs:
      - targets: ["unconf-simple-unconference-metrics.unconference.svc:9090"]
    # optional, when METRICS_TOKEN is set:
    authorization:
      type: Bearer
      credentials: "<your-token>"
```

For local development, set `METRICS_PORT=9090` before `bun run dev` to expose the endpoint at `http://localhost:9090/metrics`. Without `METRICS_PORT`, metrics are disabled. The collector resolves a sensible `DATA_DIR` and logs a startup warning when it falls back to `./data` (or CWD), so the zeros in `storage_*` gauges never mystify someone running `bun dev`.

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
