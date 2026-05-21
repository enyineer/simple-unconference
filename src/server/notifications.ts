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
  | "expert_booking_cancelled"
  // Mod-only heads-up that a per-conference quota is filling up. Fired by
  // `notifyQuotaThreshold` exactly twice over a conference's lifetime per
  // resource: when the post-insert count hits ceil(0.8 * limit), and again
  // when it hits the cap.
  | "quota_threshold";

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

// Mod-facing heads-up when a per-conference quota crosses 80% or hits 100%.
// Idempotent-by-construction: only fires when `current` is the exact integer
// that crosses a threshold, so each crossing produces one notification
// regardless of concurrent inserts (DB does the ordering).
//
// `resource` is a stable key matching the same identifiers the server uses
// in `quota_exceeded` error data (e.g. "participants_per_conference"), so
// clients can route on either signal with the same vocabulary.
export async function notifyQuotaThreshold(
  prisma: PrismaClient,
  conferenceId: number,
  args: { resource: string; label: string; current: number; limit: number },
): Promise<void> {
  if (args.limit === 0) return; // unlimited
  const eightyPercent = Math.ceil(args.limit * 0.8);
  const isWarn = args.current === eightyPercent && eightyPercent < args.limit;
  const isFull = args.current === args.limit;
  if (!isWarn && !isFull) return;

  const mods = await modIdentityIds(prisma, conferenceId);
  if (mods.length === 0) return;

  const title = isFull
    ? `${args.label} cap reached`
    : `${args.label} at 80%`;
  const body = isFull
    ? `This conference has hit its ${args.label.toLowerCase()} cap of ${args.limit}. New ${args.label.toLowerCase()} will be rejected until the cap is raised on the instance.`
    : `${args.current} of ${args.limit} ${args.label.toLowerCase()} used. Consider raising the cap before the event starts to avoid blocking new entries.`;

  await notifyMany(
    prisma,
    mods.map((identityId) => ({
      identityId,
      kind: "quota_threshold" as const,
      title,
      body,
      ctaLabel: "Open settings",
      ctaHref: "tab:settings",
    })),
  );
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
