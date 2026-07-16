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
    expect(link.url).toContain(`/#/board/${conf.slug}`);

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
