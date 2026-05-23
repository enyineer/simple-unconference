// End-to-end tests for chat.* and moderation.* (plans/chat.md Phases 4 + 8).
// Real Prisma + temp SQLite per describe block. Cookies + identities are
// minted via the standard test-helpers wrappers; chat-specific setup helpers
// at the bottom of this file.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  setupTestApp, ORPCError, type TestApp,
  inviteAndClaim, createOwner,
} from "../test-helpers";
import { __resetBusForTests, getBus, type BusEvent } from "../realtime/bus";

// Helper: spin up a fresh conference + two published participants. `tag` is
// woven into emails so a single TestApp (one DB per describe) can host many
// independent setups without unique-email collisions.
async function setupTwoPublishedParticipants(ctx: TestApp, tag: string) {
  const owner = await createOwner(ctx.app, `${tag}-owner@example.com`, "secret123", "Owner");
  const conf = await owner.rpc.conferences.create({ name: `Chat Test ${tag}` });
  const a = await inviteAndClaim(ctx.app, owner, conf.slug, `${tag}-alice@example.com`, "secret123", "Alice");
  const b = await inviteAndClaim(ctx.app, owner, conf.slug, `${tag}-bob@example.com`, "secret123", "Bob");
  // Publish both profiles so canChatWith allows them to message each other.
  await a.client.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });
  await b.client.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });
  return { owner, conf, alice: a.client, aliceId: a.identity_id, bob: b.client, bobId: b.identity_id };
}

describe("chat eligibility (canChatWith)", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("send works between two published, chat-enabled participants", async () => {
    const { conf, alice, bobId } = await setupTwoPublishedParticipants(ctx, "elig-ok");
    const m = await alice.rpc.chat.send({
      slug: conf.slug, target_identity_id: bobId, body: "hi bob",
    });
    expect(m).toMatchObject({
      body: "hi bob",
      sender_identity_id: expect.any(Number),
      conversation_id: expect.any(Number),
    });
  });

  test("self-message rejected with BAD_REQUEST cannot_chat_with_self", async () => {
    const { conf, alice, aliceId } = await setupTwoPublishedParticipants(ctx, "elig-self");
    await expect(
      alice.rpc.chat.send({ slug: conf.slug, target_identity_id: aliceId, body: "to me" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "cannot_chat_with_self" });
  });

  test("send to unpublished target as non-mod returns NOT_FOUND (existence not leaked)", async () => {
    const { conf, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "elig-unpub");
    await bob.rpc.profiles.updateMine({ slug: conf.slug, profile_published: false });
    await expect(
      alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "hi" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("owner (mod) CAN send to unpublished target", async () => {
    const { conf, owner, bob, bobId } = await setupTwoPublishedParticipants(ctx, "elig-mod-bypass");
    await bob.rpc.profiles.updateMine({ slug: conf.slug, profile_published: false });
    const m = await owner.rpc.chat.send({
      slug: conf.slug, target_identity_id: bobId, body: "mod can dm anyone",
    });
    expect(m.body).toBe("mod can dm anyone");
  });

  test("send to chat-disabled target returns FORBIDDEN chat_disabled", async () => {
    const { conf, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "elig-disabled");
    await bob.rpc.chat.updateSettings({ slug: conf.slug, chat_enabled: false });
    await expect(
      alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "hi" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "chat_disabled" });
  });

  test("send is blocked in both directions when ChatBlock exists", async () => {
    const { conf, alice, aliceId, bob, bobId } = await setupTwoPublishedParticipants(ctx, "elig-block");
    await bob.rpc.chat.blockUser({ slug: conf.slug, target_identity_id: aliceId });
    await expect(
      alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "hi" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "blocked" });
    await expect(
      bob.rpc.chat.send({ slug: conf.slug, target_identity_id: aliceId, body: "from blocker" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "blocked" });
  });

  test("unblock restores send", async () => {
    const { conf, alice, aliceId, bob, bobId } = await setupTwoPublishedParticipants(ctx, "elig-unblock");
    await bob.rpc.chat.blockUser({ slug: conf.slug, target_identity_id: aliceId });
    await bob.rpc.chat.unblockUser({ slug: conf.slug, target_identity_id: aliceId });
    const m = await alice.rpc.chat.send({
      slug: conf.slug, target_identity_id: bobId, body: "post-unblock",
    });
    expect(m.body).toBe("post-unblock");
  });

  test("banned identity cannot send (chat_banned via principal.identity)", async () => {
    const { conf, owner, alice, aliceId, bobId } = await setupTwoPublishedParticipants(ctx, "elig-ban");
    // Generate a report and have the owner ban alice for it.
    await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "first" });
    // Owner finds and bans alice directly via Prisma — the moderation path
    // requires a reported message, which we'll cover in the moderation suite.
    await ctx.prisma.conferenceIdentity.update({
      where: { id: aliceId },
      data: { chatBannedAt: new Date(), chatBannedReason: "test ban" },
    });
    await expect(
      alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "still here?" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "banned" });
    // Mods bypass the published check but still respect ban — sending TO a
    // banned user is also blocked (see canChatWith in permissions.ts and the
    // chat-eligibility rule in CLAUDE.md).
    await expect(
      owner.rpc.chat.send({ slug: conf.slug, target_identity_id: aliceId, body: "you're banned" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "banned" });
  });
});

