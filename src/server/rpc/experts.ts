import { ORPCError } from "@orpc/server";
import type { PrismaClient } from "@prisma/client";
import { requireConf, actorIdentityId } from "./shared";
import { clipToMinute } from "../../shared/tz";
import { deriveSlots, pickAvailableRoom } from "../experts";
import { notifyMany } from "../notifications";

// Returns the candidate room id list for an expert: pool members if poolId is
// set, otherwise the explicit ExpertRoom set. Either may be empty.
async function expertCandidateRoomIds(
  prisma: PrismaClient,
  expert: { id: number; poolId: number | null },
): Promise<number[]> {
  if (expert.poolId !== null) {
    const rows = await prisma.expertRoomPoolRoom.findMany({
      where: { poolId: expert.poolId }, select: { roomId: true },
    });
    return rows.map((r) => r.roomId);
  }
  const rows = await prisma.expertRoom.findMany({
    where: { expertId: expert.id }, select: { roomId: true },
  });
  return rows.map((r) => r.roomId);
}

// Build the full expert payload (timeframes + derived slots) for the experts
// list endpoint. `viewerIdentityId` lets the booker see their own row
// unmasked even when they're a non-mod.
async function buildExpertOut(
  prisma: PrismaClient,
  conferenceId: number,
  expertIds: number[],
  isMod: boolean,
  viewerIdentityId: number,
) {
  if (expertIds.length === 0) return [];
  const experts = await prisma.expert.findMany({
    where: { id: { in: expertIds }, conferenceId },
    include: {
      identity: { select: { id: true, name: true, email: true, profilePublished: true } },
      pool: { select: { id: true, name: true } },
      rooms: { select: { roomId: true } },
      timeframes: { orderBy: { startsAt: "asc" } },
      bookings: {
        include: { booker: { select: { id: true, name: true, email: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return experts.map((e) => {
    const slots = e.timeframes.flatMap((tf) => {
      const windows = deriveSlots(tf.startsAt, tf.endsAt, tf.slotDurationMinutes);
      return windows.map((w) => {
        const booking = e.bookings.find((b) => b.startsAt.getTime() === w.startsAt);
        const isMine = booking !== undefined && booking.bookerId === viewerIdentityId;
        const showBooker = isMod || isMine;
        return {
          starts_at: w.startsAt,
          ends_at: w.endsAt,
          timeframe_id: tf.id,
          booking_id: booking?.id ?? null,
          booker_name: booking && showBooker ? booking.booker.name : null,
          booker_email: booking && showBooker ? booking.booker.email : null,
          room_id: booking?.roomId ?? null,
          is_mine: isMine,
        };
      });
    }).sort((a, b) => a.starts_at - b.starts_at);

    return {
      id: e.id,
      identity_id: e.identityId,
      name: e.identity.name,
      // Expert's own email is treated like submitter_email — mods only.
      email: isMod ? e.identity.email : null,
      profile_published: e.identity.profilePublished,
      bio: e.bio,
      pool_id: e.poolId,
      pool_name: e.pool?.name ?? null,
      room_ids: e.rooms.map((r) => r.roomId),
      timeframes: e.timeframes.map((tf) => ({
        id: tf.id,
        starts_at: tf.startsAt.getTime(),
        ends_at: tf.endsAt.getTime(),
        slot_duration_minutes: tf.slotDurationMinutes,
      })),
      slots,
    };
  });
}

export const expertsRouter = {
  // --- pools (mod+) ----------------------------------------------------
  listPools: requireConf("moderator").experts.listPools.handler(async ({ context }) => {
    const pools = await context.prisma.expertRoomPool.findMany({
      where: { conferenceId: context.conferenceId },
      include: {
        rooms: { select: { roomId: true } },
        _count: { select: { experts: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return pools.map((p) => ({
      id: p.id,
      name: p.name,
      room_ids: p.rooms.map((r) => r.roomId),
      expert_count: p._count.experts,
    }));
  }),

  createPool: requireConf("moderator").experts.createPool.handler(async ({ input, context }) => {
    const roomIds = input.room_ids ?? [];
    return context.prisma.$transaction(async (tx) => {
      const dup = await tx.expertRoomPool.findFirst({
        where: { conferenceId: context.conferenceId, name: input.name },
        select: { id: true },
      });
      if (dup) throw new ORPCError("CONFLICT", { message: "pool_name_taken" });
      // Validate rooms belong to this conference.
      const validRooms = roomIds.length === 0 ? [] : await tx.room.findMany({
        where: { conferenceId: context.conferenceId, id: { in: roomIds } },
        select: { id: true },
      });
      const pool = await tx.expertRoomPool.create({
        data: {
          conferenceId: context.conferenceId,
          name: input.name,
          rooms: { create: validRooms.map((r) => ({ roomId: r.id })) },
        },
        include: {
          rooms: { select: { roomId: true } },
          _count: { select: { experts: true } },
        },
      });
      return {
        id: pool.id,
        name: pool.name,
        room_ids: pool.rooms.map((r) => r.roomId),
        expert_count: pool._count.experts,
      };
    });
  }),

  updatePool: requireConf("moderator").experts.updatePool.handler(async ({ input, context }) => {
    const cur = await context.prisma.expertRoomPool.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!cur) throw new ORPCError("NOT_FOUND");
    await context.prisma.$transaction(async (tx) => {
      if (input.name !== undefined) {
        const dup = await tx.expertRoomPool.findFirst({
          where: { conferenceId: context.conferenceId, name: input.name, NOT: { id: input.id } },
          select: { id: true },
        });
        if (dup) throw new ORPCError("CONFLICT", { message: "pool_name_taken" });
        await tx.expertRoomPool.update({ where: { id: input.id }, data: { name: input.name } });
      }
      if (input.room_ids !== undefined) {
        const validRooms = await tx.room.findMany({
          where: { conferenceId: context.conferenceId, id: { in: input.room_ids } },
          select: { id: true },
        });
        await tx.expertRoomPoolRoom.deleteMany({ where: { poolId: input.id } });
        if (validRooms.length > 0) {
          await tx.expertRoomPoolRoom.createMany({
            data: validRooms.map((r) => ({ poolId: input.id, roomId: r.id })),
          });
        }
      }
    });
    return { ok: true as const };
  }),

  deletePool: requireConf("moderator").experts.deletePool.handler(async ({ input, context }) => {
    await context.prisma.expertRoomPool.deleteMany({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    return { ok: true as const };
  }),

  // --- expert list (visible to all conference members) ----------------
  list: requireConf("participant").experts.list.handler(async ({ context }) => {
    const all = await context.prisma.expert.findMany({
      where: { conferenceId: context.conferenceId },
      select: { id: true },
    });
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    return buildExpertOut(
      context.prisma, context.conferenceId,
      all.map((e) => e.id), isMod, actorIdentityId(context),
    );
  }),

  promote: requireConf("moderator").experts.promote.handler(async ({ input, context }) => {
    // Identity must belong to this conference.
    const ident = await context.prisma.conferenceIdentity.findFirst({
      where: { id: input.identity_id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!ident) throw new ORPCError("NOT_FOUND", { message: "not_a_member" });
    const existing = await context.prisma.expert.findUnique({
      where: { identityId: input.identity_id }, select: { id: true },
    });
    if (existing) throw new ORPCError("CONFLICT", { message: "already_expert" });

    if (input.pool_id != null) {
      const pool = await context.prisma.expertRoomPool.findFirst({
        where: { id: input.pool_id, conferenceId: context.conferenceId },
        select: { id: true },
      });
      if (!pool) throw new ORPCError("NOT_FOUND", { message: "pool_not_found" });
    }
    const roomIds = input.room_ids ?? [];
    const validRooms = roomIds.length === 0 ? [] : await context.prisma.room.findMany({
      where: { conferenceId: context.conferenceId, id: { in: roomIds } },
      select: { id: true },
    });
    const expert = await context.prisma.expert.create({
      data: {
        conferenceId: context.conferenceId,
        identityId: input.identity_id,
        poolId: input.pool_id ?? null,
        bio: input.bio?.trim() || null,
        rooms: { create: validRooms.map((r) => ({ roomId: r.id })) },
      },
      select: { id: true },
    });
    return { id: expert.id };
  }),

  update: requireConf("moderator").experts.update.handler(async ({ input, context }) => {
    const cur = await context.prisma.expert.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!cur) throw new ORPCError("NOT_FOUND");
    if (input.pool_id !== undefined && input.pool_id !== null) {
      const pool = await context.prisma.expertRoomPool.findFirst({
        where: { id: input.pool_id, conferenceId: context.conferenceId },
        select: { id: true },
      });
      if (!pool) throw new ORPCError("NOT_FOUND", { message: "pool_not_found" });
    }
    await context.prisma.$transaction(async (tx) => {
      const data: { bio?: string | null; poolId?: number | null } = {};
      if (input.bio !== undefined) data.bio = input.bio === null ? null : (input.bio.trim() || null);
      if (input.pool_id !== undefined) data.poolId = input.pool_id;
      if (Object.keys(data).length > 0) {
        await tx.expert.update({ where: { id: input.id }, data });
      }
      if (input.room_ids !== undefined) {
        const validRooms = await tx.room.findMany({
          where: { conferenceId: context.conferenceId, id: { in: input.room_ids } },
          select: { id: true },
        });
        await tx.expertRoom.deleteMany({ where: { expertId: input.id } });
        if (validRooms.length > 0) {
          await tx.expertRoom.createMany({
            data: validRooms.map((r) => ({ expertId: input.id, roomId: r.id })),
          });
        }
      }
    });
    return { ok: true as const };
  }),

  demote: requireConf("moderator").experts.demote.handler(async ({ input, context }) => {
    await context.prisma.expert.deleteMany({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    return { ok: true as const };
  }),

  // --- timeframes (mod+) ----------------------------------------------
  createTimeframe: requireConf("moderator").experts.createTimeframe.handler(async ({ input, context }) => {
    if (input.ends_at <= input.starts_at) {
      throw new ORPCError("BAD_REQUEST", { message: "ends_before_starts" });
    }
    if ((input.ends_at - input.starts_at) < input.slot_duration_minutes * 60_000) {
      throw new ORPCError("BAD_REQUEST", { message: "timeframe_too_short" });
    }
    const expert = await context.prisma.expert.findFirst({
      where: { id: input.expert_id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!expert) throw new ORPCError("NOT_FOUND");
    const created = await context.prisma.expertTimeframe.create({
      data: {
        expertId: expert.id,
        startsAt: new Date(clipToMinute(input.starts_at)),
        endsAt: new Date(clipToMinute(input.ends_at)),
        slotDurationMinutes: input.slot_duration_minutes,
      },
      select: { id: true },
    });
    return { id: created.id };
  }),

  deleteTimeframe: requireConf("moderator").experts.deleteTimeframe.handler(async ({ input, context }) => {
    // Bookings under the timeframe cascade-delete via Prisma relation.
    const expert = await context.prisma.expert.findFirst({
      where: { id: input.expert_id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!expert) throw new ORPCError("NOT_FOUND");
    await context.prisma.expertTimeframe.deleteMany({
      where: { id: input.id, expertId: expert.id },
    });
    return { ok: true as const };
  }),

  // --- bookings -------------------------------------------------------
  book: requireConf("participant").experts.book.handler(async ({ input, context }) => {
    const myId = actorIdentityId(context);
    return context.prisma.$transaction(async (tx) => {
      const expert = await tx.expert.findFirst({
        where: { id: input.expert_id, conferenceId: context.conferenceId },
        select: { id: true, poolId: true, identityId: true },
      });
      if (!expert) throw new ORPCError("NOT_FOUND", { message: "expert_not_found" });
      if (expert.identityId === myId) {
        throw new ORPCError("BAD_REQUEST", { message: "cannot_book_self" });
      }
      // Find a timeframe that contains this slot start. The slot length is
      // the timeframe's slotDurationMinutes; verify alignment.
      const candidateFrames = await tx.expertTimeframe.findMany({
        where: { expertId: expert.id },
      });
      // Normalize the requested start to whole-minute granularity (same as
      // every other slot-time write in the system). Timeframes are clipped
      // on create, so derived slot starts are always at :00 — a raw-ms
      // input that happened to include seconds would never match otherwise.
      const requestedStart = clipToMinute(input.starts_at);
      let frame: typeof candidateFrames[number] | null = null;
      let slotEnd = 0;
      for (const tf of candidateFrames) {
        const slots = deriveSlots(tf.startsAt, tf.endsAt, tf.slotDurationMinutes);
        const hit = slots.find((s) => s.startsAt === requestedStart);
        if (hit) { frame = tf; slotEnd = hit.endsAt; break; }
      }
      if (!frame) throw new ORPCError("NOT_FOUND", { message: "slot_not_found" });
      if (requestedStart <= Date.now()) {
        throw new ORPCError("CONFLICT", { message: "slot_in_past" });
      }
      // Max 1 booking per expert for this booker.
      const mine = await tx.expertBooking.findFirst({
        where: { expertId: expert.id, bookerId: myId },
        select: { id: true },
      });
      if (mine) throw new ORPCError("CONFLICT", { message: "already_booked_expert" });
      // No overlapping bookings on the booker's calendar (any expert).
      const overlapping = await tx.expertBooking.findFirst({
        where: {
          bookerId: myId,
          startsAt: { lt: new Date(slotEnd) },
          endsAt: { gt: new Date(requestedStart) },
        },
        select: { id: true },
      });
      if (overlapping) throw new ORPCError("CONFLICT", { message: "overlapping_booking" });

      // Pick a room. Conflicts considered across the whole conference's
      // expert bookings — rooms aren't multi-tenant for this feature.
      const candidateRoomIds = await expertCandidateRoomIds(tx as unknown as PrismaClient, expert);
      if (candidateRoomIds.length === 0) {
        throw new ORPCError("CONFLICT", { message: "no_rooms_configured" });
      }
      const conflictingRows = await tx.expertBooking.findMany({
        where: {
          roomId: { in: candidateRoomIds },
          startsAt: { lt: new Date(slotEnd) },
          endsAt: { gt: new Date(requestedStart) },
        },
        select: { roomId: true, startsAt: true, endsAt: true },
      });
      const roomId = pickAvailableRoom(
        candidateRoomIds,
        conflictingRows.map((r) => ({
          roomId: r.roomId, startsAt: r.startsAt.getTime(), endsAt: r.endsAt.getTime(),
        })),
        { startsAt: requestedStart, endsAt: slotEnd },
      );
      if (roomId === null) {
        throw new ORPCError("CONFLICT", { message: "no_room_available" });
      }
      const booking = await tx.expertBooking.create({
        data: {
          expertId: expert.id,
          timeframeId: frame.id,
          bookerId: myId,
          roomId,
          startsAt: new Date(requestedStart),
          endsAt: new Date(slotEnd),
        },
      });
      // Notify the expert that they were just booked. The booker doesn't get
      // their own notification — they performed the action and see the success
      // state in the booking UI directly.
      const booker = await tx.conferenceIdentity.findUniqueOrThrow({
        where: { id: myId }, select: { name: true, email: true },
      });
      await tx.notification.create({
        data: {
          identityId: expert.identityId,
          kind: "expert_booked",
          title: "You were booked",
          body: `${booker.name ?? booker.email} reserved a slot with you.`,
          ctaLabel: "Open schedule",
          ctaHref: "tab:me",
        },
      });
      return {
        booking_id: booking.id,
        room_id: booking.roomId,
        starts_at: booking.startsAt.getTime(),
        ends_at: booking.endsAt.getTime(),
      };
    });
  }),

  cancelBooking: requireConf("participant").experts.cancelBooking.handler(async ({ input, context }) => {
    const booking = await context.prisma.expertBooking.findFirst({
      where: {
        id: input.booking_id,
        expert: { conferenceId: context.conferenceId },
      },
      include: { expert: { select: { identityId: true } } },
    });
    if (!booking) throw new ORPCError("NOT_FOUND");
    const myId = actorIdentityId(context);
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    const isBooker = booking.bookerId === myId;
    const isExpert = booking.expert.identityId === myId;
    if (!isMod && !isBooker && !isExpert) throw new ORPCError("FORBIDDEN");
    if (!isMod && booking.startsAt.getTime() <= Date.now()) {
      throw new ORPCError("CONFLICT", { message: "slot_in_past" });
    }
    await context.prisma.expertBooking.delete({ where: { id: booking.id } });
    // Notify the party who didn't cancel. If a mod cancelled, notify both.
    const recipients: number[] = [];
    if (isMod && !isBooker && !isExpert) {
      recipients.push(booking.bookerId, booking.expert.identityId);
    } else if (isBooker) {
      recipients.push(booking.expert.identityId);
    } else if (isExpert) {
      recipients.push(booking.bookerId);
    }
    await notifyMany(context.prisma, recipients.map((identityId) => ({
      identityId,
      kind: "expert_booking_cancelled" as const,
      title: "An expert booking was cancelled",
      body: null,
      ctaLabel: "Open experts",
      ctaHref: "tab:experts",
    })));
    return { ok: true as const };
  }),
};
