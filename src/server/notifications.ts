// In-app notification helpers. Notifications are stored per-conference (keyed
// off ConferenceIdentity) so an owner who participates in multiple conferences
// has a separate inbox per conference. `kind` is a free-form discriminator the
// client uses for icon/styling; `ctaHref` uses the custom `tab:<key>` form so
// the conference page can switch tabs in-place without a full navigation.

import type { PrismaClient } from "@prisma/client";

export type NotificationKind =
  | "submission_published"
  | "submission_rejected"
  | "submission_received"
  | "unconf_assigned"
  | "mixer_assigned"
  | "expert_booked"
  | "expert_booking_cancelled";

export interface CreateNotification {
  identityId: number;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  ctaLabel?: string | null;
  ctaHref?: string | null;
}

export async function notify(prisma: PrismaClient, n: CreateNotification): Promise<void> {
  await prisma.notification.create({
    data: {
      identityId: n.identityId,
      kind: n.kind,
      title: n.title,
      body: n.body ?? null,
      ctaLabel: n.ctaLabel ?? null,
      ctaHref: n.ctaHref ?? null,
    },
  });
}

export async function notifyMany(
  prisma: PrismaClient,
  notifications: CreateNotification[],
): Promise<void> {
  if (notifications.length === 0) return;
  await prisma.notification.createMany({
    data: notifications.map((n) => ({
      identityId: n.identityId,
      kind: n.kind,
      title: n.title,
      body: n.body ?? null,
      ctaLabel: n.ctaLabel ?? null,
      ctaHref: n.ctaHref ?? null,
    })),
  });
}

// Returns every identity in the conference whose role can act on submissions
// (mods + owner-as-identity). Used to notify the moderator queue when a new
// submission lands.
export async function modIdentityIds(prisma: PrismaClient, conferenceId: number): Promise<number[]> {
  const rows = await prisma.conferenceIdentity.findMany({
    where: {
      conferenceId,
      OR: [
        { role: "moderator" },
        { ownerUserId: { not: null } },
      ],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