describe("chat.send + listMessages + listConversations", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("send creates Conversation + Message + Notification + publishes bus events", async () => {
    __resetBusForTests();
    const bus = getBus();
    const events: BusEvent[] = [];
    const off = bus.subscribe(0, () => { /* keep subs map alive */ });
    // We don't know recipient id ahead of time — capture all via a stub on
    // BOTH known ids after we set up identities.
    const { conf, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "send-creates");
    const offA = bus.subscribe(bobId, (e) => events.push(e));

    const m = await alice.rpc.chat.send({
      slug: conf.slug, target_identity_id: bobId, body: "Hello, Bob",
    });

    expect(m.body).toBe("Hello, Bob");
    expect(m.conversation_id).toBeGreaterThan(0);

    // Bob sees the conversation in his inbox.
    const convs = await bob.rpc.chat.listConversations({ slug: conf.slug });
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({
      id: m.conversation_id,
      accepted: false, // first message, awaiting bob's reply / accept.
      unread_count: 1,
      last_message_preview: "Hello, Bob",
    });

    // Bob can list the messages.
    const msgs = await bob.rpc.chat.listMessages({
      slug: conf.slug, conversation_id: m.conversation_id, limit: 50,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toBe("Hello, Bob");

    // Bus published at least: message.created (to bob), notification.upserted (to bob),
    // message.created (echo to alice).
    expect(events.some((e) => e.kind === "message.created" && e.recipientId === bobId)).toBe(true);
    expect(events.some((e) => e.kind === "notification.upserted" && e.recipientId === bobId)).toBe(true);

    off();
    offA();
  });

  test("recipient replying auto-accepts the conversation", async () => {
    const { conf, alice, aliceId, bob, bobId } = await setupTwoPublishedParticipants(ctx, "send-accept");
    const m1 = await alice.rpc.chat.send({
      slug: conf.slug, target_identity_id: bobId, body: "hi",
    });
    // Before bob replies, conversation is in his Requests bucket.
    let convs = await bob.rpc.chat.listConversations({ slug: conf.slug });
    expect(convs[0]!.accepted).toBe(false);
    // Bob replies — auto-accepts.
    await bob.rpc.chat.send({
      slug: conf.slug, target_identity_id: aliceId, body: "yo",
    });
    convs = await bob.rpc.chat.listConversations({ slug: conf.slug });
    expect(convs[0]!.accepted).toBe(true);
    // Conversation_id is stable.
    expect(convs[0]!.id).toBe(m1.conversation_id);
  });

  test("listMessages pages with before_id (newest first)", async () => {
    const { conf, alice, bobId } = await setupTwoPublishedParticipants(ctx, "send-page");
    const m1 = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "1" });
    const m2 = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "2" });
    const m3 = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "3" });

    const first = await alice.rpc.chat.listMessages({
      slug: conf.slug, conversation_id: m1.conversation_id, limit: 2,
    });
    expect(first.map((m) => m.id)).toEqual([m3.id, m2.id]);
    const older = await alice.rpc.chat.listMessages({
      slug: conf.slug, conversation_id: m1.conversation_id, before_id: m2.id, limit: 10,
    });
    expect(older.map((m) => m.id)).toEqual([m1.id]);
  });

  test("listMessages rejects non-participant", async () => {
    const { conf, owner, alice, bobId } = await setupTwoPublishedParticipants(ctx, "send-nonpart");
    const m = await alice.rpc.chat.send({
      slug: conf.slug, target_identity_id: bobId, body: "private",
    });
    // owner is mod but is not a participant in this conversation.
    await expect(
      owner.rpc.chat.listMessages({ slug: conf.slug, conversation_id: m.conversation_id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("chat.edit + chat.delete", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("edit within window updates body + creates MessageRevision row", async () => {
    const { conf, alice, bobId } = await setupTwoPublishedParticipants(ctx, "edit-ok");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "original" });
    const edited = await alice.rpc.chat.edit({
      slug: conf.slug, message_id: m.id, body: "fixed typo",
    });
    expect(edited.body).toBe("fixed typo");
    expect(edited.edited_at).not.toBeNull();
    const revisions = await ctx.prisma.messageRevision.findMany({ where: { messageId: m.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.body).toBe("original");
  });

  test("edit after 15-minute window is forbidden", async () => {
    const { conf, alice, bobId } = await setupTwoPublishedParticipants(ctx, "edit-late");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "old" });
    // Rewind createdAt by 20 minutes to simulate stale message.
    await ctx.prisma.message.update({
      where: { id: m.id },
      data: { createdAt: new Date(Date.now() - 20 * 60_000) },
    });
    await expect(
      alice.rpc.chat.edit({ slug: conf.slug, message_id: m.id, body: "too late" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "edit_window_expired" });
  });

  test("edit someone else's message is forbidden", async () => {
    const { conf, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "edit-other");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "mine" });
    await expect(
      bob.rpc.chat.edit({ slug: conf.slug, message_id: m.id, body: "stolen" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "not_message_owner" });
  });

  test("delete soft-deletes (body null, deletedReason='user')", async () => {
    const { conf, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "del-soft");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "oops" });
    const deleted = await alice.rpc.chat.delete({ slug: conf.slug, message_id: m.id });
    expect(deleted.body).toBeNull();
    expect(deleted.deleted_reason).toBe("user");
    // Row still exists in the DB so reports can reference it.
    const row = await ctx.prisma.message.findUnique({ where: { id: m.id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
    // Bob's listMessages sees the deleted placeholder.
    const msgs = await bob.rpc.chat.listMessages({
      slug: conf.slug, conversation_id: m.conversation_id,
    });
    expect(msgs[0]!.body).toBeNull();
    expect(msgs[0]!.deleted_reason).toBe("user");
  });

  test("delete someone else's message is forbidden", async () => {
    const { conf, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "del-other");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "mine" });
    await expect(
      bob.rpc.chat.delete({ slug: conf.slug, message_id: m.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "not_message_owner" });
  });
});

describe("chat.markRead + read receipts", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("markRead clears readAt for inbound messages only", async () => {
    const { conf, alice, aliceId, bob, bobId } = await setupTwoPublishedParticipants(ctx, "read-inbound");
    const a1 = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "1" });
    const b1 = await bob.rpc.chat.send({ slug: conf.slug, target_identity_id: aliceId, body: "back" });
    await bob.rpc.chat.markRead({ slug: conf.slug, conversation_id: a1.conversation_id });
    // Inbound (alice → bob) now has readAt set.
    const a1row = await ctx.prisma.message.findUnique({ where: { id: a1.id } });
    expect(a1row!.readAt).not.toBeNull();
    // Bob's OWN message (b1) is NOT touched by his markRead.
    const b1row = await ctx.prisma.message.findUnique({ where: { id: b1.id } });
    expect(b1row!.readAt).toBeNull();
  });

  test("markRead frees the notification dedupe slot", async () => {
    const { conf, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "read-dedupe");
    const m1 = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "first" });
    await bob.rpc.chat.markRead({ slug: conf.slug, conversation_id: m1.conversation_id });
    // Sending again must NOT trip the unique constraint.
    const m2 = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "second" });
    expect(m2.id).toBeGreaterThan(m1.id);
    // Bob sees a fresh unread row (the upsert re-uses the slot, resetting it).
    const unread = await ctx.prisma.notification.count({
      where: { dedupeKey: `conv:${m1.conversation_id}`, readAt: null },
    });
    expect(unread).toBe(1);
  });

  test("read receipts hidden from sender when recipient disables them", async () => {
    const { conf, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "read-receipts-off");
    await bob.rpc.chat.updateSettings({ slug: conf.slug, read_receipts_enabled: false });
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "hi" });
    await bob.rpc.chat.markRead({ slug: conf.slug, conversation_id: m.conversation_id });
    // Alice's view of her own sent message — readAt MUST be null.
    const aliceView = await alice.rpc.chat.listMessages({
      slug: conf.slug, conversation_id: m.conversation_id,
    });
    expect(aliceView[0]!.read_at).toBeNull();
    // Bob still has authoritative readAt in his own DB row for unread counting.
    const dbRow = await ctx.prisma.message.findUnique({ where: { id: m.id } });
    expect(dbRow!.readAt).not.toBeNull();
  });
});

