// Tests for the planned-slot room refit (`agenda.refitRooms`) and the
// schedule-change notifications that fire when a talk is scheduled into, moved
// within, or removed from a planned slot (plus the unconference placement
// room-move notification). Each describe block gets its own temp DB.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  setupTestApp, Client, ORPCError, type TestApp,
  inviteAndClaim,
} from "./test-helpers";

async function signupAndLogin(c: Client, email: string, password = "secret123") {
  return await c.rpc.auth.signup({ email, password, name: "User" });
}

// Seating only touches FUTURE unconference slots, so seating-relevant slots
// must live in the future (mirrors routes.test.ts).
function soon(offsetMs = 0) {
  return Date.now() + 24 * 60 * 60 * 1000 + offsetMs;
}

let ctx: TestApp;

async function setupPlannedConf(prefix: string) {
  const owner = new Client(ctx.app);
  await signupAndLogin(owner, `${prefix}-owner@example.com`);
  const conf = await owner.rpc.conferences.create({ name: `Conf ${prefix}` });
  return { owner, conf };
}

async function mintParticipants(
  owner: Client, slug: string, prefix: string, n: number,
): Promise<{ client: Client; identityId: number }[]> {
  const out: { client: Client; identityId: number }[] = [];
  for (let i = 0; i < n; i++) {
    const { client, identity_id } =
      await inviteAndClaim(ctx.app, owner, slug, `${prefix}-p${i}@example.com`);
    out.push({ client, identityId: identity_id });
  }
  return out;
}

function scheduleNotes<T extends { kind: string }>(inbox: { items: T[] }): T[] {
  return inbox.items.filter((i) => i.kind === "schedule_changed");
}

