import { requireConf, actorIdentityId } from "./shared";

export const notificationsRouter = {
  list: requireConf("participant").notifications.list.handler(async ({ context }) => {
    const identityId = actorIdentityId(context);
    const [items, unread] = await Promise.all([
      // Cap at 50 — the bell UI is for recent activity, not an archive. Older
      // notifications fall off; nothing references them.
      context.prisma.notification.findMany({
        where: { identityId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      context.prisma.notification.count({
        where: { identityId, readAt: null },
      }),
    ]);
    return {
      items: items.map((n) => ({
        id: n.id,
        kind: n.kind as
          | "submission_published" | "submission_rejected" | "submission_received"
          | "unconf_assigned" | "mixer_assigned"
          | "expert_booked" | "expert_booking_cancelled",
        title: n.title,
        body: n.body,
        cta_label: n.ctaLabel,
        cta_href: n.ctaHref,
        read_at: n.readAt ? n.readAt.getTime() : null,
        created_at: n.createdAt.getTime(),
      })),
      unread_count: unread,
    };
  }),

  markRead: requireConf("participant").notifications.markRead.handler(async ({ input, context }) => {
    const identityId = actorIdentityId(context);
    // updateMany so a stale id (already deleted, or owned by another identity)
    // is a silent no-op instead of throwing.
    await context.prisma.notification.updateMany({
      where: { id: input.id, identityId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true as const };
  }),

  markAllRead: requireConf("participant").notifications.markAllRead.handler(async ({ context }) => {
    const identityId = actorIdentityId(context);
    await context.prisma.notification.updateMany({
      where: { identityId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true as const };
  }),
};