describe("chat notification coalescing", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("multiple unread messages share one notification row with incremented count", async () => {
    const { conf, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "notif-coalesce");
    await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "1" });
    await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "2" });
    await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "3" });
    const list = await bob.rpc.notifications.list({ slug: conf.slug });
    const chatRow = list.items.find((n) => n.kind === "chat_message");
    expect(chatRow).toBeDefined();
    expect(chatRow!.unread_count).toBe(3);
    expect(chatRow!.dedupe_key).toMatch(/^conv:\d+$/);
  });
});

describe("chat rate limits", () => {
  let ctx: TestApp;
  beforeEach(() => { /* limits store reset by setupTestApp via __resetLimitsState */ });
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("11th new conversation in an hour returns TOO_MANY_REQUESTS", async () => {
    const owner = await createOwner(ctx.app, "rl-owner@example.com", "secret123", "RL");
    const conf = await owner.rpc.conferences.create({ name: "RL" });
    const senderInv = await inviteAndClaim(ctx.app, owner, conf.slug, "sender@example.com", "secret123", "Sender");
    await senderInv.client.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });
    // Create 11 distinct published targets so each send opens a new conversation.
    const targetIds: number[] = [];
    for (let i = 0; i < 11; i++) {
      const t = await inviteAndClaim(ctx.app, owner, conf.slug, `t${i}@example.com`, "secret123", `T${i}`);
      await t.client.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });
      targetIds.push(t.identity_id);
    }
    // First 10 succeed.
    for (let i = 0; i < 10; i++) {
      await senderInv.client.rpc.chat.send({
        slug: conf.slug, target_identity_id: targetIds[i]!, body: "hi",
      });
    }
    // 11th throws.
    await expect(
      senderInv.client.rpc.chat.send({
        slug: conf.slug, target_identity_id: targetIds[10]!, body: "one too many",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("chat.reportMessage + moderation", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("report creates row and notifies moderators with coalescing", async () => {
    const { conf, owner, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "report-creates");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "bad stuff" });
    await bob.rpc.chat.reportMessage({
      slug: conf.slug, message_id: m.id, reason: "harassment",
    });
    // Owner-side: report shows in listChatReports.
    const reports = (await owner.rpc.moderation.listChatReports({ slug: conf.slug })).items;
    expect(reports).toHaveLength(1);
    expect(reports[0]!).toMatchObject({
      reason: "harassment",
      reported_sender_identity_id: expect.any(Number),
      resolved_at: null,
    });
    // Owner gets a chat_report notification.
    const notifs = await owner.rpc.notifications.list({ slug: conf.slug });
    expect(notifs.items.some((n) => n.kind === "chat_report")).toBe(true);
  });

  test("reporting own message is rejected", async () => {
    const { conf, alice, bobId } = await setupTwoPublishedParticipants(ctx, "report-self");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "mine" });
    await expect(
      alice.rpc.chat.reportMessage({ slug: conf.slug, message_id: m.id, reason: "nope" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "cannot_report_own_message" });
  });

  test("resolve with ban marks identity + soft-deletes the offending message", async () => {
    const { conf, owner, alice, aliceId, bob, bobId } = await setupTwoPublishedParticipants(ctx, "moderate-ban");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "abusive" });
    await bob.rpc.chat.reportMessage({ slug: conf.slug, message_id: m.id, reason: "violates code" });
    const [report] = (await owner.rpc.moderation.listChatReports({ slug: conf.slug })).items;
    await owner.rpc.moderation.resolveChatReport({
      slug: conf.slug, report_id: report!.id, action: "ban", mod_reason: "test ban",
    });
    // Identity gets chatBannedAt.
    const banned = await ctx.prisma.conferenceIdentity.findUnique({ where: { id: aliceId } });
    expect(banned!.chatBannedAt).not.toBeNull();
    expect(banned!.chatBannedReason).toBe("test ban");
    // Message soft-deleted.
    const msgRow = await ctx.prisma.message.findUnique({ where: { id: m.id } });
    expect(msgRow!.deletedAt).not.toBeNull();
    expect(msgRow!.deletedReason).toBe("moderator");
    // Banned identity can't send.
    await expect(
      alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "still here?" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "banned" });
  });

  test("resolve with warn uses the moderator's reason in the notification", async () => {
    const { conf, owner, alice, aliceId, bob, bobId } = await setupTwoPublishedParticipants(ctx, "moderate-warn-reason");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "rude" });
    await bob.rpc.chat.reportMessage({ slug: conf.slug, message_id: m.id, reason: "reporter text" });
    const [report] = (await owner.rpc.moderation.listChatReports({ slug: conf.slug })).items;
    await owner.rpc.moderation.resolveChatReport({
      slug: conf.slug, report_id: report!.id, action: "warn", mod_reason: "moderator text",
    });
    const notif = await ctx.prisma.notification.findFirst({
      where: { identityId: aliceId, kind: "chat_warning" },
    });
    expect(notif).not.toBeNull();
    expect(notif!.body).toContain("moderator text");
    expect(notif!.body).not.toContain("reporter text");
  });

  test("resolve with warn falls back to reporter's reason when mod_reason omitted", async () => {
    const { conf, owner, alice, aliceId, bob, bobId } = await setupTwoPublishedParticipants(ctx, "moderate-warn-fallback");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "rude" });
    await bob.rpc.chat.reportMessage({ slug: conf.slug, message_id: m.id, reason: "reporter fallback" });
    const [report] = (await owner.rpc.moderation.listChatReports({ slug: conf.slug })).items;
    await owner.rpc.moderation.resolveChatReport({
      slug: conf.slug, report_id: report!.id, action: "warn",
    });
    const notif = await ctx.prisma.notification.findFirst({
      where: { identityId: aliceId, kind: "chat_warning" },
    });
    expect(notif!.body).toContain("reporter fallback");
  });

  test("unbanFromChat clears the ban fields", async () => {
    const { conf, owner, alice, aliceId, bobId } = await setupTwoPublishedParticipants(ctx, "moderate-unban");
    await ctx.prisma.conferenceIdentity.update({
      where: { id: aliceId },
      data: { chatBannedAt: new Date(), chatBannedReason: "earlier" },
    });
    await owner.rpc.moderation.unbanFromChat({ slug: conf.slug, identity_id: aliceId });
    const cleared = await ctx.prisma.conferenceIdentity.findUnique({ where: { id: aliceId } });
    expect(cleared!.chatBannedAt).toBeNull();
    expect(cleared!.chatBannedReason).toBeNull();
    // Alice can send again.
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "back" });
    expect(m.body).toBe("back");
  });

  test("non-mod cannot call moderation procedures", async () => {
    const { conf, alice } = await setupTwoPublishedParticipants(ctx, "moderate-noperm");
    await expect(
      alice.rpc.moderation.listChatReports({ slug: conf.slug }),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(
      alice.rpc.moderation.listChatBans({ slug: conf.slug }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("resolveChatReport rejects double-resolve", async () => {
    const { conf, owner, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "moderate-doubleresolve");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "x" });
    await bob.rpc.chat.reportMessage({ slug: conf.slug, message_id: m.id, reason: "x" });
    const [report] = (await owner.rpc.moderation.listChatReports({ slug: conf.slug })).items;
    await owner.rpc.moderation.resolveChatReport({
      slug: conf.slug, report_id: report!.id, action: "dismiss",
    });
    await expect(
      owner.rpc.moderation.resolveChatReport({
        slug: conf.slug, report_id: report!.id, action: "dismiss",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "report_already_resolved" });
  });
});

describe("conferences.delete blocks on open chat reports", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("deletion fails with open_chat_reports until reports are resolved", async () => {
    const { conf, owner, alice, bob, bobId } = await setupTwoPublishedParticipants(ctx, "delete-blocked");
    const m = await alice.rpc.chat.send({ slug: conf.slug, target_identity_id: bobId, body: "?" });
    await bob.rpc.chat.reportMessage({ slug: conf.slug, message_id: m.id, reason: "x" });
    await expect(
      owner.rpc.conferences.delete({ slug: conf.slug }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "open_chat_reports" });
    // Resolve the report, deletion now succeeds.
    const [report] = (await owner.rpc.moderation.listChatReports({ slug: conf.slug })).items;
    await owner.rpc.moderation.resolveChatReport({
      slug: conf.slug, report_id: report!.id, action: "dismiss",
    });
    await owner.rpc.conferences.delete({ slug: conf.slug });
  });
});
