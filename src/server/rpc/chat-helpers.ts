// Helpers shared between the chat router (src/server/rpc/chat.ts) and the
// moderation router (src/server/rpc/moderation.ts). Centralizes the per-viewer
// serialization rules so privacy filtering can't drift between procedures.

import type { Prisma, PrismaClient } from "@prisma/client";
import type { ConversationOut, MessageOut } from "../../shared/contract/types";
import { createNotification } from "../notifications";

// Pair-sort: Conversation.unique([conferenceId, identityIdLow, identityIdHigh])
// requires this so (a, b) and (b, a) collapse to one row.
export function sortIdentityPair(a: number, b: number): { low: number; high: number } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

// Upserts a Conversation row. If created, `accepted` stays false until the
// receiver replies or explicitly accepts. The caller decides whether this
// counts as a "new conversation" for rate-limit purposes (use the returned
// `created` flag).
export async function findOrCreateConversation(args: {
  prisma: PrismaClient;
  conferenceId: number;
  senderIdentityId: number;
  recipientIdentityId: number;
}): Promise<{ id: number; accepted: boolean; created: boolean; lowId: number; highId: number }> {
  const { prisma, conferenceId, senderIdentityId, recipientIdentityId } = args;
  const { low, high } = sortIdentityPair(senderIdentityId, recipientIdentityId);
  const existing = await prisma.conversation.findUnique({
    where: {
      conferenceId_identityIdLow_identityIdHigh: {
        conferenceId,
        identityIdLow: low,
        identityIdHigh: high,
      },
    },
    select: { id: true, accepted: true },
  });
  if (existing) {
    return { id: existing.id, accepted: existing.accepted, created: false, lowId: low, highId: high };
  }
  const created = await prisma.conversation.create({
    data: {
      conferenceId,
      identityIdLow: low,
      identityIdHigh: high,
      accepted: false,
    },
    select: { id: true, accepted: true },
  });
  return { id: created.id, accepted: created.accepted, created: true, lowId: low, highId: high };
}

// Per-viewer serialization. Applies read-receipt stripping: only the receiver
// always sees their own `readAt` (drives their unread badge); the sender only
// sees it if the receiver hasn't disabled receipts. For non-participants
// (mods reviewing a report) the readAt always passes through.
//
// `viewerKind` distinguishes the three audiences. "receiver" is the OTHER
// party in the conversation; "moderator" is anyone reviewing via the mod
// surface. "sender" is the message's author.
export function serializeMessage(args: {
  message: {
    id: number;
    conversationId: number;
    senderIdentityId: number;
    body: string;
    createdAt: Date;
    editedAt: Date | null;
    deletedAt: Date | null;
    deletedReason: string | null;
    readAt: Date | null;
  };
  viewerKind: "sender" | "receiver" | "moderator";
  // Receiver's read-receipt preference. Only consulted when viewerKind === "sender".
  receiverReadReceiptsEnabled: boolean;
}): MessageOut {
  const { message, viewerKind, receiverReadReceiptsEnabled } = args;
  const isDeleted = message.deletedAt !== null;
  const readAt = (() => {
    if (viewerKind === "receiver") return message.readAt?.getTime() ?? null;
    if (viewerKind === "moderator") return message.readAt?.getTime() ?? null;
    // sender: gated by receiver's preference.
    return receiverReadReceiptsEnabled ? (message.readAt?.getTime() ?? null) : null;
  })();
  return {
    id: message.id,
    conversation_id: message.conversationId,
    sender_identity_id: message.senderIdentityId,
    body: isDeleted ? null : message.body,
    created_at: message.createdAt.getTime(),
    edited_at: message.editedAt?.getTime() ?? null,
    deleted_at: message.deletedAt?.getTime() ?? null,
    deleted_reason: message.deletedReason,
    read_at: readAt,
  };
}

