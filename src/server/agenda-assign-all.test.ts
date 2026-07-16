// Integration tests for moderator placement authoring (agenda.placeSubmission /
// unplaceSubmission) + the global attendee router (agenda.assignAll).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestApp, Client, ORPCError, type TestApp, inviteAndClaim } from "./test-helpers";

async function signupAndLogin(c: Client, email: string) {
  return await c.rpc.auth.signup({ email, password: "secret123", name: "User" });
}

describe("global agenda assignment", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("a recurring session splits its starers across both occurrences", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "ga-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Unconf" });
    const r1 = await owner.rpc.rooms.create({ slug: conf.slug, name: "R1", capacity: 100 });
    const r2 = await owner.rpc.rooms.create({ slug: conf.slug, name: "R2", capacity: 100 });

    // A speaker submits the recurring session.
    const { client: speaker } = await inviteAndClaim(ctx.app, owner, conf.slug, "ga-speaker@example.com");
    const sub = await speaker.rpc.submissions.create({ slug: conf.slug, title: "Recurring" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    // Allow it to run in (non-overlapping) multiple slots.
    await owner.rpc.submissions.update({ slug: conf.slug, id: sub.id, allow_overlapping_placements: true });

    // Ten participants star it.
    const partIds: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { client, identity_id } = await inviteAndClaim(ctx.app, owner, conf.slug, `ga-p${i}@example.com`);
      await client.rpc.submissions.star({ slug: conf.slug, id: sub.id });
      partIds.push(identity_id);
    }

    // Two non-overlapping unconference slots.
    // Future so "Update seating" (assignAll) targets these slots — it only
    // re-seats future unconference slots.
    const t0 = Date.now() + 24 * 60 * 60 * 1000;
    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t0, ends_at: t0 + 3_600_000,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t0 + 7_200_000, ends_at: t0 + 10_800_000,
    });

    // Moderator authors the occurrence in BOTH slots.
    const p1 = await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot1.id, submission_id: sub.id, room_id: r1.id });
    expect(p1.kind).toBe("ok");
    const p2 = await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot2.id, submission_id: sub.id, room_id: r2.id });
    expect(p2.kind).toBe("ok");

    const res = await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(res.slot_ids.sort()).toEqual([slot1.id, slot2.id].sort());

    // Every participant attends exactly one occurrence; the crowd splits ~evenly.
    const a1 = await ctx.prisma.userAssignment.count({ where: { slotId: slot1.id } });
    const a2 = await ctx.prisma.userAssignment.count({ where: { slotId: slot2.id } });
    // 10 participants + the speaker (auto-hosted in one slot).
    expect(a1 + a2).toBeGreaterThanOrEqual(10);
    expect(Math.abs(a1 - a2)).toBeLessThanOrEqual(3);

    // No participant is double-booked (one assignment total each, since the
    // session recurs and avoid-duplicate is enforced).
    for (const uid of partIds) {
      const mine = await ctx.prisma.userAssignment.count({ where: { userId: uid } });
      expect(mine).toBe(1);
    }
  });

  test("overlapping unconference slots never double-book a user (same time-band)", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "ga-ov-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Overlap" });
    const r1 = await owner.rpc.rooms.create({ slug: conf.slug, name: "R1", capacity: 50 });
    const r2 = await owner.rpc.rooms.create({ slug: conf.slug, name: "R2", capacity: 50 });
    const { client: sp } = await inviteAndClaim(ctx.app, owner, conf.slug, "ga-ov-sp@example.com");
    const subA = await sp.rpc.submissions.create({ slug: conf.slug, title: "A" });
    const subB = await sp.rpc.submissions.create({ slug: conf.slug, title: "B" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });

    // Two unconference slots whose times OVERLAP → same band.
    // Future so "Update seating" (assignAll) targets these slots — it only
    // re-seats future unconference slots.
    const t0 = Date.now() + 24 * 60 * 60 * 1000;
    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t0, ends_at: t0 + 3_600_000,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t0 + 1_800_000, ends_at: t0 + 5_400_000,
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot1.id, submission_id: subA.id, room_id: r1.id });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot2.id, submission_id: subB.id, room_id: r2.id });

    // A participant stars BOTH overlapping sessions.
    const { client: part } = await inviteAndClaim(ctx.app, owner, conf.slug, "ga-ov-p@example.com");
    await part.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await part.rpc.submissions.star({ slug: conf.slug, id: subB.id });

    await owner.rpc.agenda.assignAll({ slug: conf.slug });

    // The double-starring participant must end up in AT MOST one of the two
    // overlapping slots (the band gate forbids both).
    const rows = await ctx.prisma.userAssignment.findMany({
      where: { slotId: { in: [slot1.id, slot2.id] }, submissionId: { not: null } },
    });
    const byUser = new Map<number, number>();
    for (const row of rows) byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + 1);
    for (const count of byUser.values()) expect(count).toBeLessThanOrEqual(1);
  });

  test("placeSubmission rejects a duplicate room and an out-of-scope submission", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "ga2-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Unconf2" });
    const r1 = await owner.rpc.rooms.create({ slug: conf.slug, name: "Room", capacity: 10 });
    const { client: sp } = await inviteAndClaim(ctx.app, owner, conf.slug, "ga2-sp@example.com");
    const subA = await sp.rpc.submissions.create({ slug: conf.slug, title: "A" });
    const subB = await sp.rpc.submissions.create({ slug: conf.slug, title: "B" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });
    // Future so "Update seating" (assignAll) targets these slots — it only
    // re-seats future unconference slots.
    const t0 = Date.now() + 24 * 60 * 60 * 1000;
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t0, ends_at: t0 + 3_600_000,
    });

    const ok = await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: subA.id, room_id: r1.id });
    expect(ok.kind).toBe("ok");
    // Same room, different session → taken.
    const clash = await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: subB.id, room_id: r1.id });
    expect(clash.kind).toBe("conflict");
    if (clash.kind === "conflict") expect(clash.reason).toBe("pin_room_taken");

    // Restrict scope to only subA, then try to place subB → out of scope.
    await owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slot.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [subA.id],
    });
    await expect(
      owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: subB.id, room_id: r1.id }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("unplaceSubmission removes the placement and its attendees", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "ga3-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Unconf3" });
    const r1 = await owner.rpc.rooms.create({ slug: conf.slug, name: "Room", capacity: 10 });
    const { client: sp } = await inviteAndClaim(ctx.app, owner, conf.slug, "ga3-sp@example.com");
    const sub = await sp.rpc.submissions.create({ slug: conf.slug, title: "Talk" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const { client: p } = await inviteAndClaim(ctx.app, owner, conf.slug, "ga3-p@example.com");
    await p.rpc.submissions.star({ slug: conf.slug, id: sub.id });
    // Future so "Update seating" (assignAll) targets these slots — it only
    // re-seats future unconference slots.
    const t0 = Date.now() + 24 * 60 * 60 * 1000;
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t0, ends_at: t0 + 3_600_000,
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id, room_id: r1.id });
    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: slot.id } })).toBeGreaterThan(0);

    await owner.rpc.agenda.unplaceSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id });
    expect(await ctx.prisma.unconferencePlacement.count({ where: { slotId: slot.id } })).toBe(0);
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: slot.id } })).toBe(0);
  });

  test("only moderators can place sessions or run assignAll", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "ga4-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Unconf4" });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "Room", capacity: 10 });
    const { client: part } = await inviteAndClaim(ctx.app, owner, conf.slug, "ga4-p@example.com");
    const sub = await part.rpc.submissions.create({ slug: conf.slug, title: "T" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    // Future so "Update seating" (assignAll) targets these slots — it only
    // re-seats future unconference slots.
    const t0 = Date.now() + 24 * 60 * 60 * 1000;
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t0, ends_at: t0 + 3_600_000,
    });
    await expect(
      part.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id }),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(part.rpc.agenda.assignAll({ slug: conf.slug })).rejects.toBeInstanceOf(ORPCError);
  });
});

