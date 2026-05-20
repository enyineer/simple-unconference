# simple-unconference

A self-hostable platform for running unconferences end-to-end: people, rooms, sessions, scheduling, mixers, expert bookings and notifications — all in one app.

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

## Features

### Sessions

Anyone can submit a session idea. Moderators publish, reject, or delete; participants star the ones they want to attend. Tags + per-session requirements (e.g. *laptop*, *github account*) are surfaced wherever the talk shows up.

A per-conference cap (`submission_max_placements_default`) limits how many times a published session can be placed before it drops out of the unconference pool; mods can override per-submission or mark one *manually finished*.

| Sessions list | Submit a session |
| --- | --- |
| ![Sessions](screenshots/session-overview.webp) | ![Create](screenshots/session-create.webp) |

### Agenda + slot types

The agenda mixes three slot types on a single timeline:

- **normal** — moderators pick which talk runs in which room. Tracks can be `mandatory` (forced onto everyone's schedule) and carry their own requirements.
- **unconference** — a [pure, deterministic algorithm](src/server/assignment.ts) places the most-starred sessions into appropriately-sized rooms, then assigns each starring user. `avoidRepeats` keeps people out of sessions they've already attended; per-slot `selectedRooms` / `selectedSubmissions` scope the assignment to a subset.
- **mixer** — capacity-aware even split of every participant across selected rooms. *Exclusive* mode prefers rooms with the fewest previously-paired people; *fresh* mode ignores history.

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
| Add / delete agenda slots | | ✓ | ✓ |
| Pick talks for static-slot tracks | | ✓ | ✓ |
| Run unconference / mixer assignment | | ✓ | ✓ |
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

## Adding a design system

1. Implement [`DesignSystem`](src/web/design-system/core/contract.tsx) in `src/web/design-system/<id>/index.tsx`.
2. Register it in [`design-system/core/registry.ts`](src/web/design-system/core/registry.ts).
3. Add the id to the allowlist in the conference update handler ([`src/server/rpc.ts`](src/server/rpc.ts)).

Each plugin ships as its own dynamic-import chunk — the unused one never loads.

## License

MIT — see [LICENSE.md](LICENSE.md).
