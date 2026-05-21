// Slot-assignment algorithms (pure functions — no DB access).
//
// USER-FACING DOCS: the plain-language explanation shown to mods and
// participants lives in `src/web/conference/ui/AssignmentRulesModal.tsx`.
// **Update that file whenever you change behavior in this one** — it's the
// single source of truth for what we promise the algorithm will do.
//
// Two algorithms live here, sharing input shape conventions so the caller can
// branch by slot type without juggling unrelated structures:
//
//  - `assignUnconferenceSlot`: most-starred submissions get rooms, users get
//    one of their starred placed sessions, balanced across rooms.
//    Two extra rules layered on top of star matching:
//
//      1. Submitter-as-host: when a submission is placed, its submitter is
//         force-assigned to lead it, overriding their stars entirely. If the
//         same user submitted multiple placed submissions in this slot, they
//         lead the most-starred (id-asc tiebreak).
//
//      2. Avoid repeats: when `priorAssignments[userId]` includes a submission
//         the user has already attended in an earlier slot, that submission is
//         removed from their candidate set (toggleable per slot). Submitters
//         are exempt — leading their own session always wins.
//
//  - `assignMixerSlot`: capacity-aware even split of every participant across
//    the slot's selected rooms. No submissions involved. Optionally takes a
//    set of `priorPairings` (pairs of users who already shared a room in an
//    earlier "exclusive" mixer); when provided, the algorithm prefers rooms
//    where this user meets the fewest people they've already met. Soft
//    constraint: when overlap is unavoidable, everyone still gets a room.
//
// Both are deterministic — tie-broken by id ascending — so tests stay stable.
//
// NOTE on identity model: in this codebase `ID` is just `number`. Wherever the
// inputs name a user (the keys of `stars` / `priorAssignments` / `fixedAssignments`,
// the values of `userIds`, and `submitter_id`), the value is a
// `ConferenceIdentity.id` — never a global `User.id`. The pure algorithm is
// agnostic; this note is for callers wiring DB rows in.

import type { ID, AssignmentResult, MixerResult } from "../shared/types";

export interface AssignmentRoom {
  id: ID;
  capacity: number;
}

export interface AssignmentSubmission {
  id: ID;
  /** The user who submitted this. Used for the submitter-as-host rule. */
  submitter_id: ID;
}

export interface AssignmentInput {
  rooms: AssignmentRoom[];
  // Published submissions eligible for this slot.
  submissions: AssignmentSubmission[];
  // For each user (the conference's participants), which submissions did they star?
  // Users who starred nothing are still expected to appear here with an empty list,
  // so they end up in `unplaced_users` (need a hint).
  stars: Map<ID, Set<ID>>;
  // For each user, which submissions have they already attended in earlier
  // slots? When `avoidRepeats` is true, these are removed from their candidate
  // set. Optional — defaults to "no prior assignments".
  priorAssignments?: Map<ID, Set<ID>>;
  // When true (default), repeat candidates are filtered out per the rule above.
  avoidRepeats?: boolean;
  // Per-user fixed assignments — a user → submission they've manually picked
  // (via `PUT /me/assignment`). Honored before stars and submitter rule:
  // capacity is reserved and the user is locked in. Entries whose submission
  // isn't placed in this slot, or that would overflow capacity, are silently
  // dropped (the user falls back into the regular flow).
  fixedAssignments?: Map<ID, ID>;
  // Per-submission pre-assigned room (moderator-set). Honored ahead of the
  // star-based room ranking: any submission listed here that's in the
  // candidate pool gets its room first, and the remaining rooms feed the
  // normal popularity zip.
  //
  // The caller is responsible for validating that:
  //   1. no two entries target the same room id, and
  //   2. every entry's room id is in `rooms`.
  // The algorithm throws when these invariants don't hold — the route layer
  // surfaces a structured conflict error to the moderator before getting
  // here, so a runtime throw indicates a caller bug.
  preAssignments?: Map<ID, ID>;
}

/**
 * Stable, deterministic assignment for unconference slots.
 */
