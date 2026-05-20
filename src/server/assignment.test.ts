import { describe, test, expect } from "bun:test";
import {
  assignUnconferenceSlot, assignMixerSlot, pairKey,
  type AssignmentInput, type AssignmentSubmission, type MixerInput,
} from "./assignment";

// Most existing tests don't care about the submitter-as-host rule, so default
// each submission's submitter to a synthetic id that's not in the stars map.
// Tests that care about that rule pass `submitter_id` explicitly.
function withSubmitters(subs: { id: number; submitter_id?: number }[]): AssignmentSubmission[] {
  return subs.map((s) => ({ id: s.id, submitter_id: s.submitter_id ?? 9999 }));
}

function input(parts: {
  rooms?: AssignmentInput["rooms"];
  submissions?: { id: number; submitter_id?: number }[];
  stars?: AssignmentInput["stars"];
  priorAssignments?: AssignmentInput["priorAssignments"];
  avoidRepeats?: boolean;
  fixedAssignments?: AssignmentInput["fixedAssignments"];
}): AssignmentInput {
  return {
    rooms: parts.rooms ?? [],
    submissions: withSubmitters(parts.submissions ?? []),
    stars: parts.stars ?? new Map(),
    priorAssignments: parts.priorAssignments,
    avoidRepeats: parts.avoidRepeats,
    fixedAssignments: parts.fixedAssignments,
  };
}

describe("assignUnconferenceSlot — placements", () => {
  test("places most-starred submission in largest room", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }, { id: 2, capacity: 50 }],
      submissions: [{ id: 100 }, { id: 200 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100])],
        [3, new Set([100])],
        [4, new Set([200])],
      ]),
    }));

    const placeFor = (sid: number) =>
      result.placements.find((p) => p.submission_id === sid)?.room_id;
    expect(placeFor(100)).toBe(2); // big room
    expect(placeFor(200)).toBe(1); // small room
  });

  test("drops least-starred submissions when rooms < submissions", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }, { id: 200 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100])],
        [3, new Set([200])],
      ]),
    }));

    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]!.submission_id).toBe(100);
  });

  test("places all submissions when rooms >= submissions", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 5 }, { id: 2, capacity: 5 }, { id: 3, capacity: 5 }],
      submissions: [{ id: 100 }, { id: 200 }],
      stars: new Map(),
    }));

    expect(result.placements).toHaveLength(2);
  });

  test("ties on stars broken by submission id ascending (stable)", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 100 }, { id: 2, capacity: 10 }],
      submissions: [{ id: 200 }, { id: 100 }],
      stars: new Map([[1, new Set([100, 200])]]),
    }));

    // both have 1 star — submission 100 wins, gets the bigger room.
    const placeFor = (sid: number) =>
      result.placements.find((p) => p.submission_id === sid)?.room_id;
    expect(placeFor(100)).toBe(1);
    expect(placeFor(200)).toBe(2);
  });
});

describe("assignUnconferenceSlot — user assignments", () => {
  test("each user with one starred placed submission ends up there", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 5 }, { id: 2, capacity: 5 }],
      submissions: [{ id: 100 }, { id: 200 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([200])],
      ]),
    }));

    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(100);
    expect(findAssign(2)).toBe(200);
    expect(result.unplaced_users).toEqual([]);
  });

  test("falls back to other starred session when first is full", () => {
    // Room capacities of 1 each — only one user per session.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 1 }, { id: 2, capacity: 1 }],
      submissions: [{ id: 100 }, { id: 200 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100, 200])],
      ]),
    }));

    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    // User 1 is more constrained (1 candidate) — assigned first to 100.
    // User 2 then falls back to 200.
    expect(findAssign(1)).toBe(100);
    expect(findAssign(2)).toBe(200);
    expect(result.unplaced_users).toEqual([]);
  });

  test("flags user as unplaced when all starred sessions full", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 1 }],
      submissions: [{ id: 100 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100])],
      ]),
    }));

    expect(result.user_assignments).toHaveLength(1);
    expect(result.unplaced_users).toEqual([2]);
  });

  test("flags user as unplaced when they starred nothing", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set()],
      ]),
    }));

    expect(result.unplaced_users).toEqual([2]);
  });

  test("flags user as unplaced when their starred submission didn't get a room", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }, { id: 200 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100])],
        [3, new Set([200])], // 200 won't be placed — only 1 room.
      ]),
    }));

    expect(result.placements.find((p) => p.submission_id === 200)).toBeUndefined();
    expect(result.unplaced_users).toContain(3);
  });

  test("balances load across two equally-starred sessions", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 100 }, { id: 2, capacity: 100 }],
      submissions: [{ id: 100 }, { id: 200 }],
      // 10 users, each starred both — should split 5/5.
      stars: new Map(
        Array.from({ length: 10 }, (_, i) => [i + 1, new Set([100, 200])] as const),
      ),
    }));

    const counts = new Map<number, number>();
    for (const a of result.user_assignments) {
      counts.set(a.submission_id, (counts.get(a.submission_id) ?? 0) + 1);
    }
    expect(counts.get(100)).toBe(5);
    expect(counts.get(200)).toBe(5);
    expect(result.unplaced_users).toEqual([]);
  });

  test("respects capacity strictly", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 3 }, { id: 2, capacity: 3 }],
      submissions: [{ id: 100 }, { id: 200 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100])],
        [3, new Set([100])],
        [4, new Set([100])], // 4th starrer of 100, room full → spillover, no fallback
        [5, new Set([200])],
      ]),
    }));

    const counts = new Map<number, number>();
    for (const a of result.user_assignments) {
      counts.set(a.submission_id, (counts.get(a.submission_id) ?? 0) + 1);
    }
    // 100 had 4 starrers, capacity 3 — one spills.
    // That user only starred 100, so they end up unplaced.
    expect(counts.get(100)).toBeLessThanOrEqual(3);
    expect(result.unplaced_users).toHaveLength(1);
  });

  test("deterministic across calls (same input → same output)", () => {
    const data: AssignmentInput = input({
      rooms: [{ id: 1, capacity: 2 }, { id: 2, capacity: 2 }, { id: 3, capacity: 2 }],
      submissions: [{ id: 100 }, { id: 200 }, { id: 300 }],
      stars: new Map([
        [1, new Set([100, 200])],
        [2, new Set([100, 300])],
        [3, new Set([200, 300])],
        [4, new Set([100, 200, 300])],
      ]),
    });
    const r1 = assignUnconferenceSlot(data);
    const r2 = assignUnconferenceSlot(data);
    expect(r2).toEqual(r1);
  });
});

