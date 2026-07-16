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

  test("refit: biggest room to most-starred; requirements survive; idempotent", async () => {
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

  test("refit honors a pin: a less-starred pinned track keeps its room", async () => {
    const { owner, conf } = await setupPlannedConf("refit-pin");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
    const pinned = await owner.rpc.submissions.create({ slug: conf.slug, title: "Pinned" });
    const hot = await owner.rpc.submissions.create({ slug: conf.slug, title: "Hot" });
    for (const s of [pinned, hot]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    await owner.rpc.submissions.update({ slug: conf.slug, id: pinned.id, pre_assigned_room_id: big.id });

    const parts = await mintParticipants(owner, conf.slug, "refit-pin", 2);
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: hot.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: hot.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // Start reversed: pinned→small, hot→big.
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: small.id, submission_id: pinned.id });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: big.id, submission_id: hot.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    const agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    const byRoom = new Map(agenda.tracks.map((t) => [t.room_id, t.submission_id]));
    // The pin wins the big room even though `hot` has more stars.
    expect(byRoom.get(big.id)).toBe(pinned.id);
    expect(byRoom.get(small.id)).toBe(hot.id);
  });

  test("refit places a tagged track only into a satisfying room", async () => {
    const { owner, conf } = await setupPlannedConf("refit-req");
    const bigPlain = await owner.rpc.rooms.create({ slug: conf.slug, name: "BigPlain", capacity: 50 });
    const studio = await owner.rpc.rooms.create({ slug: conf.slug, name: "Studio", capacity: 10, tags: ["projector"] });
    const plain = await owner.rpc.submissions.create({ slug: conf.slug, title: "Plain talk" });
    const proj = await owner.rpc.submissions.create({ slug: conf.slug, title: "Needs projector" });
    for (const s of [plain, proj]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-req", 2);
    // `plain` is more popular and would grab the big room; `proj` must still
    // land in the only projector room.
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: plain.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: plain.id });
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: proj.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id, room_id: bigPlain.id,
      submission_id: proj.id, requirements: ["projector"],
    });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: studio.id, submission_id: plain.id });

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    const agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    const byRoom = new Map(agenda.tracks.map((t) => [t.room_id, t.submission_id]));
    expect(byRoom.get(studio.id)).toBe(proj.id);
    expect(byRoom.get(bigPlain.id)).toBe(plain.id);
  });

  test("refit unsatisfiable requirement → conflict + zero writes", async () => {
    const { owner, conf } = await setupPlannedConf("refit-unsat");
    const studio = await owner.rpc.rooms.create({ slug: conf.slug, name: "Studio", capacity: 20, tags: ["projector"] });
    const plain = await owner.rpc.rooms.create({ slug: conf.slug, name: "Plain", capacity: 10 });
    const subX = await owner.rpc.submissions.create({ slug: conf.slug, title: "X" });
    const subY = await owner.rpc.submissions.create({ slug: conf.slug, title: "Y" });
    for (const s of [subX, subY]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // Both require projector; only one projector room exists → one is unplaceable.
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id, room_id: studio.id, submission_id: subX.id, requirements: ["projector"],
    });
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id, room_id: plain.id, submission_id: subY.id, requirements: ["projector"],
    });

    const before = await owner.rpc.agenda.get({ slug: conf.slug });
    const beforeMap = new Map(before.tracks.map((t) => [t.submission_id, t.room_id]));

    const r = await owner.rpc.agenda.refitRooms({ slug: conf.slug, slot_id: slot.id });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("expected conflict");
    expect(r.reason).toBe("unsatisfiable_requirements");
    expect(r.required_tags).toEqual(["projector"]);
    expect(r.candidate_room_names).toEqual(["Studio"]);
    expect(r.submission!.id).toBe(subY.id);

    // No writes happened — track rooms are exactly as before.
    const after = await owner.rpc.agenda.get({ slug: conf.slug });
    const afterMap = new Map(after.tracks.map((t) => [t.submission_id, t.room_id]));
    expect(afterMap).toEqual(beforeMap);
  });

  test("refit notifies starrers of moved talks (coalesced with the scheduled event)", async () => {
    const { owner, conf } = await setupPlannedConf("refit-notif");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 30 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "Alpha" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "Beta" });
    for (const s of [subA, subB]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-notif", 2);
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await parts[1]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // subA in the small room, subB in big → refit moves subA into big.
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
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
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
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "A" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "B" });
    for (const s of [subA, subB]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-stale", 1);
    await parts[0]!.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });

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
    const outScope = await owner.rpc.rooms.create({ slug: conf.slug, name: "OutScope", capacity: 10 });
    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "A" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "B" });
    for (const s of [subA, subB]) await owner.rpc.submissions.publish({ slug: conf.slug, id: s.id });
    const parts = await mintParticipants(owner, conf.slug, "refit-union", 2);
    // subA is the popular one; it should claim the biggest available room.
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
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
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
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });
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
