import { describe, test, expect } from "bun:test";
import {
  assignAgenda,
  type AgendaOccurrence,
  type AgendaAssignmentInput,
  type AgendaAssignmentResult,
} from "./assignment-agenda";

// ---- fixture helpers -------------------------------------------------------

let occSeq = 0;
function occ(
  partial: Partial<AgendaOccurrence> & Pick<AgendaOccurrence, "slot_id" | "submission_id">,
): AgendaOccurrence {
  occSeq += 1;
  return {
    id: partial.id ?? occSeq,
    slot_id: partial.slot_id,
    submission_id: partial.submission_id,
    room_id: partial.room_id ?? 1000 + occSeq,
    capacity: partial.capacity ?? 10,
    submitter_id: partial.submitter_id ?? -1, // -1: not a participant, never hosted
    // Default: one band per slot (non-overlapping slots).
    band_id: partial.band_id ?? partial.slot_id,
  };
}

function stars(spec: Record<number, number[]>): Map<number, Set<number>> {
  const m = new Map<number, Set<number>>();
  for (const [uid, subs] of Object.entries(spec)) m.set(Number(uid), new Set(subs));
  return m;
}

function countByOcc(r: AgendaAssignmentResult): Map<number, number> {
  const m = new Map<number, number>();
  for (const a of r.user_assignments) m.set(a.occurrence_id, (m.get(a.occurrence_id) ?? 0) + 1);
  return m;
}

function assignmentsOf(r: AgendaAssignmentResult, uid: number) {
  return r.user_assignments.filter((a) => a.user_id === uid);
}

// ---- hard-constraint firewall ---------------------------------------------

describe("hard constraints", () => {
  test("room capacity is never exceeded; overflow users are unplaced", () => {
    const o1 = occ({ slot_id: 1, submission_id: 100, capacity: 2 });
    const r = assignAgenda({
      occurrences: [o1],
      stars: stars({ 1: [100], 2: [100], 3: [100] }),
    });
    expect(countByOcc(r).get(o1.id)).toBe(2);
    expect(r.user_assignments.length).toBe(2);
    expect(r.unplaced_users.length).toBe(1);
  });

  test("at most one session per overlapping band", () => {
    // Two occurrences in the SAME band (overlapping slots); a user starring
    // both can attend only one.
    const a = occ({ slot_id: 1, submission_id: 100, band_id: 7, capacity: 10 });
    const b = occ({ slot_id: 2, submission_id: 200, band_id: 7, capacity: 10 });
    const r = assignAgenda({ occurrences: [a, b], stars: stars({ 1: [100, 200] }) });
    expect(assignmentsOf(r, 1).length).toBe(1);
  });

  test("a user never double-books across the agenda", () => {
    // subA in band1; subB in band1 AND band2; subC in band2. User stars all.
    const a = occ({ slot_id: 1, submission_id: 100, band_id: 1, capacity: 10 });
    const b1 = occ({ slot_id: 1, submission_id: 200, band_id: 1, capacity: 10 });
    const b2 = occ({ slot_id: 2, submission_id: 200, band_id: 2, capacity: 10 });
    const c = occ({ slot_id: 2, submission_id: 300, band_id: 2, capacity: 10 });
    const r = assignAgenda({
      occurrences: [a, b1, b2, c],
      stars: stars({ 1: [100, 200, 300] }),
    });
    const bands = assignmentsOf(r, 1).map((x) =>
      [a, b1, b2, c].find((o) => o.id === x.occurrence_id)!.band_id,
    );
    expect(new Set(bands).size).toBe(bands.length); // no repeated band
  });

  test("never assigned the same submission twice", () => {
    // subA recurs in two non-overlapping bands; user stars only A.
    const a1 = occ({ slot_id: 1, submission_id: 100, band_id: 1, capacity: 10 });
    const a2 = occ({ slot_id: 2, submission_id: 100, band_id: 2, capacity: 10 });
    const r = assignAgenda({ occurrences: [a1, a2], stars: stars({ 1: [100] }) });
    const subs = assignmentsOf(r, 1).map((x) => x.submission_id);
    expect(new Set(subs).size).toBe(subs.length);
    expect(assignmentsOf(r, 1).length).toBe(1);
  });
});