describe("assignUnconferenceSlot — degenerate inputs", () => {
  test("no rooms → no placements, all users unplaced", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [],
      submissions: [{ id: 100 }],
      stars: new Map([[1, new Set([100])]]),
    }));
    expect(result.placements).toEqual([]);
    expect(result.unplaced_users).toEqual([1]);
  });

  test("no submissions → no placements, all users unplaced", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [],
      stars: new Map([[1, new Set()]]),
    }));
    expect(result.placements).toEqual([]);
    expect(result.unplaced_users).toEqual([1]);
  });

  test("no users → only placements, empty assignments", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }],
      stars: new Map(),
    }));
    expect(result.placements).toHaveLength(1);
    expect(result.user_assignments).toEqual([]);
    expect(result.unplaced_users).toEqual([]);
  });
});

describe("assignUnconferenceSlot — submitter-as-host rule", () => {
  test("submitter is assigned to their own placed session even if they didn't star it", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 1 }],
      stars: new Map([
        [1, new Set()],         // submitter starred nothing
        [2, new Set([100])],
      ]),
    }));
    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(100);
    expect(findAssign(2)).toBe(100);
    expect(result.unplaced_users).toEqual([]);
  });

  test("submitter's own session wins over the other session they starred", () => {
    // User 1 submits 100 but stars 200. Both placed. User 1 must lead 100.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }, { id: 2, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 1 }, { id: 200, submitter_id: 2 }],
      stars: new Map([
        [1, new Set([200])],
        [2, new Set([100, 200])],
      ]),
    }));
    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(100);
    expect(findAssign(2)).toBe(200); // submitter of 200
  });

  test("submitter's stars are honored when their submission isn't placed", () => {
    // Only one room — user 1's submission 100 has fewer stars and gets dropped.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 1 }, { id: 200, submitter_id: 9 }],
      stars: new Map([
        [1, new Set([100, 200])],   // also starred 200
        [2, new Set([200])],
        [3, new Set([200])],
      ]),
    }));
    // 200 is placed (more stars). 100 is dropped.
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]!.submission_id).toBe(200);
    // User 1 should fall back to their other star.
    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(200);
  });

  test("one user submitting two placed sessions leads the most-starred one", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }, { id: 2, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 1 }, { id: 200, submitter_id: 1 }],
      stars: new Map([
        [1, new Set()],
        [2, new Set([200])],      // only 200 has an external starrer
        [3, new Set([200])],
      ]),
    }));
    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(200); // most starred of their own
  });
});

