import { describe, test, expect } from "bun:test";
import {
  assignAgenda,
  type AgendaOccurrence,
  type AgendaAssignmentInput,
  type AgendaAssignmentResult,
} from "./assignment-agenda";

// Deterministic PRNG (no Math.random — keeps fixtures reproducible).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Reused hard-constraint validator: capacity never exceeded, ≤1 session per
// user per band, no user assigned the same submission twice.
function validate(input: AgendaAssignmentInput, r: AgendaAssignmentResult): void {
  const capById = new Map<number, number>();
  const bandById = new Map<number, number>();
  const subById = new Map<number, number>();
  for (const o of input.occurrences) {
    capById.set(o.id, o.capacity);
    bandById.set(o.id, o.band_id);
    subById.set(o.id, o.submission_id);
  }
  const loadByOcc = new Map<number, number>();
  const bandsByUser = new Map<number, Set<number>>();
  const subsByUser = new Map<number, Set<number>>();
  for (const a of r.user_assignments) {
    loadByOcc.set(a.occurrence_id, (loadByOcc.get(a.occurrence_id) ?? 0) + 1);
    const band = bandById.get(a.occurrence_id)!;
    const ub = bandsByUser.get(a.user_id) ?? new Set<number>();
    expect(ub.has(band)).toBe(false); // ≤1 per band
    ub.add(band);
    bandsByUser.set(a.user_id, ub);
    const us = subsByUser.get(a.user_id) ?? new Set<number>();
    expect(us.has(a.submission_id)).toBe(false); // no duplicate submission
    us.add(a.submission_id);
    subsByUser.set(a.user_id, us);
    // The assignment's submission/room must match its occurrence.
    expect(subById.get(a.occurrence_id)).toBe(a.submission_id);
  }
  for (const [occ, load] of loadByOcc) expect(load).toBeLessThanOrEqual(capById.get(occ)!);
}

describe("scale", () => {
  test("500 users × 40 occurrences solves quickly and validly", () => {
    const rand = lcg(12345);
    const SLOTS = 10, SUBS_PER_SLOT = 4, USERS = 500;
    const occurrences: AgendaOccurrence[] = [];
    let id = 0;
    for (let slot = 1; slot <= SLOTS; slot++) {
      for (let k = 0; k < SUBS_PER_SLOT; k++) {
        id += 1;
        // submission ids 1..(SLOTS*SUBS_PER_SLOT); a handful recur by reusing
        // the same submission id across slots.
        const sub = ((id - 1) % 24) + 1; // 24 distinct subs → some recur
        occurrences.push({
          id, slot_id: slot, submission_id: sub, room_id: 1000 + id,
          capacity: 30, submitter_id: -1, band_id: slot,
        });
      }
    }
    const allSubs = [...new Set(occurrences.map((o) => o.submission_id))];
    const stars = new Map<number, Set<number>>();
    for (let u = 1; u <= USERS; u++) {
      const set = new Set<number>();
      const n = 3 + Math.floor(rand() * 3); // 3..5 stars
      for (let i = 0; i < n; i++) set.add(allSubs[Math.floor(rand() * allSubs.length)]!);
      stars.set(u, set);
    }

    const input: AgendaAssignmentInput = { occurrences, stars };
    const r = assignAgenda(input);
    validate(input, r);
    // Most users should land at least one starred session given ample capacity.
    expect(r.user_assignments.length).toBeGreaterThan(USERS);
  }, 30_000);

  test("dense stars (every user stars every submission) stays valid", () => {
    const SLOTS = 8, SUBS = 6, USERS = 120;
    const occurrences: AgendaOccurrence[] = [];
    let id = 0;
    for (let slot = 1; slot <= SLOTS; slot++) {
      for (let s = 1; s <= SUBS; s++) {
        id += 1;
        occurrences.push({
          id, slot_id: slot, submission_id: s, room_id: 2000 + id,
          capacity: 20, submitter_id: -1, band_id: slot,
        });
      }
    }
    const stars = new Map<number, Set<number>>();
    for (let u = 1; u <= USERS; u++) stars.set(u, new Set([1, 2, 3, 4, 5, 6]));
    const input: AgendaAssignmentInput = { occurrences, stars };
    const r = assignAgenda(input);
    validate(input, r);
  }, 15_000);
});
