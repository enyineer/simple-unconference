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
    const t0 = Date.now();
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
    const t0 = Date.now();
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
    const t0 = Date.now();
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
    const t0 = Date.now();
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
    const t0 = Date.now();
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: t0, ends_at: t0 + 3_600_000,
    });
    await expect(
      part.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id }),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(part.rpc.agenda.assignAll({ slug: conf.slug })).rejects.toBeInstanceOf(ORPCError);
  });
});
