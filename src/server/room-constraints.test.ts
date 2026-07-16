// Tests for room expert-dedication + availability windows.
//   - Pure `roomAvailableFor` unit tests.
//   - Integration: every assignment path skips dedicated / unavailable rooms;
//     manual paths surface `room_expert_dedicated` / `room_unavailable`
//     conflicts; expert bookings respect availability; mutual exclusion blocks
//     dedicating a slot-used room; availability edits can't strand usage; and
//     the RoomOut flags (availability / expert_dedicated / slot_used) are right.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  setupTestApp, Client, type TestApp,
  inviteAndClaim,
} from "./test-helpers";
import { roomAvailableFor } from "./lib/room-constraints";

// Future base (whole-minute) so expert bookings never trip the past guard.
const FUTURE = Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 60_000) * 60_000;
const HOUR = 60 * 60_000;

let ctx: TestApp;

async function freshConf(prefix: string) {
  const owner = new Client(ctx.app);
  await owner.rpc.auth.signup({ email: `${prefix}-o@e.com`, password: "secret123", name: "Owner" });
  const conf = await owner.rpc.conferences.create({ name: `Conf ${prefix}` });
  return { owner, slug: conf.slug };
}

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

describe("roomAvailableFor", () => {
  const win = (s: number, e: number) => ({ startsAt: new Date(s), endsAt: new Date(e) });

  test("no windows = always available", () => {
    expect(roomAvailableFor([], new Date(0), new Date(HOUR))).toBe(true);
  });

  test("interval fully inside a single window is available", () => {
    expect(roomAvailableFor([win(0, 3 * HOUR)], new Date(HOUR), new Date(2 * HOUR))).toBe(true);
  });

  test("interval touching window bounds is available (inclusive)", () => {
    expect(roomAvailableFor([win(HOUR, 2 * HOUR)], new Date(HOUR), new Date(2 * HOUR))).toBe(true);
  });

  test("interval spanning a gap between two windows is unavailable", () => {
    const windows = [win(0, HOUR), win(2 * HOUR, 3 * HOUR)];
    expect(roomAvailableFor(windows, new Date(30 * 60_000), new Date(2 * HOUR + 30 * 60_000))).toBe(false);
  });

  test("interval outside every window is unavailable", () => {
    expect(roomAvailableFor([win(0, HOUR)], new Date(5 * HOUR), new Date(6 * HOUR))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

describe("room constraints: expert dedication", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  // Make a big room dedicated via a pool; a smaller room stays assignable. The
  // lone published session must land in the small room — proving the bigger,
  // dedicated room was excluded (it would win on capacity otherwise).
  test("unconference assignment skips a pool-dedicated room", async () => {
    const { owner, slug } = await freshConf("ded-pool");
    const big = await owner.rpc.rooms.create({ slug, name: "Big", capacity: 50 });
    const small = await owner.rpc.rooms.create({ slug, name: "Small", capacity: 10 });
    await owner.rpc.experts.createPool({ slug, name: "Mentors", room_ids: [big.id] });
    const sub = await owner.rpc.submissions.create({ slug, title: "Talk" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.assign({ slug, slot_id: slot.id });
    if (r.kind !== "unconference") throw new Error("expected unconference");
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]!.room_id).toBe(small.id);
  });

  test("unconference assignment skips a per-expert-room dedicated room", async () => {
    const { owner, slug } = await freshConf("ded-expert");
    const big = await owner.rpc.rooms.create({ slug, name: "Big", capacity: 50 });
    const small = await owner.rpc.rooms.create({ slug, name: "Small", capacity: 10 });
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "e@e.com");
    await owner.rpc.experts.promote({ slug, identity_id, room_ids: [big.id] });
    const sub = await owner.rpc.submissions.create({ slug, title: "Talk" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.assign({ slug, slot_id: slot.id });
    if (r.kind !== "unconference") throw new Error("expected unconference");
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]!.room_id).toBe(small.id);
  });

  test("mixer assignment never seats anyone in a dedicated room", async () => {
    const { owner, slug } = await freshConf("ded-mixer");
    const big = await owner.rpc.rooms.create({ slug, name: "Big", capacity: 50 });
    const small = await owner.rpc.rooms.create({ slug, name: "Small", capacity: 50 });
    await owner.rpc.experts.createPool({ slug, name: "Mentors", room_ids: [big.id] });
    for (let i = 0; i < 3; i++) await inviteAndClaim(ctx.app, owner, slug, `m${i}@e.com`);
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "mixer", title: "M", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.assign({ slug, slot_id: slot.id });
    if (r.kind !== "mixer") throw new Error("expected mixer");
    expect(r.room_assignments.length).toBeGreaterThan(0);
    for (const a of r.room_assignments) expect(a.room_id).toBe(small.id);
  });

  test("setTrack into a dedicated room returns room_expert_dedicated with pool name", async () => {
    const { owner, slug } = await freshConf("ded-settrack");
    const ded = await owner.rpc.rooms.create({ slug, name: "Mentor Room", capacity: 20 });
    await owner.rpc.experts.createPool({ slug, name: "Mentors", room_ids: [ded.id] });
    const sub = await owner.rpc.submissions.create({ slug, title: "Talk" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.setTrack({ slug, slot_id: slot.id, room_id: ded.id, submission_id: sub.id });
    if (r.kind !== "conflict") throw new Error("expected conflict");
    if (r.reason !== "room_expert_dedicated") throw new Error("expected room_expert_dedicated");
    expect(r.room.id).toBe(ded.id);
    expect(r.pool_name).toBe("Mentors");
  });

  test("placeSubmission into a dedicated (per-expert) room returns room_expert_dedicated with null pool", async () => {
    const { owner, slug } = await freshConf("ded-place");
    const ded = await owner.rpc.rooms.create({ slug, name: "Mentor Room", capacity: 20 });
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "e@e.com");
    await owner.rpc.experts.promote({ slug, identity_id, room_ids: [ded.id] });
    const sub = await owner.rpc.submissions.create({ slug, title: "Talk" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.placeSubmission({ slug, slot_id: slot.id, submission_id: sub.id, room_id: ded.id });
    if (r.kind !== "conflict") throw new Error("expected conflict");
    if (r.reason !== "room_expert_dedicated") throw new Error("expected room_expert_dedicated");
    expect(r.room.id).toBe(ded.id);
    expect(r.pool_name).toBeNull();
  });

  test("scheduleSubmission with a pin that later became dedicated conflicts", async () => {
    const { owner, slug } = await freshConf("ded-schedpin");
    const pinRoom = await owner.rpc.rooms.create({ slug, name: "Pin", capacity: 20 });
    await owner.rpc.rooms.create({ slug, name: "Other", capacity: 30 });
    const sub = await owner.rpc.submissions.create({ slug, title: "Talk", pre_assigned_room_id: pinRoom.id });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    // Dedicate the pin room AFTER the pin was set (a pin isn't slot usage).
    await owner.rpc.experts.createPool({ slug, name: "Mentors", room_ids: [pinRoom.id] });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.scheduleSubmission({ slug, slot_id: slot.id, submission_id: sub.id });
    if (r.kind !== "conflict") throw new Error("expected conflict");
    if (r.reason !== "room_expert_dedicated") throw new Error("expected room_expert_dedicated");
    expect(r.room.id).toBe(pinRoom.id);
  });

  test("refitRooms with a pin that became dedicated aborts with a conflict, no writes", async () => {
    const { owner, slug } = await freshConf("ded-refit");
    const pinRoom = await owner.rpc.rooms.create({ slug, name: "Pin", capacity: 20 });
    const other = await owner.rpc.rooms.create({ slug, name: "Other", capacity: 30 });
    const sub = await owner.rpc.submissions.create({ slug, title: "Talk", pre_assigned_room_id: pinRoom.id });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    // Track lives in `other`; the pin points at `pinRoom`. Dedicate `pinRoom`.
    await owner.rpc.agenda.setTrack({ slug, slot_id: slot.id, room_id: other.id, submission_id: sub.id });
    await owner.rpc.experts.createPool({ slug, name: "Mentors", room_ids: [pinRoom.id] });
    const r = await owner.rpc.agenda.refitRooms({ slug, slot_id: slot.id });
    if (r.kind !== "conflict") throw new Error("expected conflict");
    if (r.reason !== "room_expert_dedicated") throw new Error("expected room_expert_dedicated");
    expect(r.submission!.id).toBe(sub.id);
    const tracks = await ctx.prisma.trackAssignment.findMany({ where: { slotId: slot.id } });
    expect(tracks[0]!.roomId).toBe(other.id);
  });

  test("pinning a submission onto a dedicated room is rejected on create and update", async () => {
    const { owner, slug } = await freshConf("ded-pinwrite");
    const ded = await owner.rpc.rooms.create({ slug, name: "Mentor", capacity: 20 });
    const plain = await owner.rpc.rooms.create({ slug, name: "Plain", capacity: 20 });
    await owner.rpc.experts.createPool({ slug, name: "Mentors", room_ids: [ded.id] });
    // create
    await expect(
      owner.rpc.submissions.create({ slug, title: "T", pre_assigned_room_id: ded.id }),
    ).rejects.toThrow("room_expert_dedicated");
    // update
    const sub = await owner.rpc.submissions.create({ slug, title: "T2", pre_assigned_room_id: plain.id });
    await expect(
      owner.rpc.submissions.update({ slug, id: sub.id, pre_assigned_room_id: ded.id }),
    ).rejects.toThrow("room_expert_dedicated");
  });
});

describe("room constraints: availability windows", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("a room with no windows is always assignable", async () => {
    const { owner, slug } = await freshConf("avail-none");
    const room = await owner.rpc.rooms.create({ slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug, title: "T" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.assign({ slug, slot_id: slot.id });
    if (r.kind !== "unconference") throw new Error("expected unconference");
    expect(r.placements[0]!.room_id).toBe(room.id);
  });

  test("a slot fully inside a window is assignable; spanning a gap is excluded", async () => {
    const { owner, slug } = await freshConf("avail-window");
    // Windowed room with a gap between FUTURE+1h and FUTURE+2h.
    const windowed = await owner.rpc.rooms.create({
      slug, name: "Windowed", capacity: 50,
      availability: [
        { starts_at: FUTURE, ends_at: FUTURE + HOUR },
        { starts_at: FUTURE + 2 * HOUR, ends_at: FUTURE + 3 * HOUR },
      ],
    });
    const sub = await owner.rpc.submissions.create({ slug, title: "T" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });

    // Inside the first window → placed in the windowed room.
    const insideSlot = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "In",
      starts_at: FUTURE + 10 * 60_000, ends_at: FUTURE + 50 * 60_000,
    });
    const inside = await owner.rpc.agenda.assign({ slug, slot_id: insideSlot.id });
    if (inside.kind !== "unconference") throw new Error("expected unconference");
    expect(inside.placements[0]!.room_id).toBe(windowed.id);

    // Spanning the gap → the only room is excluded → no placements.
    const spanSlot = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "Span",
      starts_at: FUTURE + 30 * 60_000, ends_at: FUTURE + 2 * HOUR + 30 * 60_000,
    });
    const span = await owner.rpc.agenda.assign({ slug, slot_id: spanSlot.id });
    if (span.kind !== "unconference") throw new Error("expected unconference");
    expect(span.placements).toHaveLength(0);
  });

  test("setTrack into a room unavailable for the slot returns room_unavailable with the windows", async () => {
    const { owner, slug } = await freshConf("avail-settrack");
    const room = await owner.rpc.rooms.create({
      slug, name: "R", capacity: 20,
      availability: [{ starts_at: FUTURE, ends_at: FUTURE + HOUR }],
    });
    const sub = await owner.rpc.submissions.create({ slug, title: "T" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    // Slot lies entirely after the room's only window.
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N",
      starts_at: FUTURE + 5 * HOUR, ends_at: FUTURE + 6 * HOUR,
    });
    const r = await owner.rpc.agenda.setTrack({ slug, slot_id: slot.id, room_id: room.id, submission_id: sub.id });
    if (r.kind !== "conflict") throw new Error("expected conflict");
    if (r.reason !== "room_unavailable") throw new Error("expected room_unavailable");
    expect(r.room.id).toBe(room.id);
    expect(r.availability).toEqual([{ starts_at: FUTURE, ends_at: FUTURE + HOUR }]);
  });
});

describe("room constraints: expert bookings respect availability", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("booking lands only in a room whose window contains the slot; a no-window room is unaffected", async () => {
    const { owner, slug } = await freshConf("book-avail");
    // Room A is only available in the second hour; the booking slot is at
    // FUTURE+0..15m, so A is unavailable. Room B has no windows → usable.
    const roomA = await owner.rpc.rooms.create({
      slug, name: "A", capacity: 5,
      availability: [{ starts_at: FUTURE + HOUR, ends_at: FUTURE + 2 * HOUR }],
    });
    const roomB = await owner.rpc.rooms.create({ slug, name: "B", capacity: 5 });
    const pool = await owner.rpc.experts.createPool({ slug, name: "P", room_ids: [roomA.id, roomB.id] });
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "expert@e.com");
    const expert = await owner.rpc.experts.promote({ slug, identity_id, pool_id: pool.id });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: expert.id, starts_at: FUTURE, ends_at: FUTURE + 30 * 60_000, slot_duration_minutes: 15,
    });
    const { client: booker } = await inviteAndClaim(ctx.app, owner, slug, "booker@e.com");
    const booked = await booker.rpc.experts.book({ slug, expert_id: expert.id, starts_at: FUTURE });
    // A is unavailable for FUTURE..+15m; must land in B.
    expect(booked.room_id).toBe(roomB.id);
  });

  test("no_room_available when every candidate room is unavailable for the slot", async () => {
    const { owner, slug } = await freshConf("book-none");
    const roomA = await owner.rpc.rooms.create({
      slug, name: "A", capacity: 5,
      availability: [{ starts_at: FUTURE + HOUR, ends_at: FUTURE + 2 * HOUR }],
    });
    const pool = await owner.rpc.experts.createPool({ slug, name: "P", room_ids: [roomA.id] });
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "expert@e.com");
    const expert = await owner.rpc.experts.promote({ slug, identity_id, pool_id: pool.id });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: expert.id, starts_at: FUTURE, ends_at: FUTURE + 15 * 60_000, slot_duration_minutes: 15,
    });
    const { client: booker } = await inviteAndClaim(ctx.app, owner, slug, "booker@e.com");
    await expect(
      booker.rpc.experts.book({ slug, expert_id: expert.id, starts_at: FUTURE }),
    ).rejects.toThrow("no_room_available");
  });
});

