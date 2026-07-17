// Web Push subscription management. Per conference identity: the browser hands
// the SPA a subscription (endpoint + p256dh/auth keys) when the participant
// opts into OS-level notifications; we upsert it here so `createNotification`
// can fan a push out to every registered device. Unsubscribe drops the row.
//
// See src/server/lib/webpush.ts for the send side and the privacy contract.

import { requireConf, actorIdentityId } from "./shared";

export const pushRouter = {
  subscribe: requireConf("participant").push.subscribe.handler(async ({ input, context }) => {
    const identityId = actorIdentityId(context);
    // Upsert on (identity, endpoint): re-subscribing the same browser refreshes
    // its keys instead of piling up duplicate rows. The keys DO rotate when a
    // browser re-subscribes, so update them on conflict.
    await context.prisma.pushSubscription.upsert({
      where: { identityId_endpoint: { identityId, endpoint: input.endpoint } },
      create: {
        identityId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.user_agent ?? null,
      },
      update: {
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.user_agent ?? null,
      },
    });
    return { ok: true as const };
  }),

  unsubscribe: requireConf("participant").push.unsubscribe.handler(async ({ input, context }) => {
    const identityId = actorIdentityId(context);
    // deleteMany so a stale/unknown endpoint (already gone, or another
    // identity's) is a silent no-op instead of throwing.
    await context.prisma.pushSubscription.deleteMany({
      where: { identityId, endpoint: input.endpoint },
    });
    return { ok: true as const };
  }),

  status: requireConf("participant").push.status.handler(async ({ input, context }) => {
    const identityId = actorIdentityId(context);
    // The browser subscription (endpoint) is shared across a user's conferences,
    // but delivery is per identity — so "on for this conference" means THIS
    // identity has a row for this exact endpoint.
    const row = await context.prisma.pushSubscription.findUnique({
      where: { identityId_endpoint: { identityId, endpoint: input.endpoint } },
      select: { id: true },
    });
    return { subscribed: row !== null };
  }),
};
