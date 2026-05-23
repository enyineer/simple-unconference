// chat.* oRPC procedures. See plans/chat.md Phase 4 for design rationale.
//
// Every send / edit / delete / markRead publishes a BusEvent so live SSE
// subscribers on this and other workers get the update without polling.
// Notifications use dedupeKey coalescing so a flurry of messages collapses
// into a single bell row per conversation per identity (see chat-helpers).

import { ORPCError } from "@orpc/server";
import type { Prisma } from "@prisma/client";
import { requireConf, actorIdentityId } from "./shared";
import { canChatWith } from "../lib/permissions";
import {
  assertChatMessageAllowed,
  assertChatNewConversationAllowed,
  LIMITS,
} from "../lib/limits";
import { getBus } from "../realtime/bus";
import { createNotification } from "../notifications";
import {
  clearChatNotificationsForConversation,
  findOrCreateConversation,
  loadMessageForParticipant,
  serializeConversation,
  serializeMessage,
  sortIdentityPair,
  upsertChatNotification,
} from "./chat-helpers";

// 15-minute edit window. Beyond this, the original stands and a follow-up
// message is the only correction path.
const EDIT_WINDOW_MS = 15 * 60_000;

// Map ChatEligibility reasons to ORPCError codes. Order in canChatWith ensures
// non-existence and unpublished-target both surface as NOT_FOUND for non-mods,
// preventing probing.
function eligibilityError(reason: "self" | "not_published" | "chat_disabled" | "banned" | "blocked"): ORPCError<string, unknown> {
  if (reason === "self") {
    return new ORPCError("BAD_REQUEST", { message: "cannot_chat_with_self" });
  }
  if (reason === "not_published") {
    return new ORPCError("NOT_FOUND");
  }
  return new ORPCError("FORBIDDEN", { message: reason });
}