describe("agenda.refitRooms + schedule-change notifications", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("refit: a requirements misfit swaps with a less-starred talk; requirements survive; idempotent", async () => {
    const { owner, conf } = await setupPlannedConf("refit1");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30, tags: ["projector"] });
    const mid = await owner.rpc.rooms.create({ slug: conf.slug, name: "Mid", capacity: 20 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });

    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk A" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk B" });
    const subC = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk C" });
    for (const s of [subA, subB, subC]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });

    // Skewed stars: A=3, B=2, C=1.
    const parts = await mintParticipants(owner, conf.slug, "refit1", 3);
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await parts[2]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: subB.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: subB.id });
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: subC.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", title: "Sessions",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });

    // Deliberately mismatched initial placement: A→small, B→mid, C→big. A also
    // carries a projector requirement (only Big has the tag).
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id, room_id: small.id,
      submission_id: subA.id, requirements: ["projector"],
    });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: mid.id, submission_id: subB.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: big.id, submission_id: subC.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("expected ok");
    // A ↔ C swap; B stays put.
    expect(r.moves).toHaveLength(2);
    expect(r.moves.find((m) => m.submission_id === subA.id)).toMatchObject({ from_room: "Small", to_room: "Big" });
    expect(r.moves.find((m) => m.submission_id === subC.id)).toMatchObject({ from_room: "Big", to_room: "Small" });

    const agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    const byRoom = new Map(agenda.tracks.map((t) => [t.room_id, t]));
    expect(byRoom.get(big.id)!.submission_id).toBe(subA.id);
    expect(byRoom.get(mid.id)!.submission_id).toBe(subB.id);
    expect(byRoom.get(small.id)!.submission_id).toBe(subC.id);
    // Track requirements were re-created on the rebuilt track.
    expect(byRoom.get(big.id)!.requirements).toEqual(["projector"]);

    // Second run: nothing to do, and no new notifications for a starrer.
    const beforeInbox = await parts[0]!.client.rpc.notifications.list({ slug: conf.slug });
    const beforeUnread = scheduleNotes(beforeInbox).reduce((a, i) => a + i.unread_count, 0);
    const r2 = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    expect(r2.kind).toBe("ok");
    if (r2.kind !== "ok") throw new Error("expected ok");
    expect(r2.moves).toHaveLength(0);
    const afterInbox = await parts[0]!.client.rpc.notifications.list({ slug: conf.slug });
    const afterUnread = scheduleNotes(afterInbox).reduce((a, i) => a + i.unread_count, 0);
    expect(afterUnread).toBe(beforeUnread);
  });

  test("refit repairs a pin: a wrongly-placed pinned track moves onto its free pin room", async () => {
    const { owner, conf } = await setupPlannedConf("refit-pin");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const mid = await owner.rpc.rooms.create({ slug: conf.slug, name: "Mid", capacity: 20 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
    const pinned = await owner.rpc.submissions.create({ slug: conf.slug, title: "Pinned" });
    const filler = await owner.rpc.submissions.create({ slug: conf.slug, title: "Filler" });
    for (const s of [pinned, filler]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    await owner.rpc.submissions.update({ slug: conf.slug, id: pinned.id, pre_assigned_room_id: big.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // pinned sits in small (its pin points at the free Big); filler fits in mid.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: small.id, submission_id: pinned.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: mid.id, submission_id: filler.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    const byRoom = new Map((await owner.rpc.agenda.get({ slug: conf.slug })).tracks.map((t) => [t.room_id, t.submission_id]));
    // The pin is honored: pinned moves onto Big; filler (fits) never moves.
    expect(byRoom.get(big.id)).toBe(pinned.id);
    expect(byRoom.get(mid.id)).toBe(filler.id);
  });

  test("refit: a pin whose room is held by a fitting non-misfit → pin_room_taken + zero writes", async () => {
    const { owner, conf } = await setupPlannedConf("refit-pin-taken");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
    const pinned = await owner.rpc.submissions.create({ slug: conf.slug, title: "Pinned" });
    const hot = await owner.rpc.submissions.create({ slug: conf.slug, title: "Hot" });
    for (const s of [pinned, hot]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    await owner.rpc.submissions.update({ slug: conf.slug, id: pinned.id, pre_assigned_room_id: big.id });
    // `hot` is more-starred than `pinned` and fits Big → it's a non-misfit that
    // won't move, so the pin can't be honored without evicting a talk that fits.
    const parts = await mintParticipants(owner, conf.slug, "refit-pin-taken", 2);
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: hot.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: hot.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: small.id, submission_id: pinned.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: big.id, submission_id: hot.id });

    const before = new Map((await owner.rpc.agenda.get({ slug: conf.slug })).tracks.map((t) => [t.submission_id, t.room_id]));
    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("expected conflict");
    expect(r.reason).toBe("pin_room_taken");
    if (r.reason !== "pin_room_taken") throw new Error("expected pin_room_taken");
    expect(r.pinned_room!.id).toBe(big.id);
    expect(r.submission!.id).toBe(pinned.id);
    const after = new Map((await owner.rpc.agenda.get({ slug: conf.slug })).tracks.map((t) => [t.submission_id, t.room_id]));
    expect(after).toEqual(before);
  });

  test("refit: requirements honored — a misfit takes the satisfying room, not the bigger one", async () => {
    const { owner, conf } = await setupPlannedConf("refit-req");
    const plain = await owner.rpc.rooms.create({ slug: conf.slug, name: "Plain", capacity: 10 });
    const bigPlain = await owner.rpc.rooms.create({ slug: conf.slug, name: "BigPlain", capacity: 50 });
    const studio = await owner.rpc.rooms.create({ slug: conf.slug, name: "Studio", capacity: 10, tags: ["projector"] });
    const proj = await owner.rpc.submissions.create({ slug: conf.slug, title: "Needs projector" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: proj.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // proj requires a projector but sits in Plain (no projector) → misfit. Both
    // BigPlain (bigger) and Studio (projector) are free; it must pick Studio.
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id, room_id: plain.id,
      submission_id: proj.id, requirements: ["projector"],
    });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    const byRoom = new Map((await owner.rpc.agenda.get({ slug: conf.slug })).tracks.map((t) => [t.room_id, t.submission_id]));
    expect(byRoom.get(studio.id)).toBe(proj.id);
    expect(byRoom.has(bigPlain.id)).toBe(false);
  });

  test("refit: an unimprovable misfit stays put, is reported in unresolved, and notifies no one", async () => {
    const { owner, conf } = await setupPlannedConf("refit-unresolved");
    const studio = await owner.rpc.rooms.create({ slug: conf.slug, name: "Studio", capacity: 20, tags: ["projector"] });
    const plain = await owner.rpc.rooms.create({ slug: conf.slug, name: "Plain", capacity: 10 });
    const subX = await owner.rpc.submissions.create({ slug: conf.slug, title: "X" });
    const subY = await owner.rpc.submissions.create({ slug: conf.slug, title: "Y" });
    for (const s of [subX, subY]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    // subY's submitter is a participant we can check for (non-)notification.
    const { client: fan, identity_id: fanId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "refit-unresolved-fan@example.com");
    await fan.rpc.submissions.star({ slug: conf.slug, id: subY.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // Both require projector; only Studio has it and subX already fits there.
    // A swap is impossible (subX also needs projector, which subY's Plain room
    // lacks), so subY can't be improved.
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id, room_id: studio.id, submission_id: subX.id, requirements: ["projector"],
    });
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id, room_id: plain.id, submission_id: subY.id, requirements: ["projector"],
    });

    const before = new Map((await owner.rpc.agenda.get({ slug: conf.slug })).tracks.map((t) => [t.submission_id, t.room_id]));
    // The fan already holds the "scheduled" note from setup; refit must add none.
    const notesBefore = await ctx.prisma.notification.count({
      where: { identityId: fanId, kind: "schedule_changed" },
    });
    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.moves).toHaveLength(0);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]).toMatchObject({ submission_id: subY.id, reason: "requirements" });

    // Zero writes (nothing moved) and no NEW schedule notification for the fan.
    const after = new Map((await owner.rpc.agenda.get({ slug: conf.slug })).tracks.map((t) => [t.submission_id, t.room_id]));
    expect(after).toEqual(before);
    const notesAfter = await ctx.prisma.notification.count({
      where: { identityId: fanId, kind: "schedule_changed" },
    });
    expect(notesAfter).toBe(notesBefore);
  });

  test("refit: nothing moves when every talk already fits, even with a bigger room free", async () => {
    const { owner, conf } = await setupPlannedConf("refit-antichurn");
    const mid = await owner.rpc.rooms.create({ slug: conf.slug, name: "Mid", capacity: 10 });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Fits fine" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // Comfortably within Mid, and Big sits empty — a re-rank would grab Big, a
    // repair leaves it alone.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: mid.id, submission_id: sub.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.moves).toHaveLength(0);
    expect(r.unresolved).toHaveLength(0);
    const byRoom = new Map((await owner.rpc.agenda.get({ slug: conf.slug })).tracks.map((t) => [t.room_id, t.submission_id]));
    expect(byRoom.get(mid.id)).toBe(sub.id);
  });

  test("refit: an overfilled talk takes the SMALLEST adequate free room", async () => {
    const { owner, conf } = await setupPlannedConf("refit-smallest");
    const tiny = await owner.rpc.rooms.create({ slug: conf.slug, name: "Tiny", capacity: 1 });
    const mid = await owner.rpc.rooms.create({ slug: conf.slug, name: "Mid", capacity: 3 });
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Crowded" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-smallest", 3);
    for (const p of parts) await p.client.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // 3 stars overfill Tiny(1). Mid(3) and Big(30) both cover it → Mid wins
    // (smallest adequate, keeping Big free for a bigger talk).
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: tiny.id, submission_id: sub.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.moves).toEqual([
      { submission_id: sub.id, title: "Crowded", from_room: "Tiny", to_room: "Mid" },
    ]);
    const byRoom = new Map((await owner.rpc.agenda.get({ slug: conf.slug })).tracks.map((t) => [t.room_id, t.submission_id]));
    expect(byRoom.get(mid.id)).toBe(sub.id);
    expect(byRoom.has(big.id)).toBe(false); // Big left free (not the biggest-grabs-most rule)
  });

  test("refit: with no adequate room, best effort takes the largest bigger room", async () => {
    const { owner, conf } = await setupPlannedConf("refit-besteffort");
    const tiny = await owner.rpc.rooms.create({ slug: conf.slug, name: "Tiny", capacity: 1 });
    const midA = await owner.rpc.rooms.create({ slug: conf.slug, name: "MidA", capacity: 2 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Crowded" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-besteffort", 3);
    for (const p of parts) await p.client.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // 3 stars fit no room; MidA(2) is bigger than Tiny(1) → best-effort move.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: tiny.id, submission_id: sub.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    const byRoom = new Map((await owner.rpc.agenda.get({ slug: conf.slug })).tracks.map((t) => [t.room_id, t.submission_id]));
    expect(byRoom.get(midA.id)).toBe(sub.id);
    // A best-effort move is still an improvement, so it's a move (not unresolved).
    expect(r.moves).toHaveLength(1);
    expect(r.unresolved).toHaveLength(0);
  });

  test("refit: overfilled with no bigger room stays put and is reported", async () => {
    const { owner, conf } = await setupPlannedConf("refit-nobigger");
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "Room", capacity: 2 });
    const tiny = await owner.rpc.rooms.create({ slug: conf.slug, name: "Tiny", capacity: 1 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Crowded" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-nobigger", 3);
    for (const p of parts) await p.client.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // 3 stars overfill Room(2); the only other room Tiny(1) is smaller → no
    // improvement possible, so it stays put.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: room.id, submission_id: sub.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.moves).toHaveLength(0);
    expect(r.unresolved).toEqual([{ submission_id: sub.id, title: "Crowded", reason: "overfilled" }]);
    void tiny;
  });

  test("refit: overfilled misfit swaps with a less-starred talk; both are notified", async () => {
    const { owner, conf } = await setupPlannedConf("refit-swap");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 1 });
    const popular = await owner.rpc.submissions.create({ slug: conf.slug, title: "Popular" });
    const quiet = await owner.rpc.submissions.create({ slug: conf.slug, title: "Quiet" });
    for (const s of [popular, quiet]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-swap", 3);
    // Popular: 2 stars (overfilled in Small); Quiet: 1 star (fits Big).
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: popular.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: popular.id });
    await parts[2]!.client.rpc.submissions.star({ slug: conf.slug, id: quiet.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: small.id, submission_id: popular.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: big.id, submission_id: quiet.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.moves).toHaveLength(2);
    const byRoom = new Map((await owner.rpc.agenda.get({ slug: conf.slug })).tracks.map((t) => [t.room_id, t.submission_id]));
    expect(byRoom.get(big.id)).toBe(popular.id);
    expect(byRoom.get(small.id)).toBe(quiet.id);

    // Both moved talks notify their own audiences.
    const popularFan = await ctx.prisma.notification.findMany({
      where: { identityId: parts[0]!.identityId, kind: "schedule_changed" },
    });
    expect(popularFan[0]!.body).toBe("Popular moved to Big");
    const quietFan = await ctx.prisma.notification.findMany({
      where: { identityId: parts[2]!.identityId, kind: "schedule_changed" },
    });
    expect(quietFan[0]!.body).toBe("Quiet moved to Small");
  });

  test("refit: a room held by an OVERLAPPING planned slot's track is not claimable", async () => {
    const { owner, conf } = await setupPlannedConf("refit-overlap-track");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 1 });
    const subM = await owner.rpc.submissions.create({ slug: conf.slug, title: "M" });
    const subOther = await owner.rpc.submissions.create({ slug: conf.slug, title: "Other" });
    for (const s of [subM, subOther]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-overlap-track", 2);
    for (const p of parts) await p.client.rpc.submissions.star({ slug: conf.slug, id: subM.id });

    const start = Date.now();
    const slotA = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    const slotB = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    // slotB occupies Big during the same window; slotA's overfilled M therefore
    // cannot escape Small into Big.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slotB.id, room_id: big.id, submission_id: subOther.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slotA.id, room_id: small.id, submission_id: subM.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slotA.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.moves).toHaveLength(0);
    expect(r.unresolved).toEqual([{ submission_id: subM.id, title: "M", reason: "overfilled" }]);
    const aTracks = await ctx.prisma.trackAssignment.findMany({ where: { slotId: slotA.id } });
    expect(aTracks).toHaveLength(1);
    expect(aTracks[0]!.roomId).toBe(small.id);
  });

  test("refit: a room held by an OVERLAPPING unconference placement is not claimable", async () => {
    const { owner, conf } = await setupPlannedConf("refit-overlap-place");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 1 });
    const subM = await owner.rpc.submissions.create({ slug: conf.slug, title: "M" });
    const subOther = await owner.rpc.submissions.create({ slug: conf.slug, title: "Other" });
    for (const s of [subM, subOther]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-overlap-place", 2);
    for (const p of parts) await p.client.rpc.submissions.star({ slug: conf.slug, id: subM.id });

    const start = Date.now();
    const slotA = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    const slotB = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: start, ends_at: start + 3600_000,
    });
    // An unconference placement occupies Big in the overlapping slotB.
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slotB.id, submission_id: subOther.id, room_id: big.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slotA.id, room_id: small.id, submission_id: subM.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slotA.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.moves).toHaveLength(0);
    const aTracks = await ctx.prisma.trackAssignment.findMany({ where: { slotId: slotA.id } });
    expect(aTracks[0]!.roomId).toBe(small.id);
  });

  test("refit: a double-booked current room is a misfit and gets repaired to a free room", async () => {
    const { owner, conf } = await setupPlannedConf("refit-doublebooked");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const free = await owner.rpc.rooms.create({ slug: conf.slug, name: "Free", capacity: 30 });
    const subM = await owner.rpc.submissions.create({ slug: conf.slug, title: "M" });
    const subOther = await owner.rpc.submissions.create({ slug: conf.slug, title: "Other" });
    for (const s of [subM, subOther]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });

    const start = Date.now();
    const slotA = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    const slotB = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    // Both slots put a talk in Big at the same time: slotA's M is double-booked
    // and must relocate to the empty Free room. setTrack now refuses to create
    // this clash, so seed slotA's Big track directly to model a pre-existing one.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slotB.id, room_id: big.id, submission_id: subOther.id });
    await ctx.prisma.trackAssignment.create({
      data: { slotId: slotA.id, roomId: big.id, submissionId: subM.id },
    });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slotA.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.moves).toEqual([
      { submission_id: subM.id, title: "M", from_room: "Big", to_room: "Free" },
    ]);
    void free;
  });

  test("refit: idempotent — a second run makes no moves and no new notifications", async () => {
    const { owner, conf } = await setupPlannedConf("refit-idem");
    const tiny = await owner.rpc.rooms.create({ slug: conf.slug, name: "Tiny", capacity: 1 });
    const mid = await owner.rpc.rooms.create({ slug: conf.slug, name: "Mid", capacity: 3 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Crowded" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-idem", 3);
    for (const p of parts) await p.client.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: tiny.id, submission_id: sub.id });

    const r1 = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r1.kind !== "ok") throw new Error("expected ok");
    expect(r1.moves).toHaveLength(1);
    void mid;

    const before = scheduleNotes(await parts[0]!.client.rpc.notifications.list({ slug: conf.slug }))
      .reduce((a, i) => a + i.unread_count, 0);
    const r2 = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r2.kind !== "ok") throw new Error("expected ok");
    expect(r2.moves).toHaveLength(0);
    const after = scheduleNotes(await parts[0]!.client.rpc.notifications.list({ slug: conf.slug }))
      .reduce((a, i) => a + i.unread_count, 0);
    expect(after).toBe(before);
  });

  test("scheduleSubmission auto-room skips rooms held by an overlapping slot", async () => {
    const { owner, conf } = await setupPlannedConf("sched-overlap");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
    const held = await owner.rpc.submissions.create({ slug: conf.slug, title: "Held" });
    const auto = await owner.rpc.submissions.create({ slug: conf.slug, title: "Auto" });
    const pinnedSub = await owner.rpc.submissions.create({ slug: conf.slug, title: "PinnedToBig" });
    const filler = await owner.rpc.submissions.create({ slug: conf.slug, title: "Filler" });
    for (const s of [held, auto, pinnedSub, filler]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    await owner.rpc.submissions.update({ slug: conf.slug, id: pinnedSub.id, pre_assigned_room_id: big.id });

    const start = Date.now();
    const slotA = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    const slotB = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    // slotB occupies Big for the shared window.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slotB.id, room_id: big.id, submission_id: held.id });

    // Auto-room in slotA must avoid the overlap-held Big and land in Small.
    const a = await owner.rpc.agenda.scheduleSubmission({ slug: conf.slug, slot_id: slotA.id, submission_id: auto.id });
    expect(a.kind).toBe("ok");
    if (a.kind !== "ok") throw new Error("expected ok");
    expect(a.room_id).toBe(small.id);

    // A pin onto the overlap-held Big is reported as taken.
    const p = await owner.rpc.agenda.scheduleSubmission({ slug: conf.slug, slot_id: slotA.id, submission_id: pinnedSub.id });
    expect(p.kind).toBe("conflict");
    if (p.kind !== "conflict") throw new Error("expected conflict");
    expect(p.reason).toBe("pin_room_taken");
    if (p.reason !== "pin_room_taken") throw new Error("expected pin_room_taken");
    expect(p.pinned_room!.id).toBe(big.id);

    // With Small now taken (by `auto`) and Big overlap-held, nothing is free.
    const f = await owner.rpc.agenda.scheduleSubmission({ slug: conf.slug, slot_id: slotA.id, submission_id: filler.id });
    expect(f.kind).toBe("conflict");
    if (f.kind !== "conflict") throw new Error("expected conflict");
    expect(f.reason).toBe("no_free_room");
  });

  test("refit notifies starrers of moved talks (coalesced with the scheduled event)", async () => {
    const { owner, conf } = await setupPlannedConf("refit-notif");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    // Small holds 1: subA (2 stars) is overfilled there → a genuine misfit.
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 1 });
    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "Alpha" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "Beta" });
    for (const s of [subA, subB]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-notif", 2);
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // subA (overfilled in small) swaps with subB in big → subA moves into big.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: small.id, submission_id: subA.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: big.id, submission_id: subB.id });

    await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });

    const inbox = await parts[0]!.client.rpc.notifications.list({ slug: conf.slug });
    const notes = scheduleNotes(inbox);
    // The "scheduled" and "moved" events coalesce into a single bell row.
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("Alpha moved to Big");
    expect(notes[0]!.unread_count).toBe(2);
    expect(notes[0]!.dedupe_key).toBe(`track:${slot.id}:${subA.id}`);
  });

  test("refit: a mandatory moved track notifies every identity", async () => {
    const { owner, conf } = await setupPlannedConf("refit-mand");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 1 });
    const keynote = await owner.rpc.submissions.create({ slug: conf.slug, title: "Keynote" });
    const filler = await owner.rpc.submissions.create({ slug: conf.slug, title: "Filler" });
    for (const s of [keynote, filler]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    // A bystander who stars nothing — only a mandatory track can reach them.
    const { client: bystander } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "refit-mand-bystander@example.com");
    const parts = await mintParticipants(owner, conf.slug, "refit-mand", 2);
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: filler.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: filler.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // keynote (mandatory, 0 stars) in big; filler (2 stars) in small → refit
    // moves filler into big and keynote into small.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: big.id, submission_id: keynote.id, mandatory: true });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: small.id, submission_id: filler.id });

    await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });

    const inbox = await bystander.rpc.notifications.list({ slug: conf.slug });
    const notes = scheduleNotes(inbox);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("Keynote moved to Small");
    expect(notes[0]!.dedupe_key).toBe(`track:${slot.id}:${keynote.id}`);
  });

  test("setTrack: replace notifies old (removed) + new (scheduled); same-submission edit is silent; clearTrack notifies", async () => {
    const { owner, conf } = await setupPlannedConf("settrack-notif");
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "Hall", capacity: 30 });
    const subOld = await owner.rpc.submissions.create({ slug: conf.slug, title: "Old" });
    const subNew = await owner.rpc.submissions.create({ slug: conf.slug, title: "New" });
    for (const s of [subOld, subNew]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const { client: oldFan } = await inviteAndClaim(ctx.app, owner, conf.slug, "settrack-oldfan@example.com");
    const { client: newFan } = await inviteAndClaim(ctx.app, owner, conf.slug, "settrack-newfan@example.com");
    await oldFan.rpc.submissions.star({ slug: conf.slug, id: subOld.id });
    await newFan.rpc.submissions.star({ slug: conf.slug, id: subNew.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });

    // Schedule subOld → oldFan gets "scheduled".
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: room.id, submission_id: subOld.id });
    let oldNotes = scheduleNotes(await oldFan.rpc.notifications.list({ slug: conf.slug }));
    expect(oldNotes).toHaveLength(1);
    expect(oldNotes[0]!.body).toBe("Old was scheduled in Hall");

    // Same-submission edit (speakers) → NO new notification.
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id, room_id: room.id, submission_id: subOld.id, speakers: "Guest",
    });
    oldNotes = scheduleNotes(await oldFan.rpc.notifications.list({ slug: conf.slug }));
    expect(oldNotes).toHaveLength(1);
    expect(oldNotes[0]!.unread_count).toBe(1);

    // Replace with subNew → oldFan "removed", newFan "scheduled".
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: room.id, submission_id: subNew.id });
    oldNotes = scheduleNotes(await oldFan.rpc.notifications.list({ slug: conf.slug }));
    expect(oldNotes).toHaveLength(1);
    expect(oldNotes[0]!.body).toBe("Old was removed from this time slot");
    expect(oldNotes[0]!.unread_count).toBe(2);

    let newNotes = scheduleNotes(await newFan.rpc.notifications.list({ slug: conf.slug }));
    expect(newNotes).toHaveLength(1);
    expect(newNotes[0]!.body).toBe("New was scheduled in Hall");

    // clearTrack removes subNew → newFan gets "removed".
    await owner.rpc.agenda.clearTrack({ slug: conf.slug, slot_id: slot.id, room_id: room.id });
    newNotes = scheduleNotes(await newFan.rpc.notifications.list({ slug: conf.slug }));
    expect(newNotes).toHaveLength(1);
    expect(newNotes[0]!.body).toBe("New was removed from this time slot");
    expect(newNotes[0]!.unread_count).toBe(2);
  });

  test("placeSubmission room move notifies seated users only", async () => {
    const { owner, conf } = await setupPlannedConf("place-move");
    const roomA = await owner.rpc.rooms.create({ slug: conf.slug, name: "Room A", capacity: 1 });
    const roomB = await owner.rpc.rooms.create({ slug: conf.slug, name: "Room B", capacity: 5 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Session" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const parts = await mintParticipants(owner, conf.slug, "place-move", 2);
    // Both star it, but Room A holds only 1 → exactly one is seated.
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: sub.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: soon(), ends_at: soon(3600_000),
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id, room_id: roomA.id });
    await owner.rpc.agenda.assignAll({ slug: conf.slug });

    const seats = await ctx.prisma.userAssignment.findMany({ where: { slotId: slot.id, submissionId: sub.id } });
    expect(seats).toHaveLength(1);
    const seatedIds = new Set(seats.map((s) => s.userId));

    // Move the placement to Room B.
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id, room_id: roomB.id });

    // Whoever is seated gets exactly one "moved" notification.
    for (const sid of seatedIds) {
      const notifs = await ctx.prisma.notification.findMany({
        where: { identityId: sid, kind: "schedule_changed" },
      });
      expect(notifs).toHaveLength(1);
      expect(notifs[0]!.body).toBe("Session moved to Room B");
      expect(notifs[0]!.dedupeKey).toBe(`track:${slot.id}:${sub.id}`);
    }
    // A starrer who was never seated gets no schedule-change notification.
    for (const p of parts) {
      if (seatedIds.has(p.identityId)) continue;
      const notifs = await ctx.prisma.notification.findMany({
        where: { identityId: p.identityId, kind: "schedule_changed" },
      });
      expect(notifs).toHaveLength(0);
    }
  });

  test("placeSubmission auto-pick skips a room held by an overlapping planned track", async () => {
    const { owner, conf } = await setupPlannedConf("place-overlap-auto");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Session" });
    const holder = await owner.rpc.submissions.create({ slug: conf.slug, title: "Holder" });
    for (const s of [sub, holder]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });

    const start = soon();
    const planned = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    const unconf = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: start, ends_at: start + 3600_000,
    });
    // The planned slot occupies Big during the shared window.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: planned.id, room_id: big.id, submission_id: holder.id });

    // Auto-place into the unconference slot must skip Big and land in Small.
    const r = await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: unconf.id, submission_id: sub.id });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.room_id).toBe(small.id);
  });

  test("placeSubmission explicit room held by an overlapping unconference placement → pin_room_taken", async () => {
    const { owner, conf } = await setupPlannedConf("place-overlap-explicit");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Session" });
    const holder = await owner.rpc.submissions.create({ slug: conf.slug, title: "Holder" });
    for (const s of [sub, holder]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });

    const start = soon();
    const slotA = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: start, ends_at: start + 3600_000,
    });
    const slotB = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: start, ends_at: start + 3600_000,
    });
    // slotB's placement occupies Big during the shared window.
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slotB.id, submission_id: holder.id, room_id: big.id });

    const r = await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slotA.id, submission_id: sub.id, room_id: big.id });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("expected conflict");
    expect(r.reason).toBe("pin_room_taken");
    if (r.reason !== "pin_room_taken") throw new Error("expected pin_room_taken");
    expect(r.pinned_room!.id).toBe(big.id);
    // No placement was written into slotA.
    const placed = await ctx.prisma.unconferencePlacement.findMany({ where: { slotId: slotA.id } });
    expect(placed).toHaveLength(0);
  });

  test("placeSubmission: non-overlapping slots can still share a room", async () => {
    const { owner, conf } = await setupPlannedConf("place-nonoverlap");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Session" });
    const holder = await owner.rpc.submissions.create({ slug: conf.slug, title: "Holder" });
    for (const s of [sub, holder]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });

    const start = soon();
    const slotA = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: start, ends_at: start + 3600_000,
    });
    // slotB starts after slotA ends — no overlap, so Big is fair game for both.
    const slotB = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: start + 3600_000, ends_at: start + 7200_000,
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slotB.id, submission_id: holder.id, room_id: big.id });

    const r = await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slotA.id, submission_id: sub.id, room_id: big.id });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.room_id).toBe(big.id);
  });

  test("setTrack into a room held by an overlapping slot → room_overlap_taken conflict naming the holder, no write", async () => {
    const { owner, conf } = await setupPlannedConf("settrack-overlap");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
    const keynote = await owner.rpc.submissions.create({ slug: conf.slug, title: "Keynote" });
    const talk = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk" });
    for (const s of [keynote, talk]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });

    const start = Date.now();
    const slotB = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    const slotA = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slotB.id, room_id: big.id, submission_id: keynote.id });

    const r = await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slotA.id, room_id: big.id, submission_id: talk.id });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("expected conflict");
    expect(r.reason).toBe("room_overlap_taken");
    if (r.reason !== "room_overlap_taken") throw new Error("expected room_overlap_taken");
    expect(r.holder.title).toBe("Keynote");
    expect(r.holder.room_name).toBe("Big");
    expect(r.holder.slot_label.length).toBeGreaterThan(0);
    // Nothing written into slotA.
    const aTracks = await ctx.prisma.trackAssignment.findMany({ where: { slotId: slotA.id } });
    expect(aTracks).toHaveLength(0);

    // A free room in the same overlapping situation still schedules fine.
    const ok = await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slotA.id, room_id: small.id, submission_id: talk.id });
    expect(ok.kind).toBe("ok");
  });

  test("setTrack: editing a track already in a room is not blocked by its own room", async () => {
    const { owner, conf } = await setupPlannedConf("settrack-inplace");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const mine = await owner.rpc.submissions.create({ slug: conf.slug, title: "Mine" });
    const other = await owner.rpc.submissions.create({ slug: conf.slug, title: "Other" });
    for (const s of [mine, other]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });

    const start = Date.now();
    const slotA = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    const slotB = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: start, ends_at: start + 3600_000,
    });
    // slotA already holds Big.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slotA.id, room_id: big.id, submission_id: mine.id });
    // Simulate a pre-existing overlapping booking of Big by slotB (the guard now
    // prevents creating this via setTrack, so seed it directly).
    await ctx.prisma.trackAssignment.create({
      data: { slotId: slotB.id, roomId: big.id, submissionId: other.id },
    });

    // Editing slotA's own Big track (toggle mandatory) must NOT be blocked.
    const r = await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slotA.id, room_id: big.id, submission_id: mine.id, mandatory: true,
    });
    expect(r.kind).toBe("ok");
    const t = await ctx.prisma.trackAssignment.findFirst({ where: { slotId: slotA.id, roomId: big.id } });
    expect(t!.mandatory).toBe(true);
  });

  test("agenda participant_count: number for mods, null for participants", async () => {
    const { owner, conf } = await setupPlannedConf("pcount");
    const { client: part } = await inviteAndClaim(ctx.app, owner, conf.slug, "pcount-p@example.com");
    const ownerAgenda = await owner.rpc.agenda.get({ slug: conf.slug });
    // Owner identity + one participant = 2.
    expect(ownerAgenda.participant_count).toBe(2);
    const partAgenda = await part.rpc.agenda.get({ slug: conf.slug });
    expect(partAgenda.participant_count).toBeNull();
  });

  test("refit does not flip seatingStale on the slot", async () => {
    const { owner, conf } = await setupPlannedConf("refit-stale");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 1 });
    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "A" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "B" });
    for (const s of [subA, subB]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    // 2 stars overfill the capacity-1 room, so subA is a misfit that moves.
    const parts = await mintParticipants(owner, conf.slug, "refit-stale", 2);
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: small.id, submission_id: subA.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: big.id, submission_id: subB.id });

    await ctx.prisma.agendaSlot.update({ where: { id: slot.id }, data: { seatingStale: false } });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.moves.length).toBeGreaterThan(0);

    const after = await ctx.prisma.agendaSlot.findUniqueOrThrow({
      where: { id: slot.id }, select: { seatingStale: true },
    });
    expect(after.seatingStale).toBe(false);
  });

  test("refit rejects non-planned slots and empty slots", async () => {
    const { owner, conf } = await setupPlannedConf("refit-reject");
    await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 10 });
    const unconf = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", starts_at: soon(), ends_at: soon(3600_000),
    });
    await expect(owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: unconf.id }))
      .rejects.toBeInstanceOf(ORPCError);

    const emptyPlanned = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    await expect(owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: emptyPlanned.id }))
      .rejects.toBeInstanceOf(ORPCError);
  });

  test("refit keeps a track's out-of-scope room in the pool and can reassign it", async () => {
    const { owner, conf } = await setupPlannedConf("refit-union");
    // Restrict the slot's room scope to `inScope`; `outScope` is bigger but not
    // configured for this slot — a track sitting there must not be stranded.
    const inScope = await owner.rpc.rooms.create({ slug: conf.slug, name: "InScope", capacity: 50 });
    const outScope = await owner.rpc.rooms.create({ slug: conf.slug, name: "OutScope", capacity: 1 });
    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "A" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "B" });
    for (const s of [subA, subB]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-union", 2);
    // subA (2 stars) is overfilled in the capacity-1 out-of-scope room → misfit.
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // Narrow the configured scope to `inScope` only (planned slots have no
    // scope UI, so we set it directly the way a restricted config would look).
    await ctx.prisma.agendaSlot.update({ where: { id: slot.id }, data: { unconfUseAllRooms: false } });
    await ctx.prisma.slotRoom.create({ data: { slotId: slot.id, roomId: inScope.id } });

    // subA in the small out-of-scope room; subB in the big in-scope room.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: outScope.id, submission_id: subA.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: inScope.id, submission_id: subB.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    const agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    const byRoom = new Map(agenda.tracks.map((t) => [t.room_id, t.submission_id]));
    // subA (popular) moved into the bigger in-scope room; subB took the
    // out-of-scope room — proving that room stayed in the pool and was reused.
    expect(byRoom.get(inScope.id)).toBe(subA.id);
    expect(byRoom.get(outScope.id)).toBe(subB.id);
    // Both rooms are still occupied — nothing in use was lost.
    expect(agenda.tracks).toHaveLength(2);
  });

  test("refit: two tracks pinned to the same room → pin_room_taken conflict + zero writes", async () => {
    const { owner, conf } = await setupPlannedConf("refit-pintaken");
    const r1 = await owner.rpc.rooms.create({ slug: conf.slug, name: "R1", capacity: 30 });
    const r2 = await owner.rpc.rooms.create({ slug: conf.slug, name: "R2", capacity: 20 });
    const subP1 = await owner.rpc.submissions.create({ slug: conf.slug, title: "Pinned One" });
    const subP2 = await owner.rpc.submissions.create({ slug: conf.slug, title: "Pinned Two" });
    for (const s of [subP1, subP2]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    // Both pin the SAME room (R1).
    await owner.rpc.submissions.update({ slug: conf.slug, id: subP1.id, pre_assigned_room_id: r1.id });
    await owner.rpc.submissions.update({ slug: conf.slug, id: subP2.id, pre_assigned_room_id: r1.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // Seed them in distinct rooms (can't both start in R1 — unique constraint).
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: r1.id, submission_id: subP1.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: r2.id, submission_id: subP2.id });

    const before = await owner.rpc.agenda.get({ slug: conf.slug });
    const beforeMap = new Map(before.tracks.map((t) => [t.submission_id, t.room_id]));

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("expected conflict");
    expect(r.reason).toBe("pin_room_taken");
    if (r.reason !== "pin_room_taken") throw new Error("expected pin_room_taken");
    expect(r.pinned_room!.id).toBe(r1.id);
    // The conflict names one of the two clashing submissions.
    expect([subP1.id, subP2.id]).toContain(r.submission!.id);

    // Zero writes: tracks unchanged.
    const after = await owner.rpc.agenda.get({ slug: conf.slug });
    const afterMap = new Map(after.tracks.map((t) => [t.submission_id, t.room_id]));
    expect(afterMap).toEqual(beforeMap);
  });

  test("refit notifies the submission's submitter even though they never starred it", async () => {
    const { owner, conf } = await setupPlannedConf("refit-submitter");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 1 });
    // `author` writes the talk (becomes its submitter) but never stars it.
    const { client: author, identity_id: authorId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "refit-submitter-author@example.com");
    const subA = await author.rpc.submissions.create({ slug: conf.slug, title: "Authored" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "Other" });
    for (const s of [subA, subB]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    // Other participants star subA so it sorts to the biggest room on refit —
    // the author themselves does NOT star it.
    const fans = await mintParticipants(owner, conf.slug, "refit-submitter", 2);
    await fans[0]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await fans[1]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // subA in the small room; refit moves it into big.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: small.id, submission_id: subA.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: big.id, submission_id: subB.id });

    await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });

    const authorNotes = await ctx.prisma.notification.findMany({
      where: { identityId: authorId, kind: "schedule_changed" },
    });
    expect(authorNotes).toHaveLength(1);
    expect(authorNotes[0]!.body).toBe("Authored moved to Big");
    expect(authorNotes[0]!.dedupeKey).toBe(`track:${slot.id}:${subA.id}`);
  });

  test("planned-track ICS UID is stable across a refit (keyed on slot+submission)", async () => {
    const { owner, conf } = await setupPlannedConf("refit-uid");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 1 });
    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "Alpha" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "Beta" });
    for (const s of [subA, subB]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    // Owner is the submitter → the planned tracks derive onto the owner's feed.
    const parts = await mintParticipants(owner, conf.slug, "refit-uid", 2);
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: small.id, submission_id: subA.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: big.id, submission_id: subB.id });

    const { token } = await owner.rpc.conferences.getCalendar({ slug: conf.slug });
    const anon = new Client(ctx.app);
    const uidsBefore = (await (await anon.get(`/api/calendar/${token}.ics`)).text())
      .split("\r\n").filter((l) => l.startsWith("UID:static-"));
    expect(uidsBefore.length).toBe(2);

    // Refit changes track ids (delete + recreate) but must NOT change the UIDs.
    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.moves.length).toBeGreaterThan(0);

    const uidsAfter = (await (await anon.get(`/api/calendar/${token}.ics`)).text())
      .split("\r\n").filter((l) => l.startsWith("UID:static-"));
    expect(new Set(uidsAfter)).toEqual(new Set(uidsBefore));
  });
});