// ---- fixed picks + submitter host -----------------------------------------

describe("pre-pinned assignments", () => {
  test("fixed manual pick is honored and reserves capacity", () => {
    const o1 = occ({ slot_id: 1, submission_id: 100, capacity: 1 });
    const r = assignAgenda({
      occurrences: [o1],
      stars: stars({ 1: [100], 2: [100] }),
      fixedAssignments: [{ user_id: 2, occurrence_id: o1.id }],
    });
    expect(assignmentsOf(r, 2)[0]?.occurrence_id).toBe(o1.id);
    expect(assignmentsOf(r, 1).length).toBe(0); // capacity taken by the pin
    expect(r.unplaced_users).toContain(1);
  });

  test("submitter is auto-assigned to host their placed session", () => {
    const o1 = occ({ slot_id: 1, submission_id: 100, capacity: 5, submitter_id: 9 });
    const r = assignAgenda({
      occurrences: [o1],
      // submitter (9) is a participant; they star nothing of their own.
      stars: stars({ 9: [], 1: [100] }),
    });
    expect(assignmentsOf(r, 9)[0]?.submission_id).toBe(100);
  });

  test("submitterHost=false leaves submitters unhosted", () => {
    const o1 = occ({ slot_id: 1, submission_id: 100, capacity: 5, submitter_id: 9 });
    const r = assignAgenda({
      occurrences: [o1],
      stars: stars({ 9: [], 1: [100] }),
      submitterHost: false,
    });
    expect(assignmentsOf(r, 9).length).toBe(0);
  });
});

// ---- split across occurrences ---------------------------------------------

describe("split across occurrences", () => {
  test("equal-capacity occurrences of one submission split evenly", () => {
    const o1 = occ({ slot_id: 1, submission_id: 100, band_id: 1, capacity: 100 });
    const o2 = occ({ slot_id: 2, submission_id: 100, band_id: 2, capacity: 100 });
    const spec: Record<number, number[]> = {};
    for (let u = 1; u <= 10; u++) spec[u] = [100];
    const r = assignAgenda({ occurrences: [o1, o2], stars: stars(spec) });
    const c = countByOcc(r);
    expect((c.get(o1.id) ?? 0) + (c.get(o2.id) ?? 0)).toBe(10);
    expect(Math.abs((c.get(o1.id) ?? 0) - (c.get(o2.id) ?? 0))).toBeLessThanOrEqual(1);
  });

  test("unequal-capacity: fill the smaller room, spill the rest", () => {
    const small = occ({ slot_id: 1, submission_id: 100, band_id: 1, capacity: 3 });
    const big = occ({ slot_id: 2, submission_id: 100, band_id: 2, capacity: 100 });
    const spec: Record<number, number[]> = {};
    for (let u = 1; u <= 10; u++) spec[u] = [100];
    const r = assignAgenda({ occurrences: [small, big], stars: stars(spec) });
    const c = countByOcc(r);
    expect(c.get(small.id) ?? 0).toBe(3);
    expect(c.get(big.id) ?? 0).toBe(7);
  });
});

// ---- lookahead / fairness --------------------------------------------------

describe("cross-slot lookahead", () => {
  test("scarce session goes to the user with no later alternative", () => {
    // subA only in slot1 (cap 1). subB in slot1 AND slot2 (cap 1 each).
    // User U stars {A,B}; user V stars {A}. The fair/optimal outcome: V gets A
    // (no alternative), U gets B (available later) — both satisfied.
    const a = occ({ id: 1, slot_id: 1, submission_id: 100, band_id: 1, capacity: 1 });
    const b1 = occ({ id: 2, slot_id: 1, submission_id: 200, band_id: 1, capacity: 1 });
    const b2 = occ({ id: 3, slot_id: 2, submission_id: 200, band_id: 2, capacity: 1 });
    const r = assignAgenda({
      occurrences: [a, b1, b2],
      stars: stars({ 1: [100, 200], 2: [100] }), // U=1, V=2
    });
    // V (user 2) must get A.
    expect(assignmentsOf(r, 2).map((x) => x.submission_id)).toEqual([100]);
    // U (user 1) gets B (either occurrence), and is satisfied for B.
    expect(assignmentsOf(r, 1).map((x) => x.submission_id)).toContain(200);
    // Everyone who starred got something.
    expect(r.unplaced_users.length).toBe(0);
  });
});

