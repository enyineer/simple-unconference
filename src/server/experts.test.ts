// Tests for the expert-booking feature: pools, experts, timeframes, bookings.
// Hits the full oRPC router against a real Prisma+SQLite. Identity model:
// owners are created via auth.signup; participants/moderators join the
// conference via the invite+claim helper (or self-signup link).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  setupTestApp, Client, ORPCError, type TestApp,
  inviteAndClaim,
} from "./test-helpers";
import { deriveSlots, pickAvailableRoom } from "./experts";

// Pick a time well in the future so the "slot in past" guard never fires.
const FUTURE_BASE = Date.now() + 7 * 24 * 60 * 60 * 1000;
function at(offsetMin: number): number {
  return FUTURE_BASE + offsetMin * 60_000;
}

// ---------------------------------------------------------------------------
// Pure-helper unit tests
// ---------------------------------------------------------------------------

describe("experts: pure helpers", () => {
  test("deriveSlots produces back-to-back windows that fit the timeframe", () => {
    const start = 1_000_000_000_000;
    const slots = deriveSlots(start, start + 60 * 60_000, 20);
    expect(slots.length).toBe(3);
    expect(slots[0]).toEqual({ startsAt: start, endsAt: start + 20 * 60_000 });
    expect(slots[2]).toEqual({
      startsAt: start + 40 * 60_000, endsAt: start + 60 * 60_000,
    });
  });

  test("deriveSlots drops the trailing partial slot", () => {
    const start = 0;
    const slots = deriveSlots(start, 50 * 60_000, 20);
    expect(slots.length).toBe(2); // 0-20, 20-40; 40-60 would overflow
  });

  test("pickAvailableRoom returns lowest-id free room", () => {
    const room = pickAvailableRoom(
      [3, 1, 2],
      [{ roomId: 1, startsAt: 0, endsAt: 100 }],
      { startsAt: 50, endsAt: 150 },
    );
    expect(room).toBe(2);
  });

  test("pickAvailableRoom returns null when all rooms are busy", () => {
    const room = pickAvailableRoom(
      [1, 2],
      [
        { roomId: 1, startsAt: 0, endsAt: 100 },
        { roomId: 2, startsAt: 0, endsAt: 100 },
      ],
      { startsAt: 0, endsAt: 100 },
    );
    expect(room).toBeNull();
  });

  test("pickAvailableRoom ignores non-overlapping bookings", () => {
    const room = pickAvailableRoom(
      [1, 2],
      [{ roomId: 1, startsAt: 0, endsAt: 100 }],
      { startsAt: 100, endsAt: 200 }, // touches but doesn't overlap
    );
    expect(room).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: pools + experts + bookings via the RPC router
// ---------------------------------------------------------------------------

describe("experts: end-to-end booking flow", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  async function freshConference() {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({
      email: `o${Math.random().toString(36).slice(2, 8)}@e.com`,
      password: "secret123", name: "Owner",
    });
    const conf = await owner.rpc.conferences.create({ name: `Conf ${Math.random()}` });
    return { owner, slug: conf.slug };
  }

  test("mod creates pool with rooms; non-mod can't manage pools", async () => {
    const { owner, slug } = await freshConference();
    const r1 = await owner.rpc.rooms.create({ slug, name: "A", capacity: 4 });
    const r2 = await owner.rpc.rooms.create({ slug, name: "B", capacity: 4 });

    const pool = await owner.rpc.experts.createPool({
      slug, name: "Quiet rooms", room_ids: [r1.id, r2.id],
    });
    expect(pool.room_ids.sort()).toEqual([r1.id, r2.id].sort());

    const list = await owner.rpc.experts.listPools({ slug });
    expect(list.length).toBe(1);
    expect(list[0]!.expert_count).toBe(0);

    // Non-mod can't list/manage pools.
    const { client: bob } = await inviteAndClaim(ctx.app, owner, slug, "bob@e.com");
    await expect(bob.rpc.experts.listPools({ slug })).rejects.toBeInstanceOf(ORPCError);
    await expect(bob.rpc.experts.createPool({ slug, name: "Hack" }))
      .rejects.toBeInstanceOf(ORPCError);
  });

  test("promote, timeframe, book, cancel: full happy path", async () => {
    const { owner, slug } = await freshConference();
    const room = await owner.rpc.rooms.create({ slug, name: "Office", capacity: 2 });
    const { identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, slug, "alice@e.com");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, slug, "bob@e.com");

    // Promote Alice with a specific room (no pool).
    const expert = await owner.rpc.experts.promote({
      slug, identity_id: aliceId, bio: "OCaml expert", room_ids: [room.id],
    });
    expect(expert.id).toBeGreaterThan(0);

    // Create a 30-min timeframe with 15-min slots → 2 slots.
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: expert.id,
      starts_at: at(60), ends_at: at(90), slot_duration_minutes: 15,
    });

    // Bob (participant) can see the expert + slots.
    const listed = await bob.rpc.experts.list({ slug });
    expect(listed.length).toBe(1);
    expect(listed[0]!.slots.length).toBe(2);
    // Email of expert is masked from non-mods.
    expect(listed[0]!.email).toBeNull();

    // Bob books the first slot.
    const booked = await bob.rpc.experts.book({
      slug, expert_id: expert.id, starts_at: at(60),
    });
    expect(booked.room_id).toBe(room.id);

    // Non-mod sees the slot as booked with masked booker.
    const after = await bob.rpc.experts.list({ slug });
    const slot0 = after[0]!.slots.find((s) => s.starts_at === at(60))!;
    expect(slot0.booking_id).toBe(booked.booking_id);
    expect(slot0.is_mine).toBe(true);
    // Bob is the booker, so he sees his own booking unmasked.
    expect(slot0.booker_email).toBe("bob@e.com");

    // A third party (Carol) sees the slot booked but cannot see who.
    const { client: carol } = await inviteAndClaim(ctx.app, owner, slug, "carol@e.com");
    const view = await carol.rpc.experts.list({ slug });
    const carolSlot = view[0]!.slots.find((s) => s.starts_at === at(60))!;
    expect(carolSlot.booking_id).toBe(booked.booking_id);
    expect(carolSlot.is_mine).toBe(false);
    expect(carolSlot.booker_email).toBeNull();
    expect(carolSlot.booker_name).toBeNull();

    // Bob cancels his own booking; the slot becomes free again.
    await bob.rpc.experts.cancelBooking({ slug, booking_id: booked.booking_id });
    const afterCancel = await bob.rpc.experts.list({ slug });
    expect(afterCancel[0]!.slots.find((s) => s.starts_at === at(60))!.booking_id).toBeNull();
  });

  test("limits: cannot book same expert twice; cannot book overlapping slots", async () => {
    const { owner, slug } = await freshConference();
    const r1 = await owner.rpc.rooms.create({ slug, name: "R1", capacity: 2 });
    const { identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, slug, "alice@e.com");
    const { identity_id: daveId } =
      await inviteAndClaim(ctx.app, owner, slug, "dave@e.com");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, slug, "bob@e.com");

    const ex1 = await owner.rpc.experts.promote({
      slug, identity_id: aliceId, room_ids: [r1.id],
    });
    const ex2 = await owner.rpc.experts.promote({
      slug, identity_id: daveId, room_ids: [r1.id],
    });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: ex1.id, starts_at: at(60), ends_at: at(90),
      slot_duration_minutes: 15,
    });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: ex2.id, starts_at: at(60), ends_at: at(90),
      slot_duration_minutes: 15,
    });

    await bob.rpc.experts.book({ slug, expert_id: ex1.id, starts_at: at(60) });

    // Re-booking the same expert is rejected.
    await expect(
      bob.rpc.experts.book({ slug, expert_id: ex1.id, starts_at: at(75) }),
    ).rejects.toBeInstanceOf(ORPCError);

    // Booking a different expert at an overlapping time is rejected.
    await expect(
      bob.rpc.experts.book({ slug, expert_id: ex2.id, starts_at: at(60) }),
    ).rejects.toBeInstanceOf(ORPCError);

    // A non-overlapping slot with the second expert is OK.
    await bob.rpc.experts.book({ slug, expert_id: ex2.id, starts_at: at(75) });
  });

  test("room allocation: per-expert rooms exhausted produces no_room_available", async () => {
    const { owner, slug } = await freshConference();
    const r1 = await owner.rpc.rooms.create({ slug, name: "OnlyRoom", capacity: 2 });
    const { identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, slug, "alice@e.com");
    const { identity_id: daveId } =
      await inviteAndClaim(ctx.app, owner, slug, "dave@e.com");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, slug, "bob@e.com");
    const { client: carol } =
      await inviteAndClaim(ctx.app, owner, slug, "carol@e.com");

    const ex1 = await owner.rpc.experts.promote({
      slug, identity_id: aliceId, room_ids: [r1.id],
    });
    const ex2 = await owner.rpc.experts.promote({
      slug, identity_id: daveId, room_ids: [r1.id],
    });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: ex1.id, starts_at: at(60), ends_at: at(90),
      slot_duration_minutes: 15,
    });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: ex2.id, starts_at: at(60), ends_at: at(90),
      slot_duration_minutes: 15,
    });

    // Bob takes the only room at slot 60 with expert1.
    await bob.rpc.experts.book({ slug, expert_id: ex1.id, starts_at: at(60) });
    // Carol tries the SAME time with expert2 — room is busy.
    await expect(
      carol.rpc.experts.book({ slug, expert_id: ex2.id, starts_at: at(60) }),
    ).rejects.toMatchObject({ message: "no_room_available" });
  });

  test("mod can cancel any booking; experts and bookers can cancel; bystanders can't", async () => {
    const { owner, slug } = await freshConference();
    const r1 = await owner.rpc.rooms.create({ slug, name: "R", capacity: 2 });
    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, slug, "alice@e.com");
    const { client: bob, identity_id: _bobId } =
      await inviteAndClaim(ctx.app, owner, slug, "bob@e.com");
    void _bobId;
    const { client: carol } =
      await inviteAndClaim(ctx.app, owner, slug, "carol@e.com");
    const ex = await owner.rpc.experts.promote({
      slug, identity_id: aliceId, room_ids: [r1.id],
    });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: ex.id, starts_at: at(60), ends_at: at(120),
      slot_duration_minutes: 15,
    });

    // Bob books, Carol (bystander) can't cancel it.
    const b1 = await bob.rpc.experts.book({ slug, expert_id: ex.id, starts_at: at(60) });
    await expect(
      carol.rpc.experts.cancelBooking({ slug, booking_id: b1.booking_id }),
    ).rejects.toBeInstanceOf(ORPCError);

    // The expert (Alice) can cancel a booking on her own calendar.
    await alice.rpc.experts.cancelBooking({ slug, booking_id: b1.booking_id });

    // Re-book and let the owner cancel.
    const b2 = await bob.rpc.experts.book({ slug, expert_id: ex.id, starts_at: at(60) });
    await owner.rpc.experts.cancelBooking({ slug, booking_id: b2.booking_id });
  });

  test("expert cannot self-book; non-existent slot rejected", async () => {
    const { owner, slug } = await freshConference();
    const r = await owner.rpc.rooms.create({ slug, name: "R", capacity: 2 });
    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, slug, "alice@e.com");
    const ex = await owner.rpc.experts.promote({
      slug, identity_id: aliceId, room_ids: [r.id],
    });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: ex.id, starts_at: at(60), ends_at: at(90),
      slot_duration_minutes: 15,
    });
    await expect(
      alice.rpc.experts.book({ slug, expert_id: ex.id, starts_at: at(60) }),
    ).rejects.toMatchObject({ message: "cannot_book_self" });

    const { client: bob } = await inviteAndClaim(ctx.app, owner, slug, "bob@e.com");
    await expect(
      bob.rpc.experts.book({ slug, expert_id: ex.id, starts_at: at(61) }),
    ).rejects.toMatchObject({ message: "slot_not_found" });
  });

  test("promotion + demotion; non-mod cannot promote", async () => {
    const { owner, slug } = await freshConference();
    const { client: bob, identity_id: bobId } =
      await inviteAndClaim(ctx.app, owner, slug, "bob@e.com");
    const { identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, slug, "alice@e.com");

    await expect(bob.rpc.experts.promote({
      slug, identity_id: aliceId,
    })).rejects.toBeInstanceOf(ORPCError);

    const ex = await owner.rpc.experts.promote({ slug, identity_id: aliceId });
    expect(ex.id).toBeGreaterThan(0);
    await owner.rpc.experts.demote({ slug, id: ex.id });
    const list = await owner.rpc.experts.list({ slug });
    expect(list.length).toBe(0);

    void bobId;
  });

  test("expert with pool resolves rooms from the pool; pool changes don't retro-affect bookings", async () => {
    const { owner, slug } = await freshConference();
    const r1 = await owner.rpc.rooms.create({ slug, name: "Pool1", capacity: 2 });
    const r2 = await owner.rpc.rooms.create({ slug, name: "Pool2", capacity: 2 });
    const pool = await owner.rpc.experts.createPool({
      slug, name: "Main", room_ids: [r1.id, r2.id],
    });
    const { identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, slug, "alice@e.com");
    const ex = await owner.rpc.experts.promote({
      slug, identity_id: aliceId, pool_id: pool.id,
    });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: ex.id, starts_at: at(60), ends_at: at(90),
      slot_duration_minutes: 15,
    });
    const { client: bob } = await inviteAndClaim(ctx.app, owner, slug, "bob@e.com");
    const b = await bob.rpc.experts.book({
      slug, expert_id: ex.id, starts_at: at(60),
    });
    expect([r1.id, r2.id]).toContain(b.room_id);

    // Removing the booked room from the pool doesn't move the booking.
    await owner.rpc.experts.updatePool({
      slug, id: pool.id, room_ids: [r2.id], // strip r1 (or r2, whichever was picked)
    });
    const view = await bob.rpc.experts.list({ slug });
    const slot = view[0]!.slots.find((s) => s.starts_at === at(60))!;
    expect(slot.room_id).toBe(b.room_id);
  });

  test("expert bookings surface on both the booker's and the expert's schedule", async () => {
    const { owner, slug } = await freshConference();
    const room = await owner.rpc.rooms.create({ slug, name: "Quiet", capacity: 2 });
    const { identity_id: aliceId, client: alice } =
      await inviteAndClaim(ctx.app, owner, slug, "alice@e.com");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, slug, "bob@e.com");

    const ex = await owner.rpc.experts.promote({
      slug, identity_id: aliceId, room_ids: [room.id],
    });
    await owner.rpc.experts.createTimeframe({
      slug, expert_id: ex.id, starts_at: at(60), ends_at: at(90),
      slot_duration_minutes: 15,
    });

    const booked = await bob.rpc.experts.book({
      slug, expert_id: ex.id, starts_at: at(60),
    });

    // Bob (booker) sees the expert booking on his schedule.
    const bobSched = await bob.rpc.agenda.myAssignments({ slug });
    const bobExpert = bobSched.assignments.find((a) => a.source === "expert");
    expect(bobExpert).toBeDefined();
    expect(bobExpert!.booking_id).toBe(booked.booking_id);
    expect(bobExpert!.expert_role).toBe("booker");
    expect(bobExpert!.starts_at).toBe(at(60));
    expect(bobExpert!.room_id).toBe(room.id);
    expect(bobExpert!.slot_id).toBeNull();

    // Alice (the expert) sees the same booking flagged as expert_role=expert.
    const aliceSched = await alice.rpc.agenda.myAssignments({ slug });
    const aliceExpert = aliceSched.assignments.find((a) => a.source === "expert");
    expect(aliceExpert).toBeDefined();
    expect(aliceExpert!.booking_id).toBe(booked.booking_id);
    expect(aliceExpert!.expert_role).toBe("expert");

    // Cancellation removes the row from both schedules.
    await bob.rpc.experts.cancelBooking({ slug, booking_id: booked.booking_id });
    const bobAfter = await bob.rpc.agenda.myAssignments({ slug });
    const aliceAfter = await alice.rpc.agenda.myAssignments({ slug });
    expect(bobAfter.assignments.find((a) => a.source === "expert")).toBeUndefined();
    expect(aliceAfter.assignments.find((a) => a.source === "expert")).toBeUndefined();
  });
});