describe("assignUnconferenceSlot — avoid-repeats rule", () => {
  test("filters out previously-attended submissions from the candidate set", () => {
    // User 2 has starred 100 and 200 but already attended 100. Should be sent
    // to 200; user 1 also wants 100 so gets it.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }, { id: 2, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 9 }, { id: 200, submitter_id: 8 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100, 200])],
      ]),
      priorAssignments: new Map([
        [2, new Set([100])],
      ]),
    }));
    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(100);
    expect(findAssign(2)).toBe(200);
  });

  test("user with no remaining candidates after filter ends up unplaced", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 9 }],
      stars: new Map([[1, new Set([100])]]),
      priorAssignments: new Map([[1, new Set([100])]]),
    }));
    expect(result.user_assignments).toEqual([]);
    expect(result.unplaced_users).toEqual([1]);
  });

  test("submitter rule overrides avoid-repeats — submitters still lead their own session", () => {
    // User 1 submitted 100, already attended 100. Still assigned to 100.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 1 }],
      stars: new Map([[1, new Set()]]),
      priorAssignments: new Map([[1, new Set([100])]]),
    }));
    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(100);
  });

  test("avoidRepeats=false ignores priorAssignments entirely", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 9 }],
      stars: new Map([[1, new Set([100])]]),
      priorAssignments: new Map([[1, new Set([100])]]),
      avoidRepeats: false,
    }));
    expect(result.user_assignments[0]?.submission_id).toBe(100);
    expect(result.unplaced_users).toEqual([]);
  });
});

describe("assignUnconferenceSlot — fixed (manual) assignments", () => {
  test("honors a manual pick even if the user starred something else", () => {
    // User 1 starred 100, but manually picked 200. Both are placed.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }, { id: 2, capacity: 10 }],
      submissions: [{ id: 100 }, { id: 200 }],
      stars: new Map([[1, new Set([100])]]),
      fixedAssignments: new Map([[1, 200]]),
    }));
    expect(result.user_assignments).toEqual([
      { slot_id: 0, user_id: 1, submission_id: 200 },
    ]);
  });

  test("manual pick reserves capacity — other users see the seat taken", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 1 }],
      submissions: [{ id: 100 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100])],
      ]),
      fixedAssignments: new Map([[2, 100]]),
    }));
    // User 2 takes the only seat manually; user 1 spills.
    expect(result.user_assignments).toEqual([
      { slot_id: 0, user_id: 2, submission_id: 100 },
    ]);
    expect(result.unplaced_users).toEqual([1]);
  });

  test("manual pick at a not-placed submission is silently dropped", () => {
    // Only 100 has a room; user 1 manually picked 200 which isn't placed.
    // The manual entry is ignored and the user falls back to the normal flow.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }, { id: 200 }],
      stars: new Map([[1, new Set([100])]]),
      fixedAssignments: new Map([[1, 200]]),
    }));
    // Falls back to their star at 100.
    expect(result.user_assignments).toEqual([
      { slot_id: 0, user_id: 1, submission_id: 100 },
    ]);
  });

  test("manual pick that would overflow capacity is dropped (last id loses)", () => {
    // Two manual picks for a room of size 1. Lower id wins.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 1 }],
      submissions: [{ id: 100 }],
      stars: new Map([
        [1, new Set()],
        [2, new Set()],
      ]),
      fixedAssignments: new Map([[1, 100], [2, 100]]),
    }));
    expect(result.user_assignments).toEqual([
      { slot_id: 0, user_id: 1, submission_id: 100 },
    ]);
    // User 2's dropped manual entry leaves them unplaced (no stars → no fallback).
    expect(result.unplaced_users).toEqual([2]);
  });

  test("manual pick overrides the submitter-as-host rule", () => {
    // User 1 submitted 100 (would normally host it); but manually picked 200.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }, { id: 2, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 1 }, { id: 200, submitter_id: 9 }],
      stars: new Map([
        [1, new Set()],
        [2, new Set([100])],
      ]),
      fixedAssignments: new Map([[1, 200]]),
    }));
    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(200); // manual pick wins
    expect(findAssign(2)).toBe(100); // someone else takes 100
  });

  test("manual pick overrides avoid-repeats", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }],
      stars: new Map([[1, new Set()]]),
      priorAssignments: new Map([[1, new Set([100])]]),
      avoidRepeats: true,
      fixedAssignments: new Map([[1, 100]]),
    }));
    expect(result.user_assignments).toEqual([
      { slot_id: 0, user_id: 1, submission_id: 100 },
    ]);
  });

  test("non-member manual picks ignored (not in stars map)", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 5 }],
      submissions: [{ id: 100 }],
      stars: new Map([[1, new Set([100])]]),
      // user 99 isn't a conference member.
      fixedAssignments: new Map([[99, 100]]),
    }));
    expect(result.user_assignments).toEqual([
      { slot_id: 0, user_id: 1, submission_id: 100 },
    ]);
  });
});