// Builds the inbox row for one conversation from the viewer's perspective.
// Computes unread count (messages from the OTHER party with readAt IS NULL)
// and resolves the block flags.
export async function serializeConversation(args: {
  prisma: PrismaClient;
  viewerIdentityId: number;
  conversation: {
    id: number;
    conferenceId: number;
    identityIdLow: number;
    identityIdHigh: number;
    accepted: boolean;
    lastMessageAt: Date | null;
    createdAt: Date;
  };
}): Promise<ConversationOut> {
  const { prisma, viewerIdentityId, conversation } = args;
  const otherIdentityId = conversation.identityIdLow === viewerIdentityId
    ? conversation.identityIdHigh
    : conversation.identityIdLow;
  const [other, lastMessage, unreadCount, blocks] = await Promise.all([
    prisma.conferenceIdentity.findUnique({
      where: { id: otherIdentityId },
      select: { name: true, profilePublished: true },
    }),
    prisma.message.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { id: "desc" },
      select: { body: true, deletedAt: true },
    }),
    prisma.message.count({
      where: {
        conversationId: conversation.id,
        senderIdentityId: { not: viewerIdentityId },
        readAt: null,
        deletedAt: null,
      },
    }),
    prisma.chatBlock.findMany({
      where: {
        OR: [
          { blockerIdentityId: viewerIdentityId, blockedIdentityId: otherIdentityId },
          { blockerIdentityId: otherIdentityId, blockedIdentityId: viewerIdentityId },
        ],
      },
      select: { blockerIdentityId: true },
    }),
  ]);
  const iBlocked = blocks.some((b) => b.blockerIdentityId === viewerIdentityId);
  const theyBlocked = blocks.some((b) => b.blockerIdentityId === otherIdentityId);
  return {
    id: conversation.id,
    conference_id: conversation.conferenceId,
    other_identity_id: otherIdentityId,
    other_name: other?.name ?? null,
    other_profile_published: other?.profilePublished ?? false,
    accepted: conversation.accepted,
    last_message_at: conversation.lastMessageAt?.getTime() ?? null,
    last_message_preview: lastMessage
      ? (lastMessage.deletedAt ? null : truncate(lastMessage.body, 80))
      : null,
    unread_count: unreadCount,
    i_blocked: iBlocked,
    they_blocked: theyBlocked,
    created_at: conversation.createdAt.getTime(),
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// Upserts the chat notification for `recipientIdentityId` covering
// `conversationId`. Resilience (handling unread / previously-read / no row)
// lives in `notifyCoalesced` — this helper just shapes the chat-message
// payload and delegates. Also publishes the `notification.upserted` bus
// event, so callers don't need to fan it out themselves.
export async function upsertChatNotification(args: {
  prisma: PrismaClient;
  recipientIdentityId: number;
  conversationId: number;
  conferenceSlug: string;
  senderName: string;
  bodyPreview: string;
}): Promise<{ id: number }> {
  const { prisma, recipientIdentityId, conversationId, conferenceSlug, senderName, bodyPreview } = args;
  return createNotification(prisma, {
    identityId: recipientIdentityId,
    dedupeKey: `conv:${conversationId}`,
    kind: "chat_message",
    title: senderName,
    body: truncate(bodyPreview, 120),
    ctaLabel: "Open chat",
    ctaHref: `/conferences/${conferenceSlug}/chat/${conversationId}`,
  });
}

// Called from chat.markRead so the bell badge clears in lockstep with the
// in-conversation read state. Updates ALL chat notifications for this
// (identity, conversation), not just the latest.
//
// Why dedupeKey is nulled out on read: the @@unique([identityId, dedupeKey])
// index on notifications enforces ONE row per identity per coalescing key.
// Keeping a stale read row with dedupeKey="conv:<id>" would block the next
// `chat.send` from inserting a fresh unread row for the same conversation
// (unique violation). Clearing the key frees the slot while preserving the
// historical row for the bell's archive view.
export async function clearChatNotificationsForConversation(args: {
  prisma: PrismaClient;
  identityId: number;
  conversationId: number;
}): Promise<void> {
  const { prisma, identityId, conversationId } = args;
  await prisma.notification.updateMany({
    where: {
      identityId,
      dedupeKey: `conv:${conversationId}`,
      readAt: null,
    },
    data: { readAt: new Date(), unreadCount: 0, dedupeKey: null },
  });
}

// Convenience: load a message guaranteed to be in a conversation the
// viewer participates in. Throws via a sentinel return when the viewer
// isn't a participant — callers convert to ORPCError.
export async function loadMessageForParticipant(args: {
  prisma: PrismaClient;
  messageId: number;
  viewerIdentityId: number;
}): Promise<{
  message: Prisma.MessageGetPayload<{ include: { conversation: true } }>;
} | { error: "not_found" | "forbidden" }> {
  const { prisma, messageId, viewerIdentityId } = args;
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: true },
  });
  if (!message) return { error: "not_found" };
  const c = message.conversation;
  if (c.identityIdLow !== viewerIdentityId && c.identityIdHigh !== viewerIdentityId) {
    return { error: "forbidden" };
  }
  return { message };
}
