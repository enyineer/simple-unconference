// Event Experience Suite — W1 server foundations.
//
// Covers the Live Board payload + SSE, Pitch Mode spotlight, the day-of
// broadcast, and the `agenda.changed` bus fan-out. Each describe block gets its
// own temp DB via setupTestApp().

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  setupTestApp, Client, ORPCError, type TestApp,
  inviteAndClaim,
} from "./test-helpers";
import {
  __resetBusForTests, getBus, boardTopicKey, publishAgendaChanged,
  type BusEvent,
} from "./realtime/bus";
import type { BoardPayloadOut } from "../shared/contract/types";
import { startOfDayInstant } from "../shared/tz";
import { LIMITS } from "./lib/limits";

// Seating / board-relevant slots live in the near future (mirrors the other
// suites' convention).
function soon(offsetMs = 0): number {
  return Date.now() + 24 * 60 * 60 * 1000 + offsetMs;
}

let ctx: TestApp;

async function makeOwnerConf(prefix: string) {
  const owner = new Client(ctx.app);
  await owner.rpc.auth.signup({ email: `${prefix}-owner@example.com`, password: "secret123", name: "Owner" });
  const conf = await owner.rpc.conferences.create({ name: `Conf ${prefix}` });
  return { owner, conf };
}

describe("Live Board payload + link", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("valid token returns a public-safe payload with titles + names but no emails", async () => {
    const { owner, conf } = await makeOwnerConf("board");
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "Aula", capacity: 40 });

    // A participant submits a session so the payload carries a distinct
    // submitter email that MUST NOT leak into the public board.
    const partEmail = "board-speaker@example.com";
    const { client: part } = await inviteAndClaim(ctx.app, owner, conf.slug, partEmail, "secret123", "Ada Speaker");
    const sub = await part.rpc.submissions.create({ slug: conf.slug, title: "Distributed Systems 101" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    // Plan the session into the room, and spotlight it.
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", title: "Morning", starts_at: soon(), ends_at: soon(3600_000),
    });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: slot.id, room_id: room.id, submission_id: sub.id });
    await owner.rpc.agenda.spotlight({ slug: conf.slug, submission_id: sub.id });

    const link = await owner.rpc.conferences.setBoardLink({ slug: conf.slug, enabled: true });
    expect(link.enabled).toBe(true);
    expect(link.token).toBeTruthy();
    // Relative server path (like joinUrl); the web client prepends `${origin}`.
    expect(link.url).toBe(`/board/${conf.slug}?t=${link.token}`);

    // The board is PUBLIC — fetch it with a cookieless client.
    const anon = new Client(ctx.app);
    const res = await anon.get(`/api/board/${conf.slug}?t=${link.token}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as BoardPayloadOut;

    expect(payload.name).toBe(conf.name);
    expect(payload.rooms).toHaveLength(1);
    expect(payload.rooms[0]!.name).toBe("Aula");
    expect(payload.slots).toHaveLength(1);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]!.title).toBe("Distributed Systems 101");
    expect(payload.entries[0]!.submitter_name).toBe("Ada Speaker");
    expect(payload.entries[0]!.planned).toBe(true);
    expect(payload.spotlight?.title).toBe("Distributed Systems 101");
    expect(payload.spotlight?.submitter_name).toBe("Ada Speaker");

    // The whole serialized payload must be free of any participant email.
    const asString = JSON.stringify(payload);
    expect(asString).not.toContain(partEmail);
    expect(asString).not.toContain("@example.com");
  });

  test("wrong token, absent token, and disabled board all 404 (existence not leaked)", async () => {
    const { owner, conf } = await makeOwnerConf("board404");
    const anon = new Client(ctx.app);

    // Board disabled by default → 404 even with a made-up token.
    expect((await anon.get(`/api/board/${conf.slug}?t=deadbeef`)).status).toBe(404);

    const link = await owner.rpc.conferences.setBoardLink({ slug: conf.slug, enabled: true });
    // Absent token → 404.
    expect((await anon.get(`/api/board/${conf.slug}`)).status).toBe(404);
    // Wrong token → 404.
    expect((await anon.get(`/api/board/${conf.slug}?t=not-the-token`)).status).toBe(404);
    // Correct token → 200.
    expect((await anon.get(`/api/board/${conf.slug}?t=${link.token}`)).status).toBe(200);

    // Disabling clears the token → the old URL 404s again.
    await owner.rpc.conferences.setBoardLink({ slug: conf.slug, enabled: false });
    expect((await anon.get(`/api/board/${conf.slug}?t=${link.token}`)).status).toBe(404);
  });

  test("rotate mints a new token and invalidates the old link", async () => {
    const { owner, conf } = await makeOwnerConf("boardrotate");
    const anon = new Client(ctx.app);
    const first = await owner.rpc.conferences.setBoardLink({ slug: conf.slug, enabled: true });
    expect((await anon.get(`/api/board/${conf.slug}?t=${first.token}`)).status).toBe(200);

    const rotated = await owner.rpc.conferences.rotateBoardLink({ slug: conf.slug });
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.enabled).toBe(true);
    // Old token dead, new token live.
    expect((await anon.get(`/api/board/${conf.slug}?t=${first.token}`)).status).toBe(404);
    expect((await anon.get(`/api/board/${conf.slug}?t=${rotated.token}`)).status).toBe(200);
  });

  test("a non-owner cannot manage the board link (owner-only gate)", async () => {
    const { owner, conf } = await makeOwnerConf("boardauth");
    const { client: part } = await inviteAndClaim(ctx.app, owner, conf.slug, "board-part@example.com");
    await expect(part.rpc.conferences.getBoardLink({ slug: conf.slug })).rejects.toBeInstanceOf(ORPCError);
    await expect(part.rpc.conferences.setBoardLink({ slug: conf.slug, enabled: true })).rejects.toBeInstanceOf(ORPCError);
  });
});

describe("Pitch Mode spotlight", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("mod sets then clears the spotlight; it persists on the conference row", async () => {
    const { owner, conf } = await makeOwnerConf("spot");
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Keynote" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    await owner.rpc.agenda.spotlight({ slug: conf.slug, submission_id: sub.id });
    let row = await ctx.prisma.conference.findUniqueOrThrow({
      where: { id: conf.id }, select: { spotlightSubmissionId: true },
    });
    expect(row.spotlightSubmissionId).toBe(sub.id);

    await owner.rpc.agenda.spotlight({ slug: conf.slug, submission_id: null });
    row = await ctx.prisma.conference.findUniqueOrThrow({
      where: { id: conf.id }, select: { spotlightSubmissionId: true },
    });
    expect(row.spotlightSubmissionId).toBeNull();
  });

  test("spotlighting an unpublished submission is rejected", async () => {
    const { owner, conf } = await makeOwnerConf("spotdraft");
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Draft" });
    await expect(
      owner.rpc.agenda.spotlight({ slug: conf.slug, submission_id: sub.id }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("a participant cannot set the spotlight", async () => {
    const { owner, conf } = await makeOwnerConf("spotauth");
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const { client: part } = await inviteAndClaim(ctx.app, owner, conf.slug, "spot-part@example.com");
    await expect(
      part.rpc.agenda.spotlight({ slug: conf.slug, submission_id: sub.id }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("unpublishing a spotlighted session hides it from the public board", async () => {
    const { owner, conf } = await makeOwnerConf("spothide");
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Ephemeral" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    await owner.rpc.agenda.spotlight({ slug: conf.slug, submission_id: sub.id });
    const link = await owner.rpc.conferences.setBoardLink({ slug: conf.slug, enabled: true });

    const anon = new Client(ctx.app);
    let payload = (await (await anon.get(`/api/board/${conf.slug}?t=${link.token}`)).json()) as BoardPayloadOut;
    expect(payload.spotlight?.title).toBe("Ephemeral");

    await owner.rpc.submissions.unpublish({ slug: conf.slug, id: sub.id });
    payload = (await (await anon.get(`/api/board/${conf.slug}?t=${link.token}`)).json()) as BoardPayloadOut;
    expect(payload.spotlight).toBeNull();
  });
});

describe("Broadcast (announcements.send)", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("a mod broadcast reaches every conference identity exactly once", async () => {
    const { owner, conf } = await makeOwnerConf("bcast");
    const p1 = await inviteAndClaim(ctx.app, owner, conf.slug, "bcast-p1@example.com");
    const p2 = await inviteAndClaim(ctx.app, owner, conf.slug, "bcast-p2@example.com");

    await owner.rpc.announcements.send({ slug: conf.slug, message: "Lunch is served in the atrium." });

    const identityCount = await ctx.prisma.conferenceIdentity.count({ where: { conferenceId: conf.id } });
    const announcementCount = await ctx.prisma.notification.count({
      where: { identity: { conferenceId: conf.id }, kind: "announcement" },
    });
    expect(announcementCount).toBe(identityCount);

    // Each participant sees exactly one announcement with the sent body.
    for (const p of [p1, p2]) {
      const inbox = await p.client.rpc.notifications.list({ slug: conf.slug });
      const anns = inbox.items.filter((i) => i.kind === "announcement");
      expect(anns).toHaveLength(1);
      expect(anns[0]!.title).toBe("Announcement");
      expect(anns[0]!.body).toBe("Lunch is served in the atrium.");
    }
  });

  test("a 301-character message is rejected", async () => {
    const { owner, conf } = await makeOwnerConf("bcastlong");
    await expect(
      owner.rpc.announcements.send({ slug: conf.slug, message: "x".repeat(301) }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("a participant cannot broadcast", async () => {
    const { owner, conf } = await makeOwnerConf("bcastauth");
    const { client: part } = await inviteAndClaim(ctx.app, owner, conf.slug, "bcast-part@example.com");
    await expect(
      part.rpc.announcements.send({ slug: conf.slug, message: "hi" }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe("agenda.changed bus fan-out", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("a star toggle and a placement both publish agenda.changed for the conference", async () => {
    __resetBusForTests();
    const bus = getBus();
    const { owner, conf } = await makeOwnerConf("changed");

    // Capture events on this conference's board topic key.
    const events: BusEvent[] = [];
    const off = bus.subscribe(boardTopicKey(conf.id), (e) => events.push(e));

    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Popular" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    // Star toggle (participant) → agenda.changed (drives live counts).
    const { client: part } = await inviteAndClaim(ctx.app, owner, conf.slug, "changed-p@example.com");
    events.length = 0;
    await part.rpc.submissions.star({ slug: conf.slug, id: sub.id });
    expect(events.some((e) => e.kind === "agenda.changed" && "conferenceId" in e && e.conferenceId === conf.id)).toBe(true);

    // Placement (mod) → agenda.changed.
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 10 });
    void room;
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", title: "Unconf", starts_at: soon(), ends_at: soon(3600_000),
    });
    events.length = 0;
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: slot.id, submission_id: sub.id });
    expect(events.some((e) => e.kind === "agenda.changed" && "conferenceId" in e && e.conferenceId === conf.id)).toBe(true);

    off();
  });

  test("spotlight publishes both board.spotlight and agenda.changed", async () => {
    __resetBusForTests();
    const bus = getBus();
    const { owner, conf } = await makeOwnerConf("changedspot");
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Pitch" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    const events: BusEvent[] = [];
    const off = bus.subscribe(boardTopicKey(conf.id), (e) => events.push(e));
    await owner.rpc.agenda.spotlight({ slug: conf.slug, submission_id: sub.id });
    expect(events.some((e) => e.kind === "board.spotlight" && "submissionId" in e && e.submissionId === sub.id)).toBe(true);
    expect(events.some((e) => e.kind === "agenda.changed")).toBe(true);
    off();
  });
});

describe("Live Board SSE stream", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("valid token opens the stream and forwards agenda.changed; bad token 404s", async () => {
    __resetBusForTests();
    const { owner, conf } = await makeOwnerConf("sse");
    const link = await owner.rpc.conferences.setBoardLink({ slug: conf.slug, enabled: true });

    const anon = new Client(ctx.app);
    // Bad token → 404, no stream.
    expect((await anon.get(`/api/board/${conf.slug}/stream?t=wrong`)).status).toBe(404);

    const res = await anon.get(`/api/board/${conf.slug}/stream?t=${link.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // First chunk is the immediate `:hello` comment.
    const hello = await reader.read();
    expect(decoder.decode(hello.value)).toContain(":hello");

    // Publish an agenda change and confirm it's forwarded on the stream.
    publishAgendaChanged(conf.id);
    const next = await reader.read();
    const frame = decoder.decode(next.value);
    expect(frame).toContain("event: agenda.changed");
    expect(frame).toContain(`"conferenceId":${conf.id}`);

    await reader.cancel();
  });
});

