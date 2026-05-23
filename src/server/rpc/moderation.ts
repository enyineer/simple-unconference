// Moderator-only surface for chat reports + bans. See plans/chat.md Phase 8.
//
// resolveChatReport actions:
//   - dismiss: marks the report resolved with no further effect.
//   - warn: sends a chat_warning notification to the offending sender,
//           includes the report reason so they understand why.
//   - ban: sets chatBannedAt + reason + actor on the sender's identity,
//          and soft-deletes the offending message (deletedReason="moderator").
//
// Report payload includes the message + full revision chain + N surrounding
// messages so mods can judge context without manually paging.

import { ORPCError } from "@orpc/server";
import type { PrismaClient } from "@prisma/client";
import { requireConf } from "./shared";
import { serializeMessage } from "./chat-helpers";
import { getBus } from "../realtime/bus";
import { createNotification } from "../notifications";

// How many messages to include on each side of the reported message.
// Keeps payload bounded and avoids leaking the entire conversation when
// the report only covers one message.
const REPORT_CONTEXT_WINDOW = 5;

async function buildReportPayload(prisma: PrismaClient, reportId: number) {
  const report = await prisma.messageReport.findUnique({
    where: { id: reportId },
    include: {
      reporter: { select: { id: true, name: true } },
      message: {
        include: {
          sender: { select: { id: true, name: true } },
          revisions: { orderBy: { createdAt: "asc" } },
          conversation: { select: { id: true } },
        },
      },
    },
  });
  if (!report) return null;
  const conversationId = report.message.conversation.id;

  const [before, after] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId, id: { lt: report.message.id } },
      orderBy: { id: "desc" },
      take: REPORT_CONTEXT_WINDOW,
    }),
    prisma.message.findMany({
      where: { conversationId, id: { gt: report.message.id } },
      orderBy: { id: "asc" },
      take: REPORT_CONTEXT_WINDOW,
    }),
  ]);
  const surrounding = [...before.reverse(), ...after];

  return {
    id: report.id,
    message_id: report.message.id,
    conversation_id: conversationId,
    reason: report.reason,
    reporter_identity_id: report.reporter.id,
    reporter_name: report.reporter.name,
    reported_sender_identity_id: report.message.sender.id,
    reported_sender_name: report.message.sender.name,
    created_at: report.createdAt.getTime(),
    resolved_at: report.resolvedAt?.getTime() ?? null,
    resolved_by_user_id: report.resolvedByUserId,
    action: (report.action ?? null) as "dismiss" | "warn" | "ban" | null,
    message: serializeMessage({
      message: report.message,
      viewerKind: "moderator",
      receiverReadReceiptsEnabled: true,
    }),
    revisions: report.message.revisions.map((r) => ({
      body: r.body,
      created_at: r.createdAt.getTime(),
    })),
    surrounding_messages: surrounding.map((m) => serializeMessage({
      message: m,
      viewerKind: "moderator",
      receiverReadReceiptsEnabled: true,
    })),
  };
}

