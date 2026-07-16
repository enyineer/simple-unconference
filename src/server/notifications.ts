// =============================================================================
// CENTRAL NOTIFICATION HELPER — single entrypoint for ALL notification writes.
// =============================================================================
//
// CALLERS MUST USE `createNotification` / `createNotifications`.
// NEVER call `prisma.notification.create()` / `prisma.notification.createMany()`
// anywhere outside this file. Direct calls bypass:
//   - realtime bus fan-out (notifications would arrive only on page reload)
//   - dedupe coalescing safety (P2002 collisions on stale read rows)
//
// Why this file is the only one allowed to touch the table: notifications are
// realtime-critical. EVERY write must publish a `notification.upserted` bus
// event so connected SSE clients get the badge update without polling. The
// single-entrypoint rule makes that guarantee impossible to forget.
//
// Notifications are stored per-conference (keyed off ConferenceIdentity), so
// an owner participating in multiple conferences has a separate inbox per
// conference. `kind` is a free-form discriminator the client uses for
// icon/styling; `ctaHref` uses the custom `tab:<key>` form so the conference
// page can switch tabs in-place without a full navigation.

import type { PrismaClient } from "@prisma/client";
import { getBus } from "./realtime/bus";

export type NotificationKind =
  | "submission_published"
  | "submission_rejected"
  | "submission_received"
  | "unconf_assigned"
  | "mixer_assigned"
  | "expert_booked"
  | "expert_booking_cancelled"
  // Chat-domain kinds.
  | "chat_message"
  | "chat_report"
  | "chat_warning"
  // Planned-slot schedule change (talk scheduled / moved / removed). Coalesced
  // per (slot, submission) via dedupeKey "track:<slotId>:<submissionId>".
  | "schedule_changed"
  // Mod-only heads-up when a per-conference quota crosses 80% or hits 100%.
  // Fired by `notifyQuotaThreshold` exactly twice per resource per lifetime.
  | "quota_threshold";

export interface NotificationInput {
  identityId: number;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  // Coalescing key. If set, multiple events with the same
  // (identityId, dedupeKey) collapse into a single bell row whose
  // unreadCount increments — useful for chat floods, repeat reports, etc.
  // Omit (or pass null) for one-shot notifications that should always
  // produce a distinct row (warnings, bookings, quota crossings).
  dedupeKey?: string | null;
}

// PUBLIC API: create one notification. Always publishes the realtime bus
// event. Safe to call repeatedly with the same `dedupeKey` — handles the
// existing-row-read / existing-row-unread / no-row cases.
export async function createNotification(
  prisma: PrismaClient,
  input: NotificationInput,
): Promise<{ id: number }> {
  const id = await writeNotification(prisma, input);
  getBus().publish({
    kind: "notification.upserted",
    recipientId: input.identityId,
    notificationId: id,
  });
  return { id };
}

// PUBLIC API: batch helper. Loops through createNotification so each insert
// keeps its own dedupe semantics AND each recipient gets their bus event.
// Used by quota threshold, assignment fan-out, etc.
export async function createNotifications(
  prisma: PrismaClient,
  inputs: NotificationInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  for (const input of inputs) {
    await createNotification(prisma, input);
  }
}

// --- Internal --------------------------------------------------------------
//
// Writes one notification row, returning its id. Handles both the
// "no dedupeKey" plain insert and the "with dedupeKey" upsert paths.
//
// Why this is internal: nothing outside this module should write
// notifications without also fanning out the bus event. createNotification
// is the wrapper that does both atomically.
async function writeNotification(
  prisma: PrismaClient,
  n: NotificationInput,
): Promise<number> {
  const data = {
    kind: n.kind,
    title: n.title,
    body: n.body ?? null,
    ctaLabel: n.ctaLabel ?? null,
    ctaHref: n.ctaHref ?? null,
  };

  // No coalescing — plain insert.
  if (n.dedupeKey == null) {
    const row = await prisma.notification.create({
      data: { identityId: n.identityId, ...data },
      select: { id: true },
    });
    return row.id;
  }

  // Coalesced path. The unique index on (identityId, dedupeKey) means any
  // existing row (read OR unread) with the same key would otherwise collide
  // on insert with a P2002. We:
  //
  //   1. findFirst by (identityId, dedupeKey). We use findFirst (not
  //      findUnique on the compound index) because Prisma's compound-unique
  //      lookup with a nullable column has had cross-version quirks; plain
  //      equality is always reliable.
  //   2. If found → update by primary key id:
  //        - was read   → resurrect (readAt=null, unreadCount=1)
  //        - was unread → increment unreadCount, refresh body/createdAt
  //   3. If not found → create. A concurrent caller could insert between
  //      (1) and (3), yielding P2002. Catch that exact code and re-resolve
  //      via findFirst+update so the call still succeeds.
  const dedupeKey = n.dedupeKey;
  const upsertExisting = async (existing: {
    id: number;
    readAt: Date | null;
  }): Promise<number> => {
    const wasRead = existing.readAt !== null;
    await prisma.notification.update({
      where: { id: existing.id },
      data: {
        ...data,
        createdAt: new Date(),
        readAt: wasRead ? null : undefined,
        unreadCount: wasRead ? 1 : { increment: 1 },
      },
      select: { id: true },
    });
    return existing.id;
  };

  const existing = await prisma.notification.findFirst({
    where: { identityId: n.identityId, dedupeKey },
    select: { id: true, readAt: true },
  });
  if (existing) return upsertExisting(existing);

  try {
    const row = await prisma.notification.create({
      data: { identityId: n.identityId, dedupeKey, unreadCount: 1, ...data },
      select: { id: true },
    });
    return row.id;
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "P2002") throw err;
    const after = await prisma.notification.findFirst({
      where: { identityId: n.identityId, dedupeKey },
      select: { id: true, readAt: true },
    });
    if (!after) throw err;
    return upsertExisting(after);
  }
}

// --- Higher-level helpers --------------------------------------------------

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

  await createNotifications(
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