describe("assignMixerSlot", () => {
  test("evenly distributes attendees across rooms of equal capacity", () => {
    const result = assignMixerSlot({
      rooms: [{ id: 1, capacity: 10 }, { id: 2, capacity: 10 }],
      userIds: [1, 2, 3, 4],
    });
    const counts = new Map<number, number>();
    for (const a of result.room_assignments) {
      counts.set(a.room_id, (counts.get(a.room_id) ?? 0) + 1);
    }
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(2);
    expect(result.unplaced_users).toEqual([]);
  });

  test("respects per-room capacity strictly; overflow ends up unplaced", () => {
    // 5 users, 4 seats — exactly one user spills regardless of shuffle order.
    // We don't pin which user it is (depends on the shuffle); the invariant
    // tested here is the count, not the identity.
    const result = assignMixerSlot({
      rooms: [{ id: 1, capacity: 2 }, { id: 2, capacity: 2 }],
      userIds: [1, 2, 3, 4, 5],
    });
    expect(result.room_assignments).toHaveLength(4);
    expect(result.unplaced_users).toHaveLength(1);
  });

  test("no rooms → everyone unplaced", () => {
    const result = assignMixerSlot({ rooms: [], userIds: [1, 2] });
    expect(result.room_assignments).toEqual([]);
    expect(result.unplaced_users).toEqual([1, 2]);
  });

  test("deterministic across calls", () => {
    const inp: MixerInput = {
      rooms: [{ id: 1, capacity: 3 }, { id: 2, capacity: 3 }, { id: 3, capacity: 3 }],
      userIds: [10, 20, 30, 40, 50, 60],
    };
    expect(assignMixerSlot(inp)).toEqual(assignMixerSlot(inp));
  });
});

// ---------------------------------------------------------------------------
// Output shape contracts — these belong with `assignUnconferenceSlot` but are
// tested as their own group because they apply across many code paths.

describe("assignUnconferenceSlot — output shape", () => {
  test("placements sorted by submission_id ascending", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }, { id: 2, capacity: 10 }, { id: 3, capacity: 10 }],
      submissions: [{ id: 300 }, { id: 100 }, { id: 200 }],
      stars: new Map(),
    }));
    expect(result.placements.map((p) => p.submission_id)).toEqual([100, 200, 300]);
  });

  test("user_assignments sorted by user_id ascending", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }],
      stars: new Map([
        [42, new Set([100])],
        [7, new Set([100])],
        [13, new Set([100])],
      ]),
    }));
    expect(result.user_assignments.map((a) => a.user_id)).toEqual([7, 13, 42]);
  });

  test("unplaced_users sorted by user_id ascending", () => {
    // Capacity 1 — only one of three starrers fits. User 7 is processed first
    // (id-asc, since all three have the same candidate count), gets the seat;
    // users 13 and 42 spill into unplaced, returned in id-asc order.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 1 }],
      submissions: [{ id: 100 }],
      stars: new Map([
        [42, new Set([100])],
        [7, new Set([100])],
        [13, new Set([100])],
      ]),
    }));
    expect(result.unplaced_users).toEqual([13, 42]);
  });

  test("slot_id is left at 0 — callers patch in their own", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }],
      stars: new Map([[1, new Set([100])]]),
    }));
    expect(result.placements.every((p) => p.slot_id === 0)).toBe(true);
    expect(result.user_assignments.every((a) => a.slot_id === 0)).toBe(true);
  });

  test("no user appears twice across user_assignments + unplaced_users", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 1 }, { id: 2, capacity: 1 }],
      submissions: [{ id: 100 }, { id: 200 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100, 200])],
        [3, new Set([100])],
      ]),
    }));
    const seen = new Set<number>();
    for (const a of result.user_assignments) {
      expect(seen.has(a.user_id)).toBe(false);
      seen.add(a.user_id);
    }
    for (const uid of result.unplaced_users) {
      expect(seen.has(uid)).toBe(false);
      seen.add(uid);
    }
    expect(seen.size).toBe(3);
  });
});

describe("assignUnconferenceSlot — capacity edge cases", () => {
  test("capacity 0 places the submission but no users go there", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 0 }],
      submissions: [{ id: 100 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100])],
      ]),
    }));
    // Submission still gets the room (placement is independent of capacity).
    expect(result.placements).toHaveLength(1);
    // But nobody fits.
    expect(result.user_assignments).toEqual([]);
    expect(result.unplaced_users).toEqual([1, 2]);
  });

  test("submitter rule respects capacity 0 — submitter falls through to general loop", () => {
    // Submitter of 100 (room cap 0) is in `stars` with another star at 200.
    // Their own session can't fit them; they should land at 200 instead.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 0 }, { id: 2, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 1 }, { id: 200, submitter_id: 9 }],
      stars: new Map([
        [1, new Set([200])],
      ]),
    }));
    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(200);
  });

  test("ties on capacity broken by room id ascending", () => {
    // Two rooms of capacity 10, two submissions with identical stars.
    // Stable sort puts smaller-id room with smaller-id submission.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 5, capacity: 10 }, { id: 2, capacity: 10 }],
      submissions: [{ id: 200 }, { id: 100 }],
      stars: new Map([[1, new Set([100, 200])]]),
    }));
    const placeFor = (sid: number) =>
      result.placements.find((p) => p.submission_id === sid)?.room_id;
    // Equal stars → submission 100 ranks first (id asc) and gets room 2 (id asc).
    expect(placeFor(100)).toBe(2);
    expect(placeFor(200)).toBe(5);
  });

  test("more rooms than submissions — extra rooms are unused", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 5 }, { id: 2, capacity: 5 }, { id: 3, capacity: 5 }],
      submissions: [{ id: 100 }],
      stars: new Map([[1, new Set([100])]]),
    }));
    expect(result.placements).toHaveLength(1);
    const usedRoomIds = new Set(result.placements.map((p) => p.room_id));
    expect(usedRoomIds.size).toBe(1);
  });
});