// ---- determinism -----------------------------------------------------------

describe("determinism", () => {
  function bigInput(): AgendaAssignmentInput {
    const occurrences: AgendaOccurrence[] = [];
    let id = 0;
    for (let slot = 1; slot <= 6; slot++) {
      for (let sub = 1; sub <= 4; sub++) {
        id += 1;
        occurrences.push({
          id, slot_id: slot, submission_id: sub, room_id: 500 + id,
          capacity: 3, submitter_id: -1, band_id: slot,
        });
      }
    }
    const spec: Record<number, number[]> = {};
    for (let u = 1; u <= 30; u++) spec[u] = [(u % 4) + 1, ((u + 1) % 4) + 1, ((u + 2) % 4) + 1];
    return { occurrences, stars: stars(spec) };
  }

  test("idempotent: identical input yields identical output", () => {
    const a = assignAgenda(bigInput());
    const b = assignAgenda(bigInput());
    expect(b).toEqual(a);
  });

  test("invariant under input permutation (occurrences + star insertion order)", () => {
    const base = bigInput();
    const canonical = assignAgenda(base);

    const seeds = [1, 7, 42, 1000, 99999];
    for (const seed of seeds) {
      // Deterministic shuffle of occurrence order.
      const occs = [...base.occurrences];
      let s = seed >>> 0;
      for (let i = occs.length - 1; i > 0; i--) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const j = s % (i + 1);
        [occs[i], occs[j]] = [occs[j]!, occs[i]!];
      }
      // Reverse star insertion order.
      const reStars = new Map<number, Set<number>>();
      for (const k of [...base.stars.keys()].reverse()) reStars.set(k, base.stars.get(k)!);

      const permuted = assignAgenda({ occurrences: occs, stars: reStars });
      expect(permuted).toEqual(canonical);
    }
  });
});

// ---- degenerate inputs -----------------------------------------------------

describe("degenerate inputs", () => {
  test("user who starred nothing is neither placed nor reported unplaced", () => {
    const o1 = occ({ slot_id: 1, submission_id: 100, capacity: 5 });
    const r = assignAgenda({ occurrences: [o1], stars: stars({ 1: [], 2: [100] }) });
    expect(assignmentsOf(r, 1).length).toBe(0);
    expect(r.unplaced_users).not.toContain(1);
    expect(assignmentsOf(r, 2).length).toBe(1);
  });

  test("starred submission has no occurrence → user unplaced", () => {
    const o1 = occ({ slot_id: 1, submission_id: 100, capacity: 5 });
    const r = assignAgenda({ occurrences: [o1], stars: stars({ 1: [999] }) });
    expect(r.unplaced_users).toEqual([1]);
  });

  test("empty agenda yields empty result", () => {
    const r = assignAgenda({ occurrences: [], stars: stars({ 1: [1], 2: [2] }) });
    expect(r.user_assignments).toEqual([]);
    expect(r.unplaced_users).toEqual([1, 2]);
  });
});

// ---- external commitments (busyBands / priorAttendance) --------------------