export function assignUnconferenceSlot(input: AssignmentInput): AssignmentResult {
  const { rooms, submissions, stars } = input;
  const priorAssignments = input.priorAssignments ?? new Map<ID, Set<ID>>();
  const avoidRepeats = input.avoidRepeats ?? true;

  // ----- Phase A: pick which submissions run, and place them in rooms. -----

  // Star count per submission.
  const submissionStarCount = new Map<ID, number>();
  for (const sub of submissions) submissionStarCount.set(sub.id, 0);
  for (const set of stars.values()) {
    for (const subId of set) {
      if (submissionStarCount.has(subId)) {
        submissionStarCount.set(subId, submissionStarCount.get(subId)! + 1);
      }
    }
  }

  // Most-starred first; stable tie-break by id ascending.
  const submissionsByPopularity = [...submissions].sort((a, b) => {
    const sa = submissionStarCount.get(a.id) ?? 0;
    const sb = submissionStarCount.get(b.id) ?? 0;
    if (sb !== sa) return sb - sa;
    return a.id - b.id;
  });

  // Largest capacity first; tie-break by id ascending.
  const roomsByCapacity = [...rooms].sort((a, b) => {
    if (b.capacity !== a.capacity) return b.capacity - a.capacity;
    return a.id - b.id;
  });
  const roomById = new Map<ID, AssignmentRoom>();
  for (const r of rooms) roomById.set(r.id, r);

  // Stars decide which submissions are placed: take the top-N most-starred,
  // where N = min(rooms, submissions). Pre-assignment only chooses *which
  // room* a placed submission occupies — it never promotes a low-star
  // session into the placement set. A pin on a session that doesn't make
  // the top-N is silently ignored.
  const numPlaced = Math.min(roomsByCapacity.length, submissionsByPopularity.length);
  const topN = submissionsByPopularity.slice(0, numPlaced);
  const topNIds = new Set<ID>(topN.map((s) => s.id));

  const placedSubmissionRoom = new Map<ID, ID>(); // submission_id -> room_id
  const roomCapacity = new Map<ID, number>();     // submission_id -> capacity
  const placedSubmitterOf = new Map<ID, ID>();    // submission_id -> submitter_id

  // Pre-assignments win their rooms first — but only for submissions that
  // made the top-N cut. The route layer's conflict gate is responsible for
  // catching duplicate rooms / out-of-scope rooms BEFORE calling us, using
  // the same top-N restriction; throws here indicate a caller bug.
  const preAssignments = input.preAssignments;
  const reservedRoomIds = new Set<ID>();
  if (preAssignments && preAssignments.size > 0) {
    const submissionsById = new Map<ID, AssignmentSubmission>();
    for (const sub of submissions) submissionsById.set(sub.id, sub);
    // Walk in (submission id, room id) ascending order for deterministic
    // error messages.
    const preEntries = [...preAssignments.entries()].sort((a, b) =>
      a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1],
    );
    for (const [subId, roomId] of preEntries) {
      if (!topNIds.has(subId)) continue; // low-star or excluded; pin ignored
      const sub = submissionsById.get(subId)!;
      const room = roomById.get(roomId);
      if (!room) {
        throw new Error(
          `preAssignment for submission ${subId} targets room ${roomId} which is not in the slot's room set`,
        );
      }
      if (reservedRoomIds.has(roomId)) {
        throw new Error(
          `preAssignment conflict: room ${roomId} is requested by multiple submissions`,
        );
      }
      reservedRoomIds.add(roomId);
      placedSubmissionRoom.set(subId, roomId);
      roomCapacity.set(subId, room.capacity);
      placedSubmitterOf.set(subId, sub.submitter_id);
    }
  }

  // Zip the remaining (unpinned) top-N submissions into the remaining
  // rooms by popularity → largest-room. Same behavior as before pinning
  // was introduced; pinning only steals rooms out of the pool first.
  const remainingRooms = roomsByCapacity.filter((r) => !reservedRoomIds.has(r.id));
  const remainingTopN = topN.filter((s) => !placedSubmissionRoom.has(s.id));
  const numRemaining = Math.min(remainingRooms.length, remainingTopN.length);
  for (let i = 0; i < numRemaining; i++) {
    const sub = remainingTopN[i]!;
    const room = remainingRooms[i]!;
    placedSubmissionRoom.set(sub.id, room.id);
    roomCapacity.set(sub.id, room.capacity);
    placedSubmitterOf.set(sub.id, sub.submitter_id);
  }

  // ----- Phase B: assign users. -----

  const userIds = [...stars.keys()].sort((a, b) => a - b);
  const currentLoad = new Map<ID, number>(); // submission_id -> # assigned
  for (const sid of placedSubmissionRoom.keys()) currentLoad.set(sid, 0);

  const userAssignments: { user_id: ID; submission_id: ID }[] = [];
  const assignedUsers = new Set<ID>();

  // Phase B.0: honor user-driven manual picks first. They have the highest
  // priority — they trump submitter-as-host, stars, and avoid-repeats. We
  // walk the fixed entries in user-id-asc order so the same input produces
  // the same output, and we drop entries whose target is no longer placed
  // or that would overflow capacity (defensive: the route capacity-checks
  // on PUT, but a moderator can shrink rooms or scope after the fact).
  const fixed = input.fixedAssignments;
  if (fixed && fixed.size > 0) {
    const fixedUsers = [...fixed.keys()].sort((a, b) => a - b);
    for (const uid of fixedUsers) {
      const subId = fixed.get(uid)!;
      if (!placedSubmissionRoom.has(subId)) continue;     // target not placed
      if (!stars.has(uid)) continue;                       // not a member
      const cap = roomCapacity.get(subId)!;
      if (currentLoad.get(subId)! >= cap) continue;        // overflow
      userAssignments.push({ user_id: uid, submission_id: subId });
      currentLoad.set(subId, currentLoad.get(subId)! + 1);
      assignedUsers.add(uid);
    }
  }

  // Phase B.1: pin submitters to their own placed submissions first. They
  // consume capacity before stars are honored — leading your own session is
  // a hard requirement, not a preference.
  //
  // If one user submitted multiple placed sessions in this slot, they lead
  // the most-starred (popularity order, id-asc tiebreak). Build per-user
  // submitter assignments deterministically.
  const submitterChoice = new Map<ID, ID>(); // user_id -> submission_id (their pick)
  for (const sub of submissionsByPopularity) {
    if (!placedSubmissionRoom.has(sub.id)) continue;
    if (!stars.has(sub.submitter_id)) continue; // not a conference member
    if (submitterChoice.has(sub.submitter_id)) continue; // already picked
    submitterChoice.set(sub.submitter_id, sub.id);
  }
  // Apply in user-id-asc order for stable output.
  for (const uid of userIds) {
    if (assignedUsers.has(uid)) continue; // already pinned by a manual pick
    const subId = submitterChoice.get(uid);
    if (subId === undefined) continue;
    const cap = roomCapacity.get(subId)!;
    if (currentLoad.get(subId)! >= cap) {
      // Degenerate — room of size 0 or other capacity miss. Skip; they'll fall
      // through to the normal loop (where they're already constrained out).
      continue;
    }
    userAssignments.push({ user_id: uid, submission_id: subId });
    currentLoad.set(subId, currentLoad.get(subId)! + 1);
    assignedUsers.add(uid);
  }

  // Phase B.2: build per-user candidate sets for the remaining users.
  // Candidates = (user's stars) ∩ (placed submissions) − (prior assignments if avoidRepeats).
  const candidates = new Map<ID, ID[]>();
  for (const uid of userIds) {
    if (assignedUsers.has(uid)) continue;
    const prior = priorAssignments.get(uid);
    const starredHere: ID[] = [];
    const starred = stars.get(uid)!;
    for (const subId of starred) {
      if (!placedSubmissionRoom.has(subId)) continue;
      if (avoidRepeats && prior && prior.has(subId)) continue;
      starredHere.push(subId);
    }
    starredHere.sort((a, b) => a - b);
    candidates.set(uid, starredHere);
  }

  // Process users in order of fewest candidates first (constrained users go first).
  // Tie-break by user id ascending. Empty-candidate users are filtered out — they're
  // always unplaced and listed at the end.
  const userOrder = userIds
    .filter((uid) => !assignedUsers.has(uid) && candidates.get(uid)!.length > 0)
    .sort((a, b) => {
      const la = candidates.get(a)!.length;
      const lb = candidates.get(b)!.length;
      if (la !== lb) return la - lb;
      return a - b;
    });

  const unplaced: ID[] = [];

  for (const uid of userOrder) {
    const cands = candidates.get(uid)!;

    // Pick the candidate that:
    //  - has remaining capacity, AND
    //  - has the lowest current load (most balanced choice),
    //  - tie-broken by largest remaining capacity, then smallest id.
    let best: ID | null = null;
    let bestLoad = Infinity;
    let bestRemaining = -1;

    for (const subId of cands) {
      const cap = roomCapacity.get(subId)!;
      const load = currentLoad.get(subId)!;
      const remaining = cap - load;
      if (remaining <= 0) continue;
      if (
        load < bestLoad ||
        (load === bestLoad && remaining > bestRemaining) ||
        (load === bestLoad && remaining === bestRemaining && (best === null || subId < best))
      ) {
        best = subId;
        bestLoad = load;
        bestRemaining = remaining;
      }
    }

    if (best === null) {
      unplaced.push(uid);
    } else {
      userAssignments.push({ user_id: uid, submission_id: best });
      currentLoad.set(best, currentLoad.get(best)! + 1);
      assignedUsers.add(uid);
    }
  }

  // Users with no candidates at all and not already assigned — always unplaced.
  for (const uid of userIds) {
    if (assignedUsers.has(uid)) continue;
    if ((candidates.get(uid)?.length ?? 0) === 0) unplaced.push(uid);
  }
  unplaced.sort((a, b) => a - b);

  const placements = [...placedSubmissionRoom.entries()]
    .map(([submission_id, room_id]) => ({
      slot_id: 0, // caller fills this in when persisting
      submission_id,
      room_id,
    }))
    .sort((a, b) => a.submission_id - b.submission_id);

  return {
    placements,
    user_assignments: userAssignments
      .map((a) => ({ slot_id: 0, user_id: a.user_id, submission_id: a.submission_id }))
      .sort((a, b) => a.user_id - b.user_id),
    unplaced_users: unplaced,
  };
}