describe("assignUnconferenceSlot — submitter rule edge cases", () => {
  test("submitter not in conference (no stars entry) — rule doesn't fire", () => {
    // submitter_id 99 is NOT in the stars map (not a conference member);
    // their session is placed and assigned per the regular star algorithm.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 99 }],
      stars: new Map([
        [1, new Set([100])],
      ]),
    }));
    expect(result.user_assignments).toEqual([
      { slot_id: 0, user_id: 1, submission_id: 100 },
    ]);
    // 99 was never a participant, so they're not in unplaced either.
    expect(result.unplaced_users).toEqual([]);
  });

  test("two submitters' sessions both placed — each leads their own", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }, { id: 2, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 1 }, { id: 200, submitter_id: 2 }],
      stars: new Map([
        [1, new Set()],     // submitter 1 starred nothing
        [2, new Set()],     // submitter 2 starred nothing
        [3, new Set([100])],
        [4, new Set([200])],
      ]),
    }));
    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(100);
    expect(findAssign(2)).toBe(200);
  });

  test("submitter rule + avoidRepeats: submitter still leads even if they attended before", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 1 }],
      stars: new Map([[1, new Set([100])]]),
      priorAssignments: new Map([[1, new Set([100])]]),
      avoidRepeats: true,
    }));
    expect(result.user_assignments).toEqual([
      { slot_id: 0, user_id: 1, submission_id: 100 },
    ]);
  });

  test("submitter of dropped submission falls through to the normal flow", () => {
    // Only 1 room — submitter 1's submission has fewer stars and is dropped.
    // Submitter 1 doesn't star anything else, so they're unplaced.
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100, submitter_id: 1 }, { id: 200, submitter_id: 9 }],
      stars: new Map([
        [1, new Set()],
        [2, new Set([200])],
        [3, new Set([200])],
      ]),
    }));
    expect(result.placements.map((p) => p.submission_id)).toEqual([200]);
    expect(result.unplaced_users).toContain(1);
  });

  test("submitter with two placed sessions of equal popularity picks lower id", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }, { id: 2, capacity: 10 }],
      submissions: [{ id: 200, submitter_id: 1 }, { id: 100, submitter_id: 1 }],
      stars: new Map([
        [1, new Set()],
        [2, new Set([100, 200])],
      ]),
    }));
    // Both 100 and 200 have one external starrer each → identical popularity;
    // tiebreak by id ascending → submitter 1 leads 100.
    const findAssign = (u: number) =>
      result.user_assignments.find((a) => a.user_id === u)?.submission_id;
    expect(findAssign(1)).toBe(100);
  });
});

describe("assignUnconferenceSlot — avoid-repeats edge cases", () => {
  test("priorAssignments for submissions not in scope are ignored harmlessly", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }],
      stars: new Map([[1, new Set([100])]]),
      // 999 isn't placed and isn't even in the scope — should not break.
      priorAssignments: new Map([[1, new Set([999])]]),
    }));
    expect(result.user_assignments).toEqual([
      { slot_id: 0, user_id: 1, submission_id: 100 },
    ]);
  });

  test("no priorAssignments map → behaves like avoidRepeats has nothing to filter", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }],
      stars: new Map([[1, new Set([100])]]),
      // priorAssignments intentionally omitted.
    }));
    expect(result.user_assignments[0]?.submission_id).toBe(100);
  });

  test("avoidRepeats=true on user without a priorAssignments entry — unaffected", () => {
    const result = assignUnconferenceSlot(input({
      rooms: [{ id: 1, capacity: 10 }],
      submissions: [{ id: 100 }],
      stars: new Map([
        [1, new Set([100])],
        [2, new Set([100])],
      ]),
      priorAssignments: new Map([[2, new Set([100])]]), // only user 2 has priors
      avoidRepeats: true,
    }));
    // User 1 still goes to 100. User 2 is filtered out → unplaced.
    expect(result.user_assignments).toEqual([
      { slot_id: 0, user_id: 1, submission_id: 100 },
    ]);
    expect(result.unplaced_users).toEqual([2]);
  });
});