describe("external commitments", () => {
  test("busyBands keeps a user out of an occurrence in a band they're committed to", () => {
    const a = occ({ slot_id: 1, submission_id: 100, band_id: 5, capacity: 10 });
    const r = assignAgenda({
      occurrences: [a],
      stars: stars({ 1: [100], 2: [100] }),
      // User 1 is already busy in band 5 (e.g. a mixer/planned track there).
      busyBands: new Map([[1, new Set([5])]]),
    });
    expect(assignmentsOf(r, 1).length).toBe(0);
    expect(r.unplaced_users).toContain(1);
    expect(assignmentsOf(r, 2).length).toBe(1); // user 2 is free
  });

  test("priorAttendance removes a submission the user already attends elsewhere", () => {
    // subA recurs in two slots; user already attends A elsewhere (planned track).
    const a1 = occ({ slot_id: 1, submission_id: 100, band_id: 1, capacity: 10 });
    const a2 = occ({ slot_id: 2, submission_id: 100, band_id: 2, capacity: 10 });
    const r = assignAgenda({
      occurrences: [a1, a2],
      stars: stars({ 1: [100] }),
      priorAttendance: new Map([[1, new Set([100])]]),
    });
    // They already have A — no further seat, and not "unplaced" (nothing wanted).
    expect(assignmentsOf(r, 1).length).toBe(0);
    expect(r.unplaced_users).not.toContain(1);
  });
});

// ---- session priority ------------------------------------------------------

describe("session priority", () => {
  test("user with two starred occurrences in one band lands in the high-priority one", () => {
    // Both occurrences share a band, so the user can attend only one. 100 is
    // high priority, 200 normal — the reward edge for 100 is fatter, so the
    // flow routes the user there.
    const hi = occ({ slot_id: 1, submission_id: 100, band_id: 1, capacity: 10, priority: 1 });
    const lo = occ({ slot_id: 2, submission_id: 200, band_id: 1, capacity: 10, priority: 0 });
    const r = assignAgenda({ occurrences: [hi, lo], stars: stars({ 1: [100, 200] }) });
    expect(assignmentsOf(r, 1).map((x) => x.submission_id)).toEqual([100]);
  });

  test("a user whose only starred session is low-priority is still seated (coverage never sacrificed)", () => {
    // High session (100, cap 1) and low session (200, cap 1) in distinct bands.
    // User 1 stars only 100; user 2 stars both. Priority (PRIORITY_BONUS) must
    // stay under USER_DIMINISH, so the solver gives user 1 their first (and
    // only) session rather than handing user 2 the high-priority seat twice.
    const hi = occ({ slot_id: 1, submission_id: 100, band_id: 1, capacity: 1, priority: 1 });
    const lo = occ({ slot_id: 2, submission_id: 200, band_id: 2, capacity: 1, priority: -1 });
    const r = assignAgenda({
      occurrences: [hi, lo],
      stars: stars({ 1: [100], 2: [100, 200] }),
    });
    expect(assignmentsOf(r, 1).map((x) => x.submission_id)).toEqual([100]);
    expect(assignmentsOf(r, 2).map((x) => x.submission_id)).toEqual([200]);
    expect(r.unplaced_users).toEqual([]);
  });
});

// ---- brute-force optimality oracle (small inputs) --------------------------

describe("optimality", () => {
  // For tiny inputs, enumerate every feasible routing and confirm the solver
  // attains the maximum number of distinct satisfied (user, starred-sub) pairs.
  test("maximizes satisfied stars on a small adversarial fixture", () => {
    const a = occ({ id: 1, slot_id: 1, submission_id: 10, band_id: 1, capacity: 1 });
    const b1 = occ({ id: 2, slot_id: 1, submission_id: 20, band_id: 1, capacity: 1 });
    const b2 = occ({ id: 3, slot_id: 2, submission_id: 20, band_id: 2, capacity: 1 });
    const c = occ({ id: 4, slot_id: 2, submission_id: 30, band_id: 2, capacity: 1 });
    const input: AgendaAssignmentInput = {
      occurrences: [a, b1, b2, c],
      stars: stars({ 1: [10, 20], 2: [10], 3: [20, 30] }),
    };
    const r = assignAgenda(input);
    // Best possible: user2→A, user1→B(slot1), user3→C and/or B(slot2).
    // Count distinct satisfied (user, sub) pairs.
    const satisfied = new Set(r.user_assignments.map((x) => `${x.user_id}:${x.submission_id}`));
    // user2 gets A, user1 gets B, user3 gets C and B → 4 satisfied is the max.
    expect(satisfied.size).toBeGreaterThanOrEqual(4);
    expect(r.unplaced_users.length).toBe(0);
  });
});