export const moderationRouter = {
  // ----- listChatReports ---------------------------------------------------
  listChatReports: requireConf("moderator").moderation.listChatReports.handler(async ({ input, context }) => {
    const status = input.status ?? "open";
    const where: Parameters<typeof context.prisma.messageReport.findMany>[0] = {
      where: {
        message: { conversation: { conferenceId: context.conferenceId } },
        ...(status === "open" ? { resolvedAt: null } : {}),
        ...(status === "resolved" ? { resolvedAt: { not: null } } : {}),
      },
      orderBy: [{ resolvedAt: "asc" }, { createdAt: "desc" }],
    };
    const reports = await context.prisma.messageReport.findMany(where);
    const payloads = await Promise.all(reports.map((r) => buildReportPayload(context.prisma, r.id)));
    return payloads.filter((p): p is NonNullable<typeof p> => p !== null);
  }),

  // ----- resolveChatReport -------------------------------------------------
  resolveChatReport: requireConf("moderator").moderation.resolveChatReport.handler(async ({ input, context }) => {
    const moderator = context.principal;
    // Only the global User can be the resolver (it's a User FK); for owner-
    // principal that's `principal.user`. Identity-principal mods don't have
    // a User row — we still record the action but with resolved_by null.
    const resolverUserId = moderator.kind === "owner" ? moderator.user.id : null;

    const report = await context.prisma.messageReport.findUnique({
      where: { id: input.report_id },
      include: {
        message: { include: { conversation: true, sender: true } },
      },
    });
    if (!report) throw new ORPCError("NOT_FOUND");
    // Cross-conference safety.
    if (report.message.conversation.conferenceId !== context.conferenceId) {
      throw new ORPCError("NOT_FOUND");
    }
    if (report.resolvedAt) {
      // Idempotent re-resolution would muddy the audit trail. Reject.
      throw new ORPCError("FORBIDDEN", { message: "report_already_resolved" });
    }

    const now = new Date();

    // Moderator's own reason (entered in the resolve sheet) takes priority over
    // the reporter's reason — that text is what's shown to the offender.
    const modReason = input.mod_reason?.trim() ? input.mod_reason.trim() : report.reason;

    if (input.action === "ban") {
      await context.prisma.conferenceIdentity.update({
        where: { id: report.message.senderIdentityId },
        data: {
          chatBannedAt: now,
          chatBannedReason: modReason,
          chatBannedByUserId: resolverUserId,
        },
      });
      // Soft-delete the offending message so the receiver doesn't keep
      // seeing it. Mods retain visibility via the report payload + revisions.
      if (!report.message.deletedAt) {
        await context.prisma.message.update({
          where: { id: report.messageId },
          data: { deletedAt: now, deletedReason: "moderator" },
        });
        const c = report.message.conversation;
        const bus = getBus();
        bus.publish({ kind: "message.deleted", recipientId: c.identityIdLow, messageId: report.messageId, conversationId: c.id });
        bus.publish({ kind: "message.deleted", recipientId: c.identityIdHigh, messageId: report.messageId, conversationId: c.id });
      }
    } else if (input.action === "warn") {
      // Drop a chat_warning notification on the sender's bell so they
      // understand why they got dinged. Routed through createNotification so
      // the SSE bus event fires — the warned user sees it without a reload.
      await createNotification(context.prisma, {
        identityId: report.message.senderIdentityId,
        kind: "chat_warning",
        title: "Moderator warning",
        body: `A message you sent was reported. Reason: ${truncate(modReason, 200)}`,
      });
    }

    await context.prisma.messageReport.update({
      where: { id: input.report_id },
      data: {
        resolvedAt: now,
        resolvedByUserId: resolverUserId,
        action: input.action,
      },
    });
    return { ok: true as const };
  }),

  // ----- listChatBans ------------------------------------------------------
  listChatBans: requireConf("moderator").moderation.listChatBans.handler(async ({ context }) => {
    const rows = await context.prisma.conferenceIdentity.findMany({
      where: {
        conferenceId: context.conferenceId,
        chatBannedAt: { not: null },
      },
      select: {
        id: true, name: true, chatBannedReason: true, chatBannedAt: true,
        chatBannedBy: { select: { name: true, email: true } },
      },
      orderBy: { chatBannedAt: "desc" },
    });
    return rows.map((r) => ({
      identity_id: r.id,
      name: r.name,
      reason: r.chatBannedReason,
      banned_at: r.chatBannedAt!.getTime(),
      banned_by: r.chatBannedBy ? (r.chatBannedBy.name ?? r.chatBannedBy.email) : null,
    }));
  }),

  // ----- unbanFromChat -----------------------------------------------------
  unbanFromChat: requireConf("moderator").moderation.unbanFromChat.handler(async ({ input, context }) => {
    const target = await context.prisma.conferenceIdentity.findFirst({
      where: { id: input.identity_id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND");
    await context.prisma.conferenceIdentity.update({
      where: { id: target.id },
      data: { chatBannedAt: null, chatBannedReason: null, chatBannedByUserId: null },
    });
    return { ok: true as const };
  }),
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