// ---------------------------------------------------------------------------

export interface MixerInput {
  rooms: AssignmentRoom[];
  /** Every conference participant who should get a room. */
  userIds: ID[];
  /**
   * Seed for the deterministic shuffle. Same seed + same input → same output;
   * different seeds shuffle users into different rooms. Callers should pass a
   * stable value tied to the slot (e.g. the slot id) so reruns reproduce but
   * each mixer slot produces its own scramble. Defaults to 0.
   */
  seed?: number;
  /**
   * Pairs of users (canonical `a:b` with a < b) who have already shared a
   * room in a prior "exclusive" mixer. When set, the algorithm prefers rooms
   * that contain the fewest people each user has already met. Soft constraint
   * only — when overlap is unavoidable (capacity-bound), the assignment still
   * places everyone, minimizing total repeated pairings as best it can.
   *
   * Pass an empty set (or omit) for a "fresh shuffle" mixer that ignores
   * history entirely.
   */
  priorPairings?: ReadonlySet<string>;
}

/** Canonical key for an unordered pair of user ids. */
export function pairKey(a: ID, b: ID): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// Tiny seeded PRNG (mulberry32). Public-domain, identical to what the scale
// test uses — we want a stable, fast, dependency-free RNG.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates shuffle, in-place clone, using the supplied RNG.
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * Capacity-aware even split across rooms.
 *
 * Algorithm:
 *  1. Sort users by id (so callers don't need to pre-sort; canonicalizes input).
 *  2. Shuffle deterministically using `seed` so users don't end up in the same
 *     room every time we re-run a mixer — each mixer produces its own scramble.
 *  3. Walk the shuffled list, dropping each user into the room with the lowest
 *     current load (and remaining capacity), tie-broken by largest capacity
 *     then smallest id. Users that overflow total capacity → `unplaced_users`.
 *
 * The returned `room_assignments` array is re-sorted by user id for stable
 * output that's easy to diff in tests and snapshots.
 */
export function assignMixerSlot(input: MixerInput): MixerResult {
  const { rooms, userIds } = input;
  const seed = input.seed ?? 0;
  const priorPairings = input.priorPairings ?? new Set<string>();
  const canonical = [...userIds].sort((a, b) => a - b);
  const ordered = shuffle(canonical, mulberry32(seed));

  const load = new Map<ID, number>();
  const occupants = new Map<ID, ID[]>();
  for (const r of rooms) {
    load.set(r.id, 0);
    occupants.set(r.id, []);
  }

  const roomAssignments: { user_id: ID; room_id: ID }[] = [];
  const unplaced: ID[] = [];

  // For each user: pick the room that minimizes (repeat-count, current-load),
  // then prefers larger capacity and lower id. The repeat-count is the number
  // of users already in the room with whom this user shares a prior pairing.
  // When `priorPairings` is empty this collapses to the original behavior
  // (every room has repeats=0 → pure load-balancing).
  for (const uid of ordered) {
    let best: AssignmentRoom | null = null;
    let bestRepeats = Infinity;
    let bestLoad = Infinity;
    for (const r of rooms) {
      const used = load.get(r.id)!;
      if (used >= r.capacity) continue;
      let repeats = 0;
      if (priorPairings.size > 0) {
        const here = occupants.get(r.id)!;
        for (const o of here) {
          if (priorPairings.has(pairKey(uid, o))) repeats++;
        }
      }
      // Lexicographic compare: (repeats, used, -capacity, id).
      let better: boolean;
      if (best === null) {
        better = true;
      } else if (repeats !== bestRepeats) {
        better = repeats < bestRepeats;
      } else if (used !== bestLoad) {
        better = used < bestLoad;
      } else if (r.capacity !== best.capacity) {
        better = r.capacity > best.capacity;
      } else {
        better = r.id < best.id;
      }
      if (better) {
        best = r;
        bestRepeats = repeats;
        bestLoad = used;
      }
    }
    if (best === null) {
      unplaced.push(uid);
    } else {
      roomAssignments.push({ user_id: uid, room_id: best.id });
      load.set(best.id, load.get(best.id)! + 1);
      occupants.get(best.id)!.push(uid);
    }
  }

  return {
    room_assignments: roomAssignments
      .map((a) => ({ slot_id: 0, user_id: a.user_id, room_id: a.room_id }))
      .sort((a, b) => a.user_id - b.user_id),
    unplaced_users: unplaced.sort((a, b) => a - b),
  };
}