// A comfortably-future, and a comfortably-past, minute-aligned time. "Update
// seating" only re-seats FUTURE unconference slots; past/started slots freeze.
function soon(offsetMs = 0) {
  return Date.now() + 24 * 60 * 60 * 1000 + offsetMs;
}
function past(offsetMs = 0) {
  return Date.now() - 24 * 60 * 60 * 1000 + offsetMs;
}

describe("seating model: placement vs stale-slots-only Update seating", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("per-slot assign is placement-only: writes placements, no seats, flags stale, cleans de-placed seats", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm1-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM1" });
    const rA = await owner.rpc.rooms.create({ slug: conf.slug, name: "RA", capacity: 50 });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "RB", capacity: 50 });
    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "A" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "B" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });
    const { client: pA, identity_id: pAId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm1-pa@example.com");
    const { client: pB } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm1-pb@example.com");
    await pA.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await pB.rpc.submissions.star({ slug: conf.slug, id: subB.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: soon(), ends_at: soon(3_600_000),
    });

    // Placement-only: both sessions are placed, ZERO seats are written, slot stale.
    const res = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (res.kind !== "unconference") throw new Error("expected unconference");
    expect(res.placements).toHaveLength(2);
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: slot.id } })).toBe(0);
    let ag = await owner.rpc.agenda.get({ slug: conf.slug });
    expect(ag.slots.find((s) => s.id === slot.id)!.seating_stale).toBe(true);

    // Seat, then confirm both sessions have attendees and stale is cleared.
    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: slot.id, submissionId: subA.id } })).toBeGreaterThan(0);
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: slot.id, submissionId: subB.id } })).toBeGreaterThan(0);
    ag = await owner.rpc.agenda.get({ slug: conf.slug });
    expect(ag.slots.find((s) => s.id === slot.id)!.seating_stale).toBe(false);

    // Restrict the slot scope to subA and re-run per-slot assign → subB is
    // de-placed. subB's seats must be cleaned; subA's seats must survive.
    await owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slot.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [subA.id],
    });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    const placements = await ctx.prisma.unconferencePlacement.findMany({ where: { slotId: slot.id } });
    expect(placements.map((p) => p.submissionId)).toEqual([subA.id]);
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: slot.id, submissionId: subB.id } })).toBe(0);
    // pA (starred subA, in room RA) is still seated in subA.
    const aSeat = await ctx.prisma.userAssignment.findFirst({ where: { slotId: slot.id, userId: pAId } });
    expect(aSeat?.submissionId).toBe(subA.id);
    expect(aSeat?.roomId).toBe(rA.id);
  });

  test("staleness lifecycle: place → stale, seat → cleared, unplace → stale (via agenda.get)", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm2-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM2" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "S" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const { client: p } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm2-p@example.com");
    await p.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: soon(), ends_at: soon(3_600_000),
    });
    const staleOf = async () =>
      (await owner.rpc.agenda.get({ slug: conf.slug })).slots.find((s) => s.id === slot.id)!.seating_stale;

    // Fresh slot with no placements → not stale.
    expect(await staleOf()).toBe(false);
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id, room_id: room.id });
    expect(await staleOf()).toBe(true);
    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(await staleOf()).toBe(false);
    await owner.rpc.agenda.unplaceSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id });
    expect(await staleOf()).toBe(true);
  });

  test("stale-only targeting: only the changed slot is re-seated; the other is byte-identical; only moved users notified", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm3-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM3" });
    const rX = await owner.rpc.rooms.create({ slug: conf.slug, name: "RX", capacity: 20 });
    const rY = await owner.rpc.rooms.create({ slug: conf.slug, name: "RY", capacity: 20 });
    const subX = await owner.rpc.submissions.create({ slug: conf.slug, title: "X" });
    const subY = await owner.rpc.submissions.create({ slug: conf.slug, title: "Y" });
    const subZ = await owner.rpc.submissions.create({ slug: conf.slug, title: "Z" });
    for (const s of [subX, subY, subZ]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const { client: pX, identity_id: pXId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm3-px@example.com");
    const { client: pY, identity_id: pYId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm3-py@example.com");
    await pX.rpc.submissions.star({ slug: conf.slug, id: subX.id });
    await pY.rpc.submissions.star({ slug: conf.slug, id: subY.id });
    await pY.rpc.submissions.star({ slug: conf.slug, id: subZ.id });

    // Two non-overlapping future slots.
    const t = soon();
    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t, ends_at: t + 3_600_000,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t + 7_200_000, ends_at: t + 10_800_000,
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot1.id, submission_id: subX.id, room_id: rX.id });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot2.id, submission_id: subY.id, room_id: rY.id });

    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    const slot1Before = await ctx.prisma.userAssignment.findMany({
      where: { slotId: slot1.id }, orderBy: [{ userId: "asc" }],
      select: { userId: true, submissionId: true, roomId: true },
    });
    const pXNotifBefore = await ctx.prisma.notification.findFirst({
      where: { identityId: pXId, kind: "unconf_assigned" }, select: { unreadCount: true },
    });
    expect(pXNotifBefore?.unreadCount).toBe(1);

    // Change ONLY slot2: swap subY out for subZ. slot1 stays untouched.
    await owner.rpc.agenda.unplaceSubmission({ slug: conf.slug, slot_id: slot2.id, submission_id: subY.id });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot2.id, submission_id: subZ.id, room_id: rY.id });

    const res = await owner.rpc.agenda.assignAll({ slug: conf.slug });
    // Only slot2 re-seated.
    expect(res.slot_ids).toEqual([slot2.id]);
    // slot1 seats are byte-identical.
    const slot1After = await ctx.prisma.userAssignment.findMany({
      where: { slotId: slot1.id }, orderBy: [{ userId: "asc" }],
      select: { userId: true, submissionId: true, roomId: true },
    });
    expect(slot1After).toEqual(slot1Before);
    // pY moved (subY → subZ) → re-notified; pX unchanged → NOT re-notified.
    const pXNotifAfter = await ctx.prisma.notification.findFirst({
      where: { identityId: pXId, kind: "unconf_assigned" }, select: { unreadCount: true },
    });
    expect(pXNotifAfter?.unreadCount).toBe(1);
    const pYNotifAfter = await ctx.prisma.notification.findFirst({
      where: { identityId: pYId, kind: "unconf_assigned" }, select: { unreadCount: true },
    });
    expect((pYNotifAfter?.unreadCount ?? 0)).toBeGreaterThanOrEqual(2);
    // pY ends up seated in subZ.
    const pYSeat = await ctx.prisma.userAssignment.findFirst({ where: { slotId: slot2.id, userId: pYId } });
    expect(pYSeat?.submissionId).toBe(subZ.id);
  });

  test("freeze: a session already attended in a frozen slot is never re-attended in a stale slot", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm4a-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM4a" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Recurring" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    await owner.rpc.submissions.update({ slug: conf.slug, id: sub.id, allow_overlapping_placements: true, max_placements: 10 });
    const { client: u, identity_id: uId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm4a-u@example.com");
    await u.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    // Frozen (past, seated) slot + a stale (future) slot, both running `sub`.
    const frozen = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: past(), ends_at: past(3_600_000),
    });
    const future = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: soon(), ends_at: soon(3_600_000),
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: frozen.id, submission_id: sub.id, room_id: room.id });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: future.id, submission_id: sub.id, room_id: room.id });
    // Seat u into the frozen slot directly (frozen = has UserAssignment, not a target).
    await ctx.prisma.userAssignment.create({
      data: { slotId: frozen.id, userId: uId, submissionId: sub.id, roomId: room.id },
    });

    const res = await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(res.slot_ids).toEqual([future.id]);
    expect(await ctx.prisma.userAssignment.findFirst({ where: { slotId: future.id, userId: uId } })).toBeNull();
  });

  test("freeze: a user busy in a frozen time-overlapping slot is skipped in the stale slot", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm4b-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM4b" });
    const rP = await owner.rpc.rooms.create({ slug: conf.slug, name: "RP", capacity: 20 });
    const rQ = await owner.rpc.rooms.create({ slug: conf.slug, name: "RQ", capacity: 20 });
    const subP = await owner.rpc.submissions.create({ slug: conf.slug, title: "P" });
    const subQ = await owner.rpc.submissions.create({ slug: conf.slug, title: "Q" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subP.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subQ.id });
    const { client: v, identity_id: vId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm4b-v@example.com");
    const { client: w, identity_id: wId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm4b-w@example.com");
    await v.rpc.submissions.star({ slug: conf.slug, id: subP.id });
    await v.rpc.submissions.star({ slug: conf.slug, id: subQ.id });
    await w.rpc.submissions.star({ slug: conf.slug, id: subQ.id });

    // Two overlapping future slots. Seat slot1 first (it clears its own stale
    // flag → frozen), then place slot2 (stale) and re-seat only it.
    const t = soon();
    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t, ends_at: t + 3_600_000,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t + 1_800_000, ends_at: t + 5_400_000,
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot1.id, submission_id: subP.id, room_id: rP.id });
    await owner.rpc.agenda.assignAll({ slug: conf.slug }); // seats slot1, clears its stale flag
    expect(await ctx.prisma.userAssignment.findFirst({ where: { slotId: slot1.id, userId: vId } })).not.toBeNull();

    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot2.id, submission_id: subQ.id, room_id: rQ.id });
    const res = await owner.rpc.agenda.assignAll({ slug: conf.slug });
    // Only slot2 is a target; slot1 is frozen and overlaps slot2's band.
    expect(res.slot_ids).toEqual([slot2.id]);
    // v is busy in slot1's (overlapping) band → not seated in slot2. w is free.
    expect(await ctx.prisma.userAssignment.findFirst({ where: { slotId: slot2.id, userId: vId } })).toBeNull();
    expect(await ctx.prisma.userAssignment.findFirst({ where: { slotId: slot2.id, userId: wId } })).not.toBeNull();
  });

  test("past/started slots are never re-seated, even when stale", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm5-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM5" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "S" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const { client: p } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm5-p@example.com");
    await p.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const pastSlot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: past(), ends_at: past(3_600_000),
    });
    // placeSubmission flags the slot stale.
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: pastSlot.id, submission_id: sub.id, room_id: room.id });
    const ag = await owner.rpc.agenda.get({ slug: conf.slug });
    expect(ag.slots.find((s) => s.id === pastSlot.id)!.seating_stale).toBe(true);

    const res = await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(res.slot_ids).toEqual([]);
    expect(res.assigned).toBe(0);
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: pastSlot.id } })).toBe(0);
    // Still stale (never re-seated).
    const ag2 = await owner.rpc.agenda.get({ slug: conf.slug });
    expect(ag2.slots.find((s) => s.id === pastSlot.id)!.seating_stale).toBe(true);
  });

  test("include_unchanged re-seats unchanged FUTURE slots but never past ones", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm6-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM6" });
    const rF = await owner.rpc.rooms.create({ slug: conf.slug, name: "RF", capacity: 20 });
    const rP = await owner.rpc.rooms.create({ slug: conf.slug, name: "RP", capacity: 20 });
    const subF = await owner.rpc.submissions.create({ slug: conf.slug, title: "F" });
    const subP = await owner.rpc.submissions.create({ slug: conf.slug, title: "P" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subF.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subP.id });
    const { client: pf } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm6-pf@example.com");
    const { client: pp } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm6-pp@example.com");
    await pf.rpc.submissions.star({ slug: conf.slug, id: subF.id });
    await pp.rpc.submissions.star({ slug: conf.slug, id: subP.id });

    const futureSlot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: soon(), ends_at: soon(3_600_000),
    });
    const pastSlot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: past(), ends_at: past(3_600_000),
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: futureSlot.id, submission_id: subF.id, room_id: rF.id });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: pastSlot.id, submission_id: subP.id, room_id: rP.id });

    // Seat the future slot (clears its stale flag → "unchanged" going forward).
    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    // Default run: nothing stale + future → no targets.
    const plain = await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(plain.slot_ids).toEqual([]);
    // include_unchanged: re-seats the unchanged FUTURE slot, still never the past one.
    const inc = await owner.rpc.agenda.assignAll({ slug: conf.slug, include_unchanged: true });
    expect(inc.slot_ids).toEqual([futureSlot.id]);
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: pastSlot.id } })).toBe(0);
  });

  test("notification diff: re-running Update seating with no seat changes notifies nobody the second time", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm7-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM7" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "S" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const { client: p, identity_id: pId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm7-p@example.com");
    await p.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: soon(), ends_at: soon(3_600_000),
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id, room_id: room.id });

    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    const before = await ctx.prisma.notification.findFirst({
      where: { identityId: pId, kind: "unconf_assigned" }, select: { unreadCount: true },
    });
    expect(before?.unreadCount).toBe(1);

    // Force a full re-seat (include_unchanged) with identical placements/stars →
    // seats are byte-identical → nobody is "changed" → no new/updated notifications.
    await owner.rpc.agenda.assignAll({ slug: conf.slug, include_unchanged: true });
    const after = await ctx.prisma.notification.findFirst({
      where: { identityId: pId, kind: "unconf_assigned" }, select: { unreadCount: true },
    });
    expect(after?.unreadCount).toBe(1);
  });

  test("first-ever Update seating (all slots stale) seats every starrer", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm8-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM8" });
    const rA = await owner.rpc.rooms.create({ slug: conf.slug, name: "RA", capacity: 50 });
    const rB = await owner.rpc.rooms.create({ slug: conf.slug, name: "RB", capacity: 50 });
    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "A" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "B" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });

    const starrers: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { client, identity_id } = await inviteAndClaim(ctx.app, owner, conf.slug, `sm8-p${i}@example.com`);
      await client.rpc.submissions.star({ slug: conf.slug, id: i % 2 === 0 ? subA.id : subB.id });
      starrers.push(identity_id);
    }

    // Two non-overlapping future slots, each running one of the sessions.
    const t = soon();
    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t, ends_at: t + 3_600_000,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t + 7_200_000, ends_at: t + 10_800_000,
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot1.id, submission_id: subA.id, room_id: rA.id });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot2.id, submission_id: subB.id, room_id: rB.id });

    const res = await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(res.slot_ids.sort()).toEqual([slot1.id, slot2.id].sort());
    // Every starrer got a seat (ample capacity).
    for (const uid of starrers) {
      expect(await ctx.prisma.userAssignment.count({ where: { userId: uid } })).toBeGreaterThanOrEqual(1);
    }
  });

  test("submissions.delete flags affected slots stale and removes the deleted session's seats", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm9-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM9" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "S" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const { client: p, identity_id: pId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm9-p@example.com");
    await p.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: soon(), ends_at: soon(3_600_000),
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id, room_id: room.id });
    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    const staleOf = async () =>
      (await owner.rpc.agenda.get({ slug: conf.slug })).slots.find((s) => s.id === slot.id)!.seating_stale;
    expect(await staleOf()).toBe(false);
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: slot.id, userId: pId } })).toBe(1);

    await owner.rpc.submissions.delete({ slug: conf.slug, id: sub.id });
    // Affected slot flagged stale; no seats survive (and none dangle null).
    expect(await staleOf()).toBe(true);
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: slot.id } })).toBe(0);
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: slot.id, submissionId: null } })).toBe(0);
  });

  test("rooms.delete flags slots that placed a session in that room stale", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm10-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM10" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "S" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const { client: p } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm10-p@example.com");
    await p.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: soon(), ends_at: soon(3_600_000),
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id, room_id: room.id });
    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    const staleOf = async () =>
      (await owner.rpc.agenda.get({ slug: conf.slug })).slots.find((s) => s.id === slot.id)!.seating_stale;
    expect(await staleOf()).toBe(false);

    await owner.rpc.rooms.delete({ slug: conf.slug, id: room.id });
    expect(await staleOf()).toBe(true);
  });

  test("updateSeries orphan cleanup flags the affected slots stale", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm11-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM11" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 20 });
    const subX = await owner.rpc.submissions.create({ slug: conf.slug, title: "X" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subX.id });
    const { client: p } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm11-p@example.com");
    await p.rpc.submissions.star({ slug: conf.slug, id: subX.id });

    const t = soon();
    const a = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t, ends_at: t + 3_600_000,
    });
    const b = await owner.rpc.agenda.duplicateSlot({
      slug: conf.slug, id: a.id, new_starts_at: t + 7_200_000, new_ends_at: t + 10_800_000,
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: a.id, submission_id: subX.id, room_id: room.id });
    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    const staleOf = async () =>
      (await owner.rpc.agenda.get({ slug: conf.slug })).slots.find((s) => s.id === a.id)!.seating_stale;
    expect(await staleOf()).toBe(false);

    // Narrow the series's submission pool to exclude subX → the placement in
    // slot a is orphaned. `confirm: true` runs the cleanup.
    await owner.rpc.agenda.updateSeries({
      slug: conf.slug, id: b.series_id,
      unconf_use_all_submissions: false, unconf_submission_ids: [], confirm: true,
    });
    expect(await ctx.prisma.unconferencePlacement.count({ where: { slotId: a.id } })).toBe(0);
    expect(await staleOf()).toBe(true);
  });

  test("degenerate Update seating: zero targets → no-op result, no writes, no notifications", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm12-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM12" });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "S" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const { client: p, identity_id: pId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm12-p@example.com");
    await p.rpc.submissions.star({ slug: conf.slug, id: sub.id });
    // No unconference slots placed at all.
    const res = await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(res).toEqual({ assigned: 0, unplaced_user_ids: [], slot_ids: [] });
    expect(await ctx.prisma.userAssignment.count({ where: { slot: { conference: { slug: conf.slug } } } })).toBe(0);
    expect(await ctx.prisma.notification.count({ where: { identityId: pId, kind: "unconf_assigned" } })).toBe(0);
  });

  test("mixer isolation: a seated mixer slot is never a target and its seats are untouched", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm13-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM13" });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "M1", capacity: 10 });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "M2", capacity: 10 });
    const rUnconf = await owner.rpc.rooms.create({ slug: conf.slug, name: "U", capacity: 20 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    for (let i = 0; i < 4; i++) {
      const { client } = await inviteAndClaim(ctx.app, owner, conf.slug, `sm13-p${i}@example.com`);
      await client.rpc.submissions.star({ slug: conf.slug, id: sub.id });
    }
    // Mixer at one time, unconference at a non-overlapping later time.
    const t = soon();
    const mixer = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "mixer", title: "Mix", starts_at: t, ends_at: t + 3_600_000,
    });
    const unconf = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t + 7_200_000, ends_at: t + 10_800_000,
    });
    // Mixer assign still seats (unchanged mixer branch).
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: mixer.id });
    const mixerBefore = await ctx.prisma.userAssignment.findMany({
      where: { slotId: mixer.id }, orderBy: [{ userId: "asc" }],
      select: { userId: true, roomId: true, submissionId: true },
    });
    expect(mixerBefore.length).toBeGreaterThan(0);

    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: unconf.id, submission_id: sub.id, room_id: rUnconf.id });
    const res = await owner.rpc.agenda.assignAll({ slug: conf.slug });
    // Only the unconference slot is a target; the mixer is never re-seated.
    expect(res.slot_ids).toEqual([unconf.id]);
    const mixerAfter = await ctx.prisma.userAssignment.findMany({
      where: { slotId: mixer.id }, orderBy: [{ userId: "asc" }],
      select: { userId: true, roomId: true, submissionId: true },
    });
    expect(mixerAfter).toEqual(mixerBefore);
  });

  test("notification diff notifies a user whose seat is REMOVED on a re-seat", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm14-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM14" });
    const rS = await owner.rpc.rooms.create({ slug: conf.slug, name: "RS", capacity: 20 });
    const rT = await owner.rpc.rooms.create({ slug: conf.slug, name: "RT", capacity: 20 });
    const subS = await owner.rpc.submissions.create({ slug: conf.slug, title: "S" });
    const subT = await owner.rpc.submissions.create({ slug: conf.slug, title: "T" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subS.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subT.id });
    await owner.rpc.submissions.update({ slug: conf.slug, id: subS.id, allow_overlapping_placements: true, max_placements: 10 });
    const { client: p, identity_id: pId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm14-p@example.com");
    await p.rpc.submissions.star({ slug: conf.slug, id: subS.id });

    // Target future slot running subS; p starred it → seated on the first run.
    const target = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: soon(), ends_at: soon(3_600_000),
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: target.id, submission_id: subS.id, room_id: rS.id });
    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: target.id, userId: pId } })).toBe(1);
    const before = await ctx.prisma.notification.findFirst({
      where: { identityId: pId, kind: "unconf_assigned" }, select: { unreadCount: true },
    });
    expect(before?.unreadCount).toBe(1);

    // Now p already attends subS in a FROZEN past slot → the never-twice rule
    // will drop them from the target on the next re-seat. Flag the target stale
    // WITHOUT touching p's existing seat by placing an unrelated session subT.
    const frozen = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: past(), ends_at: past(3_600_000),
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: frozen.id, submission_id: subS.id, room_id: rS.id });
    await ctx.prisma.userAssignment.create({
      data: { slotId: frozen.id, userId: pId, submissionId: subS.id, roomId: rS.id },
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: target.id, submission_id: subT.id, room_id: rT.id });

    const res = await owner.rpc.agenda.assignAll({ slug: conf.slug });
    expect(res.slot_ids).toEqual([target.id]);
    // p lost their target seat (already attends subS in the frozen slot).
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: target.id, userId: pId } })).toBe(0);
    // The removed-seat user IS re-notified.
    const after = await ctx.prisma.notification.findFirst({
      where: { identityId: pId, kind: "unconf_assigned" }, select: { unreadCount: true },
    });
    expect((after?.unreadCount ?? 0)).toBeGreaterThanOrEqual(2);
  });

  test("planned-track attendance is never re-seated as an unconference occurrence of the same session", async () => {
    // The FIX: a user who attends submission X as a planned (normal-slot) track
    // — via a star or as its submitter — must never be seated into an
    // unconference occurrence of X. Non-overlapping slots isolate this to
    // `priorAttendance` (not a band conflict).
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "sm15-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SM15" });
    const rPlan = await owner.rpc.rooms.create({ slug: conf.slug, name: "Plan", capacity: 50 });
    const rX = await owner.rpc.rooms.create({ slug: conf.slug, name: "RX", capacity: 50 });
    const rY = await owner.rpc.rooms.create({ slug: conf.slug, name: "RY", capacity: 50 });
    // subX is owner-submitted, tracked as a planned talk AND placed in unconf.
    const subX = await owner.rpc.submissions.create({ slug: conf.slug, title: "X" });
    const subY = await owner.rpc.submissions.create({ slug: conf.slug, title: "Y" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subX.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subY.id });
    await owner.rpc.submissions.update({ slug: conf.slug, id: subX.id, allow_overlapping_placements: true, max_placements: 10 });

    const { client: pX, identity_id: pXId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm15-px@example.com");
    const { client: pY, identity_id: pYId } = await inviteAndClaim(ctx.app, owner, conf.slug, "sm15-py@example.com");
    // pX stars subX (→ attends the planned track → excluded from unconf X).
    await pX.rpc.submissions.star({ slug: conf.slug, id: subX.id });
    // pY stars subY only (→ seats normally into subY in the unconf slot).
    await pY.rpc.submissions.star({ slug: conf.slug, id: subY.id });

    const t = soon();
    // Planned slot with subX as a track, non-overlapping with the unconf slot.
    const planned = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", title: "Keynote", starts_at: t, ends_at: t + 3_600_000,
    });
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: planned.id, room_id: rPlan.id, submission_id: subX.id,
    });
    const unconf = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t + 7_200_000, ends_at: t + 10_800_000,
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: unconf.id, submission_id: subX.id, room_id: rX.id });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: unconf.id, submission_id: subY.id, room_id: rY.id });

    await owner.rpc.agenda.assignAll({ slug: conf.slug });
    // Nobody attends unconf X: pX (starrer) and the owner (submitter) both attend
    // it as the planned track already.
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: unconf.id, submissionId: subX.id } })).toBe(0);
    expect(await ctx.prisma.userAssignment.count({ where: { slotId: unconf.id, userId: pXId } })).toBe(0);
    // The slot otherwise seats normally: pY lands in subY.
    const pYSeat = await ctx.prisma.userAssignment.findFirst({ where: { slotId: unconf.id, userId: pYId } });
    expect(pYSeat?.submissionId).toBe(subY.id);
  });
});