describe("room constraints: mutual exclusion (dedicate a slot-used room)", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  async function slotUsedRoom(owner: Client, slug: string, name: string) {
    const room = await owner.rpc.rooms.create({ slug, name, capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug, title: `${name} talk` });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.setTrack({ slug, slot_id: slot.id, room_id: room.id, submission_id: sub.id });
    return room;
  }

  async function expectRoomsInUse(p: Promise<unknown>, roomId: number) {
    try {
      await p;
      throw new Error("expected rooms_in_use rejection");
    } catch (e) {
      const err = e as { message?: string; data?: { rooms?: { id: number; usage: { kind: string } }[] } };
      expect(err.message).toBe("rooms_in_use");
      const offender = err.data?.rooms?.find((r) => r.id === roomId);
      expect(offender).toBeDefined();
      expect(offender!.usage.kind).toBe("planned");
    }
  }

  test("createPool with a slot-used room is rejected with rooms_in_use", async () => {
    const { owner, slug } = await freshConf("mx-pool");
    const room = await slotUsedRoom(owner, slug, "Used");
    await expectRoomsInUse(owner.rpc.experts.createPool({ slug, name: "P", room_ids: [room.id] }), room.id);
  });

  test("promote with a slot-used room is rejected with rooms_in_use", async () => {
    const { owner, slug } = await freshConf("mx-promote");
    const room = await slotUsedRoom(owner, slug, "Used");
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "e@e.com");
    await expectRoomsInUse(owner.rpc.experts.promote({ slug, identity_id, room_ids: [room.id] }), room.id);
  });

  test("updateExpert adding a slot-used room is rejected with rooms_in_use", async () => {
    const { owner, slug } = await freshConf("mx-update");
    const room = await slotUsedRoom(owner, slug, "Used");
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "e@e.com");
    const expert = await owner.rpc.experts.promote({ slug, identity_id });
    await expectRoomsInUse(owner.rpc.experts.update({ slug, id: expert.id, room_ids: [room.id] }), room.id);
  });

  test("dedicating a clean (unused) room succeeds", async () => {
    const { owner, slug } = await freshConf("mx-clean");
    const clean = await owner.rpc.rooms.create({ slug, name: "Clean", capacity: 20 });
    const pool = await owner.rpc.experts.createPool({ slug, name: "P", room_ids: [clean.id] });
    expect(pool.room_ids).toEqual([clean.id]);
  });
});