export const chatRouter = {
  // ----- listConversations -------------------------------------------------
  listConversations: requireConf("participant").chat.listConversations.handler(async ({ context }) => {
    const viewerId = actorIdentityId(context);
    const rows = await context.prisma.conversation.findMany({
      where: {
        conferenceId: context.conferenceId,
        OR: [
          { identityIdLow: viewerId },
          { identityIdHigh: viewerId },
        ],
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    });
    return Promise.all(
      rows.map((conversation) =>
        serializeConversation({ prisma: context.prisma, viewerIdentityId: viewerId, conversation }),
      ),
    );
  }),

  // ----- listMessages ------------------------------------------------------
  listMessages: requireConf("participant").chat.listMessages.handler(async ({ input, context }) => {
    const viewerId = actorIdentityId(context);
    const conv = await context.prisma.conversation.findFirst({
      where: { id: input.conversation_id, conferenceId: context.conferenceId },
      select: { identityIdLow: true, identityIdHigh: true },
    });
    if (!conv) throw new ORPCError("NOT_FOUND");
    if (conv.identityIdLow !== viewerId && conv.identityIdHigh !== viewerId) {
      throw new ORPCError("FORBIDDEN");
    }
    const otherId = conv.identityIdLow === viewerId ? conv.identityIdHigh : conv.identityIdLow;
    const other = await context.prisma.conferenceIdentity.findUnique({
      where: { id: otherId },
      select: { chatReadReceiptsEnabled: true },
    });
    const otherReadReceipts = other?.chatReadReceiptsEnabled ?? true;
    const limit = input.limit ?? 50;
    const where: Prisma.MessageWhereInput = {
      conversationId: input.conversation_id,
      ...(input.before_id ? { id: { lt: input.before_id } } : {}),
    };
    const rows = await context.prisma.message.findMany({
      where,
      orderBy: { id: "desc" },
      take: limit,
    });
    return rows.map((m) => serializeMessage({
      message: m,
      viewerKind: m.senderIdentityId === viewerId ? "sender" : "receiver",
      receiverReadReceiptsEnabled: otherReadReceipts,
    }));
  }),

  // ----- send --------------------------------------------------------------
  send: requireConf("participant").chat.send.handler(async ({ input, context }) => {
    const viewer = context.principal;
    const viewerId = viewer.identity.id;

    // Eligibility gate (handles self, published, ban, block).
    const elig = await canChatWith({
      prisma: context.prisma,
      viewer,
      targetIdentityId: input.target_identity_id,
      conferenceId: context.conferenceId,
    });
    if (!elig.ok) throw eligibilityError(elig.reason);

    // Body size check (chars-as-bytes upper bound; the schema already capped
    // at 4096 chars but env LIMITS may be tighter).
    if (LIMITS.chatMessageMaxBytes > 0 && Buffer.byteLength(input.body, "utf8") > LIMITS.chatMessageMaxBytes) {
      throw new ORPCError("BAD_REQUEST", { message: "message_too_long" });
    }

    // Message rate (always). New-conversation rate is asserted only when the
    // conversation doesn't yet exist — re-replying to an existing thread
    // doesn't count against the 10/hour budget.
    assertChatMessageAllowed(viewerId);

    const conv = await findOrCreateConversation({
      prisma: context.prisma,
      conferenceId: context.conferenceId,
      senderIdentityId: viewerId,
      recipientIdentityId: input.target_identity_id,
    });
    if (conv.created) {
      assertChatNewConversationAllowed(viewerId);
    }

    // Auto-accept: if the receiver is the one replying, flip accepted=true.
    // The original initiator can't auto-accept their own pending conversation
    // (it stays in the receiver's Requests bucket until they engage).
    const isReply = !conv.created && !conv.accepted && viewerId === conv.highId
      ? await isReceiverReplying(context.prisma, conv.id, viewerId)
      : false;
    const shouldAccept = conv.created
      ? false
      : (!conv.accepted && await isReceiverReplying(context.prisma, conv.id, viewerId));

    const now = new Date();
    const message = await context.prisma.message.create({
      data: {
        conversationId: conv.id,
        senderIdentityId: viewerId,
        body: input.body,
        createdAt: now,
      },
    });

    await context.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: now,
        ...(shouldAccept ? { accepted: true, acceptedAt: now } : {}),
      },
    });

    // Notification + bus fan-out.
    const recipientId = input.target_identity_id;
    const conf = await context.prisma.conference.findUnique({
      where: { id: context.conferenceId },
      select: { slug: true },
    });
    const slug = conf?.slug ?? "";
    // upsertChatNotification routes through notifyCoalesced, which also
    // publishes the `notification.upserted` bus event for us.
    await upsertChatNotification({
      prisma: context.prisma,
      recipientIdentityId: recipientId,
      conversationId: conv.id,
      conferenceSlug: slug,
      senderName: viewer.identity.name ?? "Someone",
      bodyPreview: input.body,
    });

    const bus = getBus();
    bus.publish({ kind: "message.created", recipientId, messageId: message.id, conversationId: conv.id });
    // Echo to the sender's other tabs so they see the sent message in real time.
    bus.publish({ kind: "message.created", recipientId: viewerId, messageId: message.id, conversationId: conv.id });

    // Lint silencer: isReply is informational but unused beyond shouldAccept.
    void isReply;

    return serializeMessage({
      message,
      viewerKind: "sender",
      receiverReadReceiptsEnabled: true, // sender just sent — no readAt yet anyway.
    });
  }),

  // ----- edit --------------------------------------------------------------
  edit: requireConf("participant").chat.edit.handler(async ({ input, context }) => {
    const viewerId = actorIdentityId(context);
    const result = await loadMessageForParticipant({
      prisma: context.prisma,
      messageId: input.message_id,
      viewerIdentityId: viewerId,
    });
    if ("error" in result) {
      throw new ORPCError(result.error === "not_found" ? "NOT_FOUND" : "FORBIDDEN");
    }
    const { message } = result;
    if (message.conversation.conferenceId !== context.conferenceId) throw new ORPCError("NOT_FOUND");
    if (message.senderIdentityId !== viewerId) throw new ORPCError("FORBIDDEN", { message: "not_message_owner" });
    if (message.deletedAt) throw new ORPCError("FORBIDDEN", { message: "message_deleted" });
    if (Date.now() - message.createdAt.getTime() > EDIT_WINDOW_MS) {
      throw new ORPCError("FORBIDDEN", { message: "edit_window_expired" });
    }

    // Snapshot the prior body BEFORE mutating. Mod report payload includes
    // the full revision chain in oldest→newest order.
    await context.prisma.messageRevision.create({
      data: { messageId: message.id, body: message.body },
    });
    const now = new Date();
    const updated = await context.prisma.message.update({
      where: { id: message.id },
      data: { body: input.body, editedAt: now },
    });

    const otherId = message.conversation.identityIdLow === viewerId
      ? message.conversation.identityIdHigh
      : message.conversation.identityIdLow;
    const convId = message.conversationId;
    const bus = getBus();
    bus.publish({ kind: "message.edited", recipientId: otherId, messageId: updated.id, conversationId: convId });
    bus.publish({ kind: "message.edited", recipientId: viewerId, messageId: updated.id, conversationId: convId });
    return serializeMessage({
      message: updated,
      viewerKind: "sender",
      receiverReadReceiptsEnabled: true,
    });
  }),

  // ----- delete ------------------------------------------------------------
  delete: requireConf("participant").chat.delete.handler(async ({ input, context }) => {
    const viewerId = actorIdentityId(context);
    const result = await loadMessageForParticipant({
      prisma: context.prisma,
      messageId: input.message_id,
      viewerIdentityId: viewerId,
    });
    if ("error" in result) {
      throw new ORPCError(result.error === "not_found" ? "NOT_FOUND" : "FORBIDDEN");
    }
    const { message } = result;
    if (message.conversation.conferenceId !== context.conferenceId) throw new ORPCError("NOT_FOUND");
    if (message.senderIdentityId !== viewerId) throw new ORPCError("FORBIDDEN", { message: "not_message_owner" });
    if (message.deletedAt) {
      // Idempotent: already deleted, just return the current state.
      return serializeMessage({ message, viewerKind: "sender", receiverReadReceiptsEnabled: true });
    }
    const now = new Date();
    const updated = await context.prisma.message.update({
      where: { id: message.id },
      data: { deletedAt: now, deletedReason: "user" },
    });
    const otherId = message.conversation.identityIdLow === viewerId
      ? message.conversation.identityIdHigh
      : message.conversation.identityIdLow;
    const convId = message.conversationId;
    const bus = getBus();
    bus.publish({ kind: "message.deleted", recipientId: otherId, messageId: updated.id, conversationId: convId });
    bus.publish({ kind: "message.deleted", recipientId: viewerId, messageId: updated.id, conversationId: convId });
    return serializeMessage({ message: updated, viewerKind: "sender", receiverReadReceiptsEnabled: true });
  }),

  // ----- markRead ----------------------------------------------------------
  markRead: requireConf("participant").chat.markRead.handler(async ({ input, context }) => {
    const viewerId = actorIdentityId(context);
    const conv = await context.prisma.conversation.findFirst({
      where: { id: input.conversation_id, conferenceId: context.conferenceId },
      select: { identityIdLow: true, identityIdHigh: true },
    });
    if (!conv) throw new ORPCError("NOT_FOUND");
    if (conv.identityIdLow !== viewerId && conv.identityIdHigh !== viewerId) {
      throw new ORPCError("FORBIDDEN");
    }
    const otherId = conv.identityIdLow === viewerId ? conv.identityIdHigh : conv.identityIdLow;
    const now = new Date();
    const updated = await context.prisma.message.updateMany({
      where: {
        conversationId: input.conversation_id,
        senderIdentityId: otherId,
        readAt: null,
      },
      data: { readAt: now },
    });
    await clearChatNotificationsForConversation({
      prisma: context.prisma,
      identityId: viewerId,
      conversationId: input.conversation_id,
    });
    const bus = getBus();
    if (updated.count > 0) {
      // Tell the sender (other party) that their messages were read.
      bus.publish({ kind: "message.read", recipientId: otherId, conversationId: input.conversation_id });
    }
    // Tell the viewer's other tabs to clear the unread badge.
    bus.publish({ kind: "notification.read", recipientId: viewerId, conversationId: input.conversation_id });
    return { ok: true as const };
  }),

  // ----- acceptConversation ------------------------------------------------
  acceptConversation: requireConf("participant").chat.acceptConversation.handler(async ({ input, context }) => {
    const viewerId = actorIdentityId(context);
    const conv = await context.prisma.conversation.findFirst({
      where: { id: input.conversation_id, conferenceId: context.conferenceId },
      select: { identityIdLow: true, identityIdHigh: true, accepted: true },
    });
    if (!conv) throw new ORPCError("NOT_FOUND");
    if (conv.identityIdLow !== viewerId && conv.identityIdHigh !== viewerId) {
      throw new ORPCError("FORBIDDEN");
    }
    if (!conv.accepted) {
      await context.prisma.conversation.update({
        where: { id: input.conversation_id },
        data: { accepted: true, acceptedAt: new Date() },
      });
    }
    return { ok: true as const };
  }),

  // ----- declineConversation -----------------------------------------------
  declineConversation: requireConf("participant").chat.declineConversation.handler(async ({ input, context }) => {
    const viewerId = actorIdentityId(context);
    const conv = await context.prisma.conversation.findFirst({
      where: { id: input.conversation_id, conferenceId: context.conferenceId },
      select: { identityIdLow: true, identityIdHigh: true },
    });
    if (!conv) throw new ORPCError("NOT_FOUND");
    if (conv.identityIdLow !== viewerId && conv.identityIdHigh !== viewerId) {
      throw new ORPCError("FORBIDDEN");
    }
    const otherId = conv.identityIdLow === viewerId ? conv.identityIdHigh : conv.identityIdLow;
    // Decline implies block: prevents the sender from re-initiating.
    await context.prisma.chatBlock.upsert({
      where: {
        blockerIdentityId_blockedIdentityId: {
          blockerIdentityId: viewerId,
          blockedIdentityId: otherId,
        },
      },
      update: {},
      create: { blockerIdentityId: viewerId, blockedIdentityId: otherId },
    });
    return { ok: true as const };
  }),

  // ----- blockUser ---------------------------------------------------------
  blockUser: requireConf("participant").chat.blockUser.handler(async ({ input, context }) => {
    const viewerId = actorIdentityId(context);
    if (input.target_identity_id === viewerId) {
      throw new ORPCError("BAD_REQUEST", { message: "cannot_block_self" });
    }
    // Verify target is in this conference (cross-conference safety).
    const target = await context.prisma.conferenceIdentity.findFirst({
      where: { id: input.target_identity_id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND");
    await context.prisma.chatBlock.upsert({
      where: {
        blockerIdentityId_blockedIdentityId: {
          blockerIdentityId: viewerId,
          blockedIdentityId: input.target_identity_id,
        },
      },
      update: {},
      create: { blockerIdentityId: viewerId, blockedIdentityId: input.target_identity_id },
    });
    return { ok: true as const };
  }),

  // ----- unblockUser -------------------------------------------------------
  unblockUser: requireConf("participant").chat.unblockUser.handler(async ({ input, context }) => {
    const viewerId = actorIdentityId(context);
    await context.prisma.chatBlock.deleteMany({
      where: { blockerIdentityId: viewerId, blockedIdentityId: input.target_identity_id },
    });
    return { ok: true as const };
  }),

  // ----- reportMessage -----------------------------------------------------
  reportMessage: requireConf("participant").chat.reportMessage.handler(async ({ input, context }) => {
    const viewerId = actorIdentityId(context);
    const result = await loadMessageForParticipant({
      prisma: context.prisma,
      messageId: input.message_id,
      viewerIdentityId: viewerId,
    });
    if ("error" in result) {
      throw new ORPCError(result.error === "not_found" ? "NOT_FOUND" : "FORBIDDEN");
    }
    const { message } = result;
    if (message.conversation.conferenceId !== context.conferenceId) throw new ORPCError("NOT_FOUND");
    if (message.senderIdentityId === viewerId) {
      throw new ORPCError("BAD_REQUEST", { message: "cannot_report_own_message" });
    }

    await context.prisma.messageReport.create({
      data: {
        messageId: message.id,
        reporterIdentityId: viewerId,
        reason: input.reason,
      },
    });

    // Notify mods for this conference. Coalesce via
    // dedupeKey="report:<conferenceId>" so a flood of reports collapses to
    // a single bell row per mod with the count baked in.
    const mods = await context.prisma.conferenceIdentity.findMany({
      where: { conferenceId: context.conferenceId, role: "moderator" },
      select: { id: true },
    });
    const conf = await context.prisma.conference.findUnique({
      where: { id: context.conferenceId },
      select: { ownerId: true },
    });
    // Also notify the owner (via their auto-minted identity row).
    const ownerIdentity = conf
      ? await context.prisma.conferenceIdentity.findFirst({
          where: { conferenceId: context.conferenceId, ownerUserId: conf.ownerId },
          select: { id: true },
        })
      : null;
    const recipients = new Set<number>(mods.map((m) => m.id));
    if (ownerIdentity) recipients.add(ownerIdentity.id);

    const dedupeKey = `report:${context.conferenceId}`;
    // `tab:people` routes through the in-place tab switcher (mods only see
    // the People tab). The reports section is rendered inline there, so we
    // don't need a sub-tab segment — the path-based form was also breaking
    // the hash router by leaking `?tab=reports` into the :tab segment.
    const ctaHref = "tab:people";
    for (const modId of recipients) {
      await createNotification(context.prisma, {
        identityId: modId,
        dedupeKey,
        kind: "chat_report",
        title: "Chat message reported",
        body: "A user reported a chat message.",
        ctaLabel: "Review reports",
        ctaHref,
      });
    }

    return { ok: true as const };
  }),

  // ----- getSettings -------------------------------------------------------
  getSettings: requireConf("participant").chat.getSettings.handler(async ({ context }) => {
    const me = context.principal.identity;
    return {
      chat_enabled: me.chatEnabled,
      read_receipts_enabled: me.chatReadReceiptsEnabled,
      chat_banned: me.chatBannedAt !== null,
      chat_ban_reason: me.chatBannedReason,
    };
  }),

  // ----- updateSettings ----------------------------------------------------
  updateSettings: requireConf("participant").chat.updateSettings.handler(async ({ input, context }) => {
    const viewerId = actorIdentityId(context);
    const data: Prisma.ConferenceIdentityUpdateInput = {};
    if (input.chat_enabled !== undefined) data.chatEnabled = input.chat_enabled;
    if (input.read_receipts_enabled !== undefined) data.chatReadReceiptsEnabled = input.read_receipts_enabled;
    const updated = await context.prisma.conferenceIdentity.update({
      where: { id: viewerId },
      data,
      select: {
        chatEnabled: true,
        chatReadReceiptsEnabled: true,
        chatBannedAt: true,
        chatBannedReason: true,
      },
    });
    return {
      chat_enabled: updated.chatEnabled,
      read_receipts_enabled: updated.chatReadReceiptsEnabled,
      chat_banned: updated.chatBannedAt !== null,
      chat_ban_reason: updated.chatBannedReason,
    };
  }),
};

// True when the viewer is the receiver-side of a pending request (NOT the
// initiator) and is now sending. Auto-accept rule: an inbound message from
// the original sender doesn't accept; an outbound message from the receiver
// does. The receiver is whichever identity in the pair did NOT send the
// first message in the conversation.
async function isReceiverReplying(
  prisma: { message: { findFirst: (args: Prisma.MessageFindFirstArgs) => Promise<{ senderIdentityId: number } | null> } },
  conversationId: number,
  viewerId: number,
): Promise<boolean> {
  const firstMessage = await prisma.message.findFirst({
    where: { conversationId },
    orderBy: { id: "asc" },
    select: { senderIdentityId: true },
  });
  if (!firstMessage) return false;
  return firstMessage.senderIdentityId !== viewerId;
}

// Re-export so tests can import without depending on chat-helpers directly.
export { sortIdentityPair };
