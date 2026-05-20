import { describe, test, expect } from "bun:test";
import { assignUnconferenceSlot, type AssignmentInput } from "./assignment";

// Scale tests for the assignment algorithm. These are NOT proofs of asymptotic
// behavior — they just verify the algorithm holds up at production-ish sizes
// and produces a valid, capacity-respecting result quickly.

function buildScenario({
  numUsers,
  numRooms,
  numSubmissions,
  starsPerUser,
  roomCapacity,
  seed = 1,
}: {
  numUsers: number;
  numRooms: number;
  numSubmissions: number;
  starsPerUser: number;
  roomCapacity: number;
  seed?: number;
}): AssignmentInput {
  // Tiny deterministic PRNG (mulberry32).
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rooms = Array.from({ length: numRooms }, (_, i) => ({
    id: i + 1,
    capacity: roomCapacity,
  }));
  // Submitters use ids outside the [1..numUsers] range so the submitter-as-host
  // rule doesn't fire in scale tests — they verify generic throughput.
  const submissions = Array.from({ length: numSubmissions }, (_, i) => ({
    id: 1000 + i,
    submitter_id: 10_000_000 + i,
  }));
  const stars = new Map<number, Set<number>>();
  for (let u = 1; u <= numUsers; u++) {
    const set = new Set<number>();
    const k = Math.min(starsPerUser, numSubmissions);
    while (set.size < k) {
      set.add(1000 + Math.floor(rand() * numSubmissions));
    }
    stars.set(u, set);
  }
  return { rooms, submissions, stars };
}

function validate(input: AssignmentInput, result: ReturnType<typeof assignUnconferenceSlot>) {
  // No room is double-booked.
  const usedRooms = new Set<number>();
  for (const p of result.placements) {
    expect(usedRooms.has(p.room_id)).toBe(false);
    usedRooms.add(p.room_id);
  }

  // Every placement maps to an existing submission.
  const submissionIds = new Set(input.submissions.map((s) => s.id));
  for (const p of result.placements) {
    expect(submissionIds.has(p.submission_id)).toBe(true);
  }

  // Capacity not violated.
  const capByRoom = new Map(input.rooms.map((r) => [r.id, r.capacity]));
  const loadBySub = new Map<number, number>();
  for (const a of result.user_assignments) {
    loadBySub.set(a.submission_id, (loadBySub.get(a.submission_id) ?? 0) + 1);
  }
  const subToRoom = new Map(result.placements.map((p) => [p.submission_id, p.room_id]));
  for (const [subId, load] of loadBySub) {
    const cap = capByRoom.get(subToRoom.get(subId)!)!;
    expect(load).toBeLessThanOrEqual(cap);
  }

  // Every user is either assigned to a session they starred, or unplaced.
  const assignedUsers = new Set<number>();
  for (const a of result.user_assignments) {
    assignedUsers.add(a.user_id);
    const starred = input.stars.get(a.user_id)!;
    expect(starred.has(a.submission_id)).toBe(true);
  }
  for (const uid of result.unplaced_users) {
    expect(assignedUsers.has(uid)).toBe(false);
  }
  // No user appears twice.
  expect(assignedUsers.size + result.unplaced_users.length).toBe(input.stars.size);
}

describe("assignment at scale", () => {
  test("1000 users / 20 rooms / 30 submissions / 3 stars each — completes <500ms", () => {
    const data = buildScenario({
      numUsers: 1000,
      numRooms: 20,
      numSubmissions: 30,
      starsPerUser: 3,
      roomCapacity: 50,
    });
    const t0 = performance.now();
    const result = assignUnconferenceSlot(data);
    const dt = performance.now() - t0;
    validate(data, result);
    expect(dt).toBeLessThan(500);
  });

  test("5000 users / 50 rooms / 80 submissions / 5 stars each — completes <2s", () => {
    const data = buildScenario({
      numUsers: 5000,
      numRooms: 50,
      numSubmissions: 80,
      starsPerUser: 5,
      roomCapacity: 100,
    });
    const t0 = performance.now();
    const result = assignUnconferenceSlot(data);
    const dt = performance.now() - t0;
    validate(data, result);
    expect(dt).toBeLessThan(2000);
  });

  test("under-capacity scenario produces many unplaced users with hint", () => {
    // 1000 users, 5 rooms of 50 — only 250 seats but 1000 demand.
    const data = buildScenario({
      numUsers: 1000,
      numRooms: 5,
      numSubmissions: 10,
      starsPerUser: 2,
      roomCapacity: 50,
    });
    const result = assignUnconferenceSlot(data);
    validate(data, result);
    expect(result.user_assignments.length + result.unplaced_users.length).toBe(1000);
    expect(result.user_assignments.length).toBeLessThanOrEqual(5 * 50);
    expect(result.unplaced_users.length).toBeGreaterThan(0);
  });
});