describe("Takeaways (Harvest & Wrap-up)", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  async function seed(prefix: string) {
    const { owner, conf } = await makeOwnerConf(prefix);
    const { client: p1 } = await inviteAndClaim(ctx.app, owner, conf.slug, `${prefix}-p1@example.com`, "secret123", "Ada");
    const { client: p2 } = await inviteAndClaim(ctx.app, owner, conf.slug, `${prefix}-p2@example.com`, "secret123", "Bo");
    const sub = await p1.rpc.submissions.create({ slug: conf.slug, title: "Session" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    return { owner, conf, p1, p2, sub };
  }

  test("add + list returns author display name + mine flag, never emails", async () => {
    const { conf, p1, p2, sub } = await seed("tk");
    const added = await p1.rpc.takeaways.add({
      slug: conf.slug, submission_id: sub.id, text: "Great notes", url: "https://example.org/x",
    });
    expect(added.author_name).toBe("Ada");
    expect(added.mine).toBe(true);
    expect(added.url).toBe("https://example.org/x");

    // p2 sees the takeaway as not-theirs; author name present, no email leaks.
    const list2 = await p2.rpc.takeaways.list({ slug: conf.slug, submission_id: sub.id });
    expect(list2).toHaveLength(1);
    expect(list2[0]!.author_name).toBe("Ada");
    expect(list2[0]!.mine).toBe(false);
    expect(JSON.stringify(list2)).not.toContain("@example.com");

    // p1 sees mine=true on their own row.
    const list1 = await p1.rpc.takeaways.list({ slug: conf.slug, submission_id: sub.id });
    expect(list1[0]!.mine).toBe(true);
  });

  test("a 501-character takeaway is rejected", async () => {
    const { conf, p1, sub } = await seed("tklong");
    await expect(
      p1.rpc.takeaways.add({ slug: conf.slug, submission_id: sub.id, text: "x".repeat(501) }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("the 11th takeaway by one identity on a session is rejected", async () => {
    const { conf, p1, sub } = await seed("tkcap");
    for (let i = 0; i < 10; i++) {
      await p1.rpc.takeaways.add({ slug: conf.slug, submission_id: sub.id, text: `note ${i}` });
    }
    await expect(
      p1.rpc.takeaways.add({ slug: conf.slug, submission_id: sub.id, text: "one too many" }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("author deletes own; a participant can't delete another's but a mod can", async () => {
    const { owner, conf, p1, p2, sub } = await seed("tkdel");
    const a = await p1.rpc.takeaways.add({ slug: conf.slug, submission_id: sub.id, text: "mine to remove" });
    // A different participant cannot delete it.
    await expect(
      p2.rpc.takeaways.remove({ slug: conf.slug, id: a.id }),
    ).rejects.toBeInstanceOf(ORPCError);
    // The author can.
    await p1.rpc.takeaways.remove({ slug: conf.slug, id: a.id });
    expect(await p1.rpc.takeaways.list({ slug: conf.slug, submission_id: sub.id })).toHaveLength(0);

    // A moderator can delete anyone's.
    const b = await p2.rpc.takeaways.add({ slug: conf.slug, submission_id: sub.id, text: "mod removes this" });
    await owner.rpc.takeaways.remove({ slug: conf.slug, id: b.id });
    expect(await p1.rpc.takeaways.list({ slug: conf.slug, submission_id: sub.id })).toHaveLength(0);
  });

  test("adding a takeaway to an unpublished session is rejected", async () => {
    const { owner, conf } = await makeOwnerConf("tkdraft");
    const { client: p1 } = await inviteAndClaim(ctx.app, owner, conf.slug, "tkdraft-p@example.com");
    const sub = await p1.rpc.submissions.create({ slug: conf.slug, title: "Draft" });
    await expect(
      p1.rpc.takeaways.add({ slug: conf.slug, submission_id: sub.id, text: "too soon" }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe("Event report (conferences.report)", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("aggregates participants, sessions, seats, stars, top ordering, takeaways", async () => {
    const { owner, conf } = await makeOwnerConf("rep");
    const big = await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 100 });
    const small = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });

    const p1 = await inviteAndClaim(ctx.app, owner, conf.slug, "rep-p1@example.com", "secret123", "Ada");
    const p2 = await inviteAndClaim(ctx.app, owner, conf.slug, "rep-p2@example.com", "secret123", "Bo");

    const subA = await p1.client.rpc.submissions.create({ slug: conf.slug, title: "Popular" });
    const subB = await p1.client.rpc.submissions.create({ slug: conf.slug, title: "Quiet" });
    await p2.client.rpc.submissions.create({ slug: conf.slug, title: "Draft" }); // stays submitted
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });

    // Stars: A gets 2, B gets 1 → total 3.
    await p1.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await p2.client.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await p1.client.rpc.submissions.star({ slug: conf.slug, id: subB.id });

    // A: unconference placement in Big. B: planned track in Small.
    const unconf = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference", title: "Unconf", starts_at: soon(), ends_at: soon(3600_000),
    });
    await owner.rpc.agenda.placeSubmission({ slug: conf.slug, slot_id: unconf.id, submission_id: subA.id, room_id: big.id });
    const planned = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", title: "Planned", starts_at: soon(7200_000), ends_at: soon(10800_000),
    });
    await owner.rpc.agenda.setTrack({ slug: conf.slug, slot_id: planned.id, room_id: small.id, submission_id: subB.id });

    // Seats: two attendees seated into the unconference slot (subA/Big).
    await ctx.prisma.userAssignment.createMany({
      data: [
        { slotId: unconf.id, userId: p1.identity_id, submissionId: subA.id, roomId: big.id },
        { slotId: unconf.id, userId: p2.identity_id, submissionId: subA.id, roomId: big.id },
      ],
    });

    // Takeaways: 2 on A, 1 on B → 3.
    await p1.client.rpc.takeaways.add({ slug: conf.slug, submission_id: subA.id, text: "a1" });
    await p2.client.rpc.takeaways.add({ slug: conf.slug, submission_id: subA.id, text: "a2" });
    await p1.client.rpc.takeaways.add({ slug: conf.slug, submission_id: subB.id, text: "b1" });

    const report = await owner.rpc.conferences.report({ slug: conf.slug });

    const identityCount = await ctx.prisma.conferenceIdentity.count({ where: { conferenceId: conf.id } });
    expect(report.participant_count).toBe(identityCount);
    expect(report.sessions.submitted).toBe(3);
    expect(report.sessions.published).toBe(2);
    expect(report.sessions.placed_or_scheduled).toBe(2);
    expect(report.seats_filled).toBe(2);
    expect(report.stars_total).toBe(3);

    expect(report.top_sessions).toHaveLength(2);
    expect(report.top_sessions[0]).toEqual({ title: "Popular", star_count: 2, submitter_name: "Ada" });
    expect(report.top_sessions[1]).toEqual({ title: "Quiet", star_count: 1, submitter_name: "Ada" });

    // Rooms sorted capacity desc; each hosts one slot; 2 total slots in the conference.
    expect(report.rooms).toHaveLength(2);
    const bigOut = report.rooms.find((r) => r.name === "Big")!;
    const smallOut = report.rooms.find((r) => r.name === "Small")!;
    expect(bigOut.used_slots).toBe(1);
    expect(smallOut.used_slots).toBe(1);
    expect(bigOut.available_slots).toBe(2);

    expect(report.expert_bookings_count).toBe(0);
    expect(report.takeaway_count).toBe(3);
    expect(report.generated_at).toBeGreaterThan(0);

    // No emails anywhere in the report payload.
    expect(JSON.stringify(report)).not.toContain("@example.com");
  });

  test("a participant cannot pull the report", async () => {
    const { owner, conf } = await makeOwnerConf("repauth");
    const { client: part } = await inviteAndClaim(ctx.app, owner, conf.slug, "rep-part@example.com");
    await expect(part.rpc.conferences.report({ slug: conf.slug })).rejects.toBeInstanceOf(ORPCError);
  });
});

describe("Duplicate conference (conferences.duplicate)", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("owner clones config + rooms + slot skeleton with times shifted; no identities/submissions/tokens", async () => {
    const { owner, conf } = await makeOwnerConf("dup");
    // Non-default config so the copy is observable.
    await owner.rpc.conferences.update({
      slug: conf.slug,
      design_system: "minimal",
      mixer_avoid_repeats_default: false,
      submission_max_placements_default: 3,
      participant_submissions_enabled: false,
    });

    // Rooms with tags + an availability window (Jan 1 2026, UTC).
    const dayStart = Date.UTC(2026, 0, 1, 8, 0);
    const dayEnd = Date.UTC(2026, 0, 1, 18, 0);
    await owner.rpc.rooms.create({
      slug: conf.slug, name: "Main", capacity: 50, tags: ["projector"],
      availability: [{ starts_at: dayStart, ends_at: dayEnd }],
    });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "Side", capacity: 20 });

    // Two slots on Jan 1.
    const slot1Start = Date.UTC(2026, 0, 1, 9, 0);
    const slot1End = Date.UTC(2026, 0, 1, 10, 0);
    const slot2Start = Date.UTC(2026, 0, 1, 14, 0);
    const slot2End = Date.UTC(2026, 0, 1, 15, 0);
    await owner.rpc.agenda.createSlot({ slug: conf.slug, type: "normal", title: "Morning", starts_at: slot1Start, ends_at: slot1End });
    await owner.rpc.agenda.createSlot({ slug: conf.slug, type: "unconference", title: "Afternoon", starts_at: slot2Start, ends_at: slot2End });

    // Source has a participant + a submission — neither should reach the clone.
    // (Owner submits, since participant submissions were disabled above.)
    await inviteAndClaim(ctx.app, owner, conf.slug, "dup-p@example.com");
    const sub = await owner.rpc.submissions.create({ slug: conf.slug, title: "Source Talk" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    // Duplicate onto June 10 2026 (midnight UTC).
    const firstDay = Date.UTC(2026, 5, 10, 0, 0);
    const { slug: newSlug } = await owner.rpc.conferences.duplicate({
      slug: conf.slug, name: "Cloned Event", first_day: firstDay,
    });
    expect(newSlug).not.toBe(conf.slug);

    const clone = await ctx.prisma.conference.findUniqueOrThrow({ where: { slug: newSlug } });
    // Config copied.
    expect(clone.designSystem).toBe("minimal");
    expect(clone.timezone).toBe("UTC");
    expect(clone.mixerAvoidRepeatsDefault).toBe(false);
    expect(clone.submissionMaxPlacementsDefault).toBe(3);
    expect(clone.participantSubmissionsEnabled).toBe(false);
    expect(clone.ownerId).toBe(conf.owner_id);
    // Tokens / spotlight NOT copied.
    expect(clone.boardToken).toBeNull();
    expect(clone.spotlightSubmissionId).toBeNull();

    const delta = startOfDayInstant(firstDay, "UTC") - startOfDayInstant(slot1Start, "UTC");

    // Slots shifted by delta; seating reset.
    const cloneSlots = await ctx.prisma.agendaSlot.findMany({
      where: { conferenceId: clone.id }, orderBy: { startsAt: "asc" },
    });
    expect(cloneSlots).toHaveLength(2);
    expect(cloneSlots[0]!.startsAt.getTime()).toBe(slot1Start + delta);
    expect(cloneSlots[0]!.endsAt.getTime()).toBe(slot1End + delta);
    expect(cloneSlots[1]!.startsAt.getTime()).toBe(slot2Start + delta);
    expect(cloneSlots[1]!.endsAt.getTime()).toBe(slot2End + delta);
    expect(cloneSlots.every((s) => s.seatingStale === false)).toBe(true);

    // Rooms cloned with tags + availability shifted by the same delta.
    const cloneRooms = await ctx.prisma.room.findMany({
      where: { conferenceId: clone.id }, include: { tags: true, availabilities: true },
    });
    expect(cloneRooms.map((r) => r.name).sort()).toEqual(["Main", "Side"]);
    const cloneMain = cloneRooms.find((r) => r.name === "Main")!;
    expect(cloneMain.tags.map((t) => t.value)).toEqual(["projector"]);
    expect(cloneMain.availabilities).toHaveLength(1);
    expect(cloneMain.availabilities[0]!.startsAt.getTime()).toBe(dayStart + delta);
    expect(cloneMain.availabilities[0]!.endsAt.getTime()).toBe(dayEnd + delta);

    // No identities, submissions, tracks, placements, or join link in the clone.
    expect(await ctx.prisma.conferenceIdentity.count({ where: { conferenceId: clone.id } })).toBe(0);
    expect(await ctx.prisma.submission.count({ where: { conferenceId: clone.id } })).toBe(0);
    expect(await ctx.prisma.trackAssignment.count({ where: { slot: { conferenceId: clone.id } } })).toBe(0);
    expect(await ctx.prisma.unconferencePlacement.count({ where: { slot: { conferenceId: clone.id } } })).toBe(0);
    expect(await ctx.prisma.conferenceJoinLink.findUnique({ where: { conferenceId: clone.id } })).toBeNull();
  });

  test("a non-owner cannot duplicate", async () => {
    const { owner, conf } = await makeOwnerConf("dupauth");
    const { client: part } = await inviteAndClaim(ctx.app, owner, conf.slug, "dupauth-p@example.com");
    await expect(
      part.rpc.conferences.duplicate({ slug: conf.slug, name: "Nope", first_day: Date.UTC(2026, 5, 10) }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("respects the per-user conference quota", async () => {
    const cap = LIMITS.maxConferencesPerUser;
    if (cap === 0) return; // unlimited: nothing to assert
    const { owner, conf } = await makeOwnerConf("dupquota");
    // makeOwnerConf already created 1 conference for this owner; fill to the cap.
    for (let i = 1; i < cap; i++) {
      await owner.rpc.conferences.create({ name: `Filler ${i}` });
    }
    await expect(
      owner.rpc.conferences.duplicate({ slug: conf.slug, name: "Over Cap", first_day: Date.UTC(2026, 5, 10) }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});