describe("assignMixerSlot — capacity and distribution", () => {
  test("distributes more attendees into the larger room", () => {
    // Three attendees split across rooms with very unequal capacities.
    const result = assignMixerSlot({
      rooms: [{ id: 1, capacity: 1 }, { id: 2, capacity: 5 }],
      userIds: [1, 2, 3],
    });
    const counts = new Map<number, number>();
    for (const a of result.room_assignments) {
      counts.set(a.room_id, (counts.get(a.room_id) ?? 0) + 1);
    }
    // Room 1 has capacity 1 so caps at 1. Room 2 gets the other two.
    expect(counts.get(1)).toBe(1);
    expect(counts.get(2)).toBe(2);
    expect(result.unplaced_users).toEqual([]);
  });

  test("capacity-0 rooms are skipped silently", () => {
    const result = assignMixerSlot({
      rooms: [{ id: 1, capacity: 0 }, { id: 2, capacity: 10 }],
      userIds: [1, 2, 3],
    });
    expect(result.room_assignments.every((a) => a.room_id === 2)).toBe(true);
    expect(result.unplaced_users).toEqual([]);
  });

  test("empty userIds → no assignments, no unplaced", () => {
    const result = assignMixerSlot({
      rooms: [{ id: 1, capacity: 10 }],
      userIds: [],
    });
    expect(result.room_assignments).toEqual([]);
    expect(result.unplaced_users).toEqual([]);
  });

  test("single room — fills to capacity, rest unplaced (specific users vary by shuffle)", () => {
    const result = assignMixerSlot({
      rooms: [{ id: 1, capacity: 2 }],
      userIds: [1, 2, 3, 4],
    });
    expect(result.room_assignments).toHaveLength(2);
    expect(result.unplaced_users).toHaveLength(2);
    // Together they cover every input user exactly once.
    const seen = new Set<number>([
      ...result.room_assignments.map((a) => a.user_id),
      ...result.unplaced_users,
    ]);
    expect(seen).toEqual(new Set([1, 2, 3, 4]));
  });

  test("output sorted by user_id ascending", () => {
    const result = assignMixerSlot({
      rooms: [{ id: 1, capacity: 10 }],
      userIds: [50, 10, 30, 20],
    });
    expect(result.room_assignments.map((a) => a.user_id)).toEqual([10, 20, 30, 50]);
  });

  test("equal capacity + load — tie-broken by smallest room id", () => {
    // Both rooms start empty (load 0) with capacity 10 → first attendee picks
    // the lower-id room. After that loads differ and the algorithm balances.
    const result = assignMixerSlot({
      rooms: [{ id: 5, capacity: 10 }, { id: 2, capacity: 10 }],
      userIds: [1],
    });
    expect(result.room_assignments[0]?.room_id).toBe(2);
  });

  test("slot_id is left at 0 — callers patch in their own", () => {
    const result = assignMixerSlot({
      rooms: [{ id: 1, capacity: 10 }],
      userIds: [1, 2],
    });
    expect(result.room_assignments.every((a) => a.slot_id === 0)).toBe(true);
  });

  test("no user appears twice across room_assignments + unplaced_users", () => {
    const result = assignMixerSlot({
      rooms: [{ id: 1, capacity: 1 }, { id: 2, capacity: 1 }],
      userIds: [1, 2, 3, 4],
    });
    const seen = new Set<number>();
    for (const a of result.room_assignments) {
      expect(seen.has(a.user_id)).toBe(false);
      seen.add(a.user_id);
    }
    for (const uid of result.unplaced_users) {
      expect(seen.has(uid)).toBe(false);
      seen.add(uid);
    }
    expect(seen.size).toBe(4);
  });

  test("input order does not affect output (sort by user_id is internal)", () => {
    const r1 = assignMixerSlot({
      rooms: [{ id: 1, capacity: 5 }, { id: 2, capacity: 5 }],
      userIds: [3, 1, 2],
    });
    const r2 = assignMixerSlot({
      rooms: [{ id: 2, capacity: 5 }, { id: 1, capacity: 5 }],
      userIds: [1, 2, 3],
    });
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// Scrambling: mixer must NOT trivially put user 1 in room 1 every time.
// Reruns with the same seed reproduce exactly; different seeds shuffle into
// different rooms.

describe("assignMixerSlot — deterministic scramble", () => {
  test("same seed + same input produces the same output", () => {
    const inp: MixerInput = {
      rooms: [{ id: 1, capacity: 5 }, { id: 2, capacity: 5 }, { id: 3, capacity: 5 }],
      userIds: [10, 20, 30, 40, 50, 60],
      seed: 42,
    };
    expect(assignMixerSlot(inp)).toEqual(assignMixerSlot(inp));
  });

  test("different seeds produce different room assignments for the same users", () => {
    const users = [1, 2, 3, 4, 5, 6, 7, 8];
    const rooms = [{ id: 1, capacity: 4 }, { id: 2, capacity: 4 }];

    // Collect the room of each user under a handful of seeds and verify that
    // *some* user changes rooms across seeds. We don't pin specific (user→room)
    // mappings to seeds — those are an implementation detail of the PRNG —
    // we just assert the algorithm doesn't collapse to one fixed layout.
    const mapping = (seed: number) => {
      const r = assignMixerSlot({ rooms, userIds: users, seed });
      const m = new Map<number, number>();
      for (const a of r.room_assignments) m.set(a.user_id, a.room_id);
      return m;
    };
    const seeds = [0, 1, 7, 13, 42, 99, 1000];
    const layouts = seeds.map(mapping);
    const distinct = new Set(layouts.map((m) => JSON.stringify([...m.entries()].sort())));
    // At least two different layouts among the seeds → scramble is doing work.
    expect(distinct.size).toBeGreaterThan(1);
  });

  test("user_id-asc is not the only layout — at least one seed breaks the trivial mapping", () => {
    // With identical rooms and 4 users into 2 rooms of capacity 2 each, the
    // pre-shuffle algorithm would deterministically pack {1,3}→room1, {2,4}→room2.
    // Across a range of seeds, at least one must yield a layout that differs.
    const rooms = [{ id: 1, capacity: 2 }, { id: 2, capacity: 2 }];
    const users = [1, 2, 3, 4];
    const trivialLayout = JSON.stringify([
      [1, 1], [2, 2], [3, 1], [4, 2],
    ]);
    let foundNonTrivial = false;
    for (let seed = 0; seed < 50 && !foundNonTrivial; seed++) {
      const r = assignMixerSlot({ rooms, userIds: users, seed });
      const layout = JSON.stringify(
        r.room_assignments
          .map((a) => [a.user_id, a.room_id] as [number, number])
          .sort((a, b) => a[0] - b[0]),
      );
      if (layout !== trivialLayout) foundNonTrivial = true;
    }
    expect(foundNonTrivial).toBe(true);
  });

  test("capacity invariants still hold under shuffling", () => {
    // Spot-check that scrambling doesn't accidentally double-book a room.
    const rooms = [{ id: 1, capacity: 3 }, { id: 2, capacity: 3 }, { id: 3, capacity: 3 }];
    const users = Array.from({ length: 9 }, (_, i) => i + 1);
    for (let seed = 0; seed < 10; seed++) {
      const r = assignMixerSlot({ rooms, userIds: users, seed });
      const counts = new Map<number, number>();
      for (const a of r.room_assignments) {
        counts.set(a.room_id, (counts.get(a.room_id) ?? 0) + 1);
      }
      for (const [, n] of counts) expect(n).toBeLessThanOrEqual(3);
      expect(r.room_assignments.length + r.unplaced_users.length).toBe(users.length);
    }
  });

  test("shuffle is stable across calls (mulberry32 is deterministic by seed)", () => {
    // Run the same input ten times — every output must be identical.
    const inp: MixerInput = {
      rooms: [{ id: 1, capacity: 4 }, { id: 2, capacity: 4 }],
      userIds: [1, 2, 3, 4, 5],
      seed: 123,
    };
    const first = assignMixerSlot(inp);
    for (let i = 0; i < 9; i++) {
      expect(assignMixerSlot(inp)).toEqual(first);
    }
  });

  test("output array stays sorted by user_id even though distribution is scrambled", () => {
    const r = assignMixerSlot({
      rooms: [{ id: 1, capacity: 5 }, { id: 2, capacity: 5 }],
      userIds: [50, 10, 30, 20, 40],
      seed: 17,
    });
    const ids = r.room_assignments.map((a) => a.user_id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// Exclusive-mix mode: `priorPairings` is the set of `pairKey(a, b)` entries
// for any two users who already shared a room in an earlier exclusive mixer.
// When supplied, the algorithm prefers rooms that minimize repeated pairings
// while still placing everyone capacity-permitting.

describe("assignMixerSlot — exclusive mix (priorPairings)", () => {
  // Helper: collect the resulting (pair → met?) set from a mixer result.
  function pairingsOf(result: ReturnType<typeof assignMixerSlot>): Set<string> {
    const byRoom = new Map<number, number[]>();
    for (const a of result.room_assignments) {
      const arr = byRoom.get(a.room_id) ?? [];
      arr.push(a.user_id);
      byRoom.set(a.room_id, arr);
    }
    const out = new Set<string>();
    for (const [, users] of byRoom) {
      for (let i = 0; i < users.length; i++) {
        for (let j = i + 1; j < users.length; j++) {
          out.add(pairKey(users[i]!, users[j]!));
        }
      }
    }
    return out;
  }

  test("with no priorPairings, behaves exactly like the original even-split", () => {
    const inp: MixerInput = {
      rooms: [{ id: 1, capacity: 5 }, { id: 2, capacity: 5 }],
      userIds: [1, 2, 3, 4],
      seed: 7,
    };
    const withEmpty = assignMixerSlot({ ...inp, priorPairings: new Set() });
    const without = assignMixerSlot(inp);
    expect(withEmpty).toEqual(without);
  });

  test("two consecutive exclusive mixers — no pair repeats when capacity allows it", () => {
    // 4 users, 2 rooms of capacity 2. A perfect anti-repeat layout exists.
    const rooms = [{ id: 1, capacity: 2 }, { id: 2, capacity: 2 }];
    const userIds = [1, 2, 3, 4];

    const mix1 = assignMixerSlot({ rooms, userIds, seed: 1 });
    const priors = pairingsOf(mix1);
    expect(priors.size).toBe(2); // each room of 2 contributes one pair

    const mix2 = assignMixerSlot({ rooms, userIds, seed: 2, priorPairings: priors });
    const next = pairingsOf(mix2);

    // No pair from mix1 should reappear in mix2.
    for (const p of next) expect(priors.has(p)).toBe(false);
  });

  test("when avoidance is impossible (capacity-bound), still places everyone", () => {
    // 4 users, single room of capacity 4 — everyone meets everyone, every run.
    // The second mixer must still place all 4 even though every choice repeats.
    const rooms = [{ id: 1, capacity: 4 }];
    const userIds = [1, 2, 3, 4];
    const mix1 = assignMixerSlot({ rooms, userIds, seed: 1 });
    const priors = pairingsOf(mix1);
    const mix2 = assignMixerSlot({ rooms, userIds, seed: 2, priorPairings: priors });
    expect(mix2.room_assignments).toHaveLength(4);
    expect(mix2.unplaced_users).toEqual([]);
  });

  test("two-mixer scenario: avoidance strictly beats fresh-shuffle on repeat count", () => {
    const rooms = [{ id: 1, capacity: 3 }, { id: 2, capacity: 3 }];
    const userIds = [1, 2, 3, 4, 5, 6];

    // Worst-case fresh: re-using the same seed in both mixers would repeat every pair.
    const m1 = assignMixerSlot({ rooms, userIds, seed: 1 });
    const m2Fresh = assignMixerSlot({ rooms, userIds, seed: 1 }); // fresh shuffle
    const freshRepeats = (() => {
      const p1 = pairingsOf(m1);
      let n = 0;
      for (const p of pairingsOf(m2Fresh)) if (p1.has(p)) n++;
      return n;
    })();

    const m2Excl = assignMixerSlot({
      rooms, userIds, seed: 1, priorPairings: pairingsOf(m1),
    });
    const exclRepeats = (() => {
      const p1 = pairingsOf(m1);
      let n = 0;
      for (const p of pairingsOf(m2Excl)) if (p1.has(p)) n++;
      return n;
    })();

    expect(exclRepeats).toBeLessThan(freshRepeats);
  });

  test("still respects capacity strictly when avoiding repeats", () => {
    const rooms = [{ id: 1, capacity: 2 }, { id: 2, capacity: 2 }];
    const userIds = [1, 2, 3, 4, 5];
    const priors = new Set([pairKey(1, 2), pairKey(3, 4)]);
    const r = assignMixerSlot({ rooms, userIds, seed: 0, priorPairings: priors });
    // Cap 2+2 = 4 seats, 5 users → exactly one unplaced.
    expect(r.room_assignments).toHaveLength(4);
    expect(r.unplaced_users).toHaveLength(1);
    // No room exceeds capacity.
    const counts = new Map<number, number>();
    for (const a of r.room_assignments) {
      counts.set(a.room_id, (counts.get(a.room_id) ?? 0) + 1);
    }
    for (const [, n] of counts) expect(n).toBeLessThanOrEqual(2);
  });

  test("deterministic with priorPairings (same seed + same priors → same output)", () => {
    const inp: MixerInput = {
      rooms: [{ id: 1, capacity: 3 }, { id: 2, capacity: 3 }, { id: 3, capacity: 3 }],
      userIds: [1, 2, 3, 4, 5, 6],
      seed: 42,
      priorPairings: new Set([pairKey(1, 2), pairKey(3, 4)]),
    };
    expect(assignMixerSlot(inp)).toEqual(assignMixerSlot(inp));
  });
});

describe("pairKey", () => {
  test("is order-independent and canonical (smaller id first)", () => {
    expect(pairKey(3, 7)).toBe("3:7");
    expect(pairKey(7, 3)).toBe("3:7");
  });
});