describe("room constraints: availability edits can't strand usage", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  async function expectStrands(p: Promise<unknown>, kind: string) {
    try {
      await p;
      throw new Error("expected availability_strands_usage rejection");
    } catch (e) {
      const err = e as { message?: string; data?: { offenders?: { kind: string }[] } };
      expect(err.message).toBe("availability_strands_usage");
      expect(err.data?.offenders?.some((o) => o.kind === kind)).toBe(true);
    }
  }

  test("shrinking availability that strands a planned track is blocked", async () => {
    const { owner, slug } = await freshConf("strand-track");
    const room = await owner.rpc.rooms.create({ slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug, title: "T" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.setTrack({ slug, slot_id: slot.id, room_id: room.id, submission_id: sub.id });
    // New window is entirely after the track's slot → strands it.
    await expectStrands(
      owner.rpc.rooms.update({
        slug, id: room.id,
        availability: [{ starts_at: FUTURE + 5 * HOUR, ends_at: FUTURE + 6 * HOUR }],
      }),
      "planned",
    );
  });

  test("shrinking availability that strands an unconference placement is blocked", async () => {
    const { owner, slug } = await freshConf("strand-place");
    const room = await owner.rpc.rooms.create({ slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug, title: "T" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.placeSubmission({ slug, slot_id: slot.id, submission_id: sub.id, room_id: room.id });
    await expectStrands(
      owner.rpc.rooms.update({
        slug, id: room.id,
        availability: [{ starts_at: FUTURE + 5 * HOUR, ends_at: FUTURE + 6 * HOUR }],
      }),
      "unconference",
    );
  });

  test("shrinking availability that strands an expert booking is blocked", async () => {
    const { owner, slug } = await freshConf("strand-book");
    const room = await owner.rpc.rooms.create({ slug, name: "R", capacity: 5 });
    const pool = await owner.rpc.experts.createPool({ slug, name: "P", room_ids: [room.id] });
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "expert@e.com");
    const expert = await owner.rpc.experts.promote({ slug, identity_id, pool_id: pool.id });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: expert.id, starts_at: FUTURE, ends_at: FUTURE + 15 * 60_000, slot_duration_minutes: 15,
    });
    const { client: booker } = await inviteAndClaim(ctx.app, owner, slug, "booker@e.com");
    await booker.rpc.experts.book({ slug, expert_id: expert.id, starts_at: FUTURE });
    await expectStrands(
      owner.rpc.rooms.update({
        slug, id: room.id,
        availability: [{ starts_at: FUTURE + 5 * HOUR, ends_at: FUTURE + 6 * HOUR }],
      }),
      "expert_booking",
    );
  });

  test("a non-stranding edit and a clear-to-empty both succeed", async () => {
    const { owner, slug } = await freshConf("strand-ok");
    const room = await owner.rpc.rooms.create({ slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug, title: "T" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.setTrack({ slug, slot_id: slot.id, room_id: room.id, submission_id: sub.id });
    // A window that still contains the track's slot → allowed.
    await owner.rpc.rooms.update({
      slug, id: room.id,
      availability: [{ starts_at: FUTURE - HOUR, ends_at: FUTURE + 2 * HOUR }],
    });
    // Clearing to always-available never strands.
    await owner.rpc.rooms.update({ slug, id: room.id, availability: [] });
    const rooms = await owner.rpc.rooms.listAll({ slug });
    expect(rooms.find((r) => r.id === room.id)!.availability).toEqual([]);
  });
});

describe("room constraints: RoomOut flags", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("availability, expert_dedicated, and slot_used reflect reality", async () => {
    const { owner, slug } = await freshConf("roomout");
    // Plain room: no flags.
    const plain = await owner.rpc.rooms.create({ slug, name: "Plain", capacity: 20 });
    // Dedicated room via pool.
    const dedicated = await owner.rpc.rooms.create({ slug, name: "Dedicated", capacity: 20 });
    await owner.rpc.experts.createPool({ slug, name: "P", room_ids: [dedicated.id] });
    // Windowed + slot-used room.
    const used = await owner.rpc.rooms.create({
      slug, name: "Used", capacity: 20,
      availability: [{ starts_at: FUTURE, ends_at: FUTURE + 4 * HOUR }],
    });
    const sub = await owner.rpc.submissions.create({ slug, title: "T" });
    await owner.rpc.submissions.publish({ slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.setTrack({ slug, slot_id: slot.id, room_id: used.id, submission_id: sub.id });

    const rooms = await owner.rpc.rooms.listAll({ slug });
    const byId = new Map(rooms.map((r) => [r.id, r]));
    expect(byId.get(plain.id)).toMatchObject({ availability: [], expert_dedicated: false, slot_used: false });
    expect(byId.get(dedicated.id)).toMatchObject({ expert_dedicated: true, slot_used: false });
    expect(byId.get(used.id)).toMatchObject({
      expert_dedicated: false, slot_used: true,
      availability: [{ starts_at: FUTURE, ends_at: FUTURE + 4 * HOUR }],
    });
  });
});
