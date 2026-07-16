import { ORPCError } from "@orpc/server";
import type { Prisma } from "@prisma/client";
import {
  normalizeLabels,
  pageOf,
  parsePageInput,
  requireConf,
} from "./shared";
import { LIMITS, assertQuota } from "../lib/limits";
import { notifyQuotaThreshold } from "../notifications";
import { clipToMinute } from "../../shared/tz";
import {
  availabilityStranding,
  expertDedicatedRoomIds,
  slotUsedRoomIds,
} from "../lib/room-constraints";

function toRoomOut(
  r: {
    id: number; name: string; capacity: number;
    description: string | null;
    tags: { value: string }[];
    availabilities?: { startsAt: Date; endsAt: Date }[];
  },
  flags: { expertDedicated: boolean; slotUsed: boolean },
) {
  return {
    id: r.id,
    name: r.name,
    capacity: r.capacity,
    description: r.description,
    tags: r.tags.map((t) => t.value),
    availability: (r.availabilities ?? [])
      .map((a) => ({ starts_at: a.startsAt.getTime(), ends_at: a.endsAt.getTime() }))
      .sort((a, b) => a.starts_at - b.starts_at),
    expert_dedicated: flags.expertDedicated,
    slot_used: flags.slotUsed,
  };
}

// Normalize an availability input list to whole-minute Date bounds (parity with
// every other slot-time write). Order-preserving.
function toAvailabilityRows(
  windows: { starts_at: number; ends_at: number }[],
): { startsAt: Date; endsAt: Date }[] {
  return windows.map((w) => ({
    startsAt: new Date(clipToMinute(w.starts_at)),
    endsAt: new Date(clipToMinute(w.ends_at)),
  }));
}

export const roomsRouter = {
  list: requireConf("participant").rooms.list.handler(async ({ input, context }) => {
    const { offset, limit, q } = parsePageInput(input);
    // Free-text query matches room name OR description OR any tag value.
    // SQLite's default LIKE is case-insensitive for ASCII; good enough for
    // the room corpus (40-char labels, mostly english).
    const where: Prisma.RoomWhereInput = {
      conferenceId: context.conferenceId,
      ...(q
        ? {
            OR: [
              { name: { contains: q } },
              { description: { contains: q } },
              { tags: { some: { value: { contains: q } } } },
            ],
          }
        : {}),
    };
    // Conference-wide flag sets computed once (no N+1): which rooms are
    // expert-dedicated and which already carry slot usage.
    const [total, rooms, dedicated, slotUsed] = await Promise.all([
      context.prisma.room.count({ where }),
      context.prisma.room.findMany({
        where,
        orderBy: [{ capacity: "desc" }, { name: "asc" }],
        include: {
          tags: { select: { value: true }, orderBy: { value: "asc" } },
          availabilities: { select: { startsAt: true, endsAt: true } },
        },
        skip: offset,
        take: limit,
      }),
      expertDedicatedRoomIds(context.prisma, context.conferenceId),
      slotUsedRoomIds(context.prisma, context.conferenceId),
    ]);
    return pageOf(
      rooms.map((r) => toRoomOut(r, {
        expertDedicated: dedicated.has(r.id),
        slotUsed: slotUsed.has(r.id),
      })),
      offset, limit, total,
    );
  }),

  // Unpaginated list. Used by surfaces that have to enumerate every room
  // (slot pickers, session room-tag picker, expert/agenda views).
  listAll: requireConf("participant").rooms.listAll.handler(async ({ context }) => {
    const [rooms, dedicated, slotUsed] = await Promise.all([
      context.prisma.room.findMany({
        where: { conferenceId: context.conferenceId },
        orderBy: [{ capacity: "desc" }, { name: "asc" }],
        include: {
          tags: { select: { value: true }, orderBy: { value: "asc" } },
          availabilities: { select: { startsAt: true, endsAt: true } },
        },
      }),
      expertDedicatedRoomIds(context.prisma, context.conferenceId),
      slotUsedRoomIds(context.prisma, context.conferenceId),
    ]);
    return rooms.map((r) => toRoomOut(r, {
      expertDedicated: dedicated.has(r.id),
      slotUsed: slotUsed.has(r.id),
    }));
  }),

  create: requireConf("moderator").rooms.create.handler(async ({ input, context }) => {
    const roomCount = await context.prisma.room.count({
      where: { conferenceId: context.conferenceId },
    });
    assertQuota("rooms_per_conference", LIMITS.maxRoomsPerConference, roomCount);

    const tags = normalizeLabels(input.tags);
    const availability = toAvailabilityRows(input.availability ?? []);
    const room = await context.prisma.room.create({
      data: {
        conferenceId: context.conferenceId,
        name: input.name, capacity: input.capacity,
        description: input.description ?? null,
        tags: { create: tags.map((value) => ({ value })) },
        availabilities: { create: availability },
      },
      include: {
        tags: { select: { value: true }, orderBy: { value: "asc" } },
        availabilities: { select: { startsAt: true, endsAt: true } },
      },
    });
    void notifyQuotaThreshold(context.prisma, context.conferenceId, {
      resource: "rooms_per_conference",
      label: "Rooms",
      current: roomCount + 1,
      limit: LIMITS.maxRoomsPerConference,
    });
    // A brand-new room can't be dedicated or slot-used yet.
    return toRoomOut(room, { expertDedicated: false, slotUsed: false });
  }),

  update: requireConf("moderator").rooms.update.handler(async ({ input, context }) => {
    const cur = await context.prisma.room.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    if (!cur) throw new ORPCError("NOT_FOUND");
    // Availability replace-all. A non-empty new window set must not strand any
    // existing usage (track / placement / expert booking now outside the
    // windows). Clearing to always-available (empty array) never strands.
    if (input.availability !== undefined && input.availability.length > 0) {
      const newWindows = toAvailabilityRows(input.availability);
      const offenders = await availabilityStranding(
        context.prisma, context.conferenceId, input.id, newWindows,
      );
      if (offenders.length > 0) {
        throw new ORPCError("BAD_REQUEST", {
          message: "availability_strands_usage",
          data: { offenders },
        });
      }
    }
    await context.prisma.$transaction(async (tx) => {
      await tx.room.update({
        where: { id: input.id },
        data: {
          name: input.name ?? undefined,
          capacity: input.capacity ?? undefined,
          description: input.description === undefined ? undefined : input.description,
        },
      });
      if (input.tags !== undefined) {
        const tags = normalizeLabels(input.tags);
        await tx.roomTag.deleteMany({ where: { roomId: input.id } });
        if (tags.length > 0) {
          await tx.roomTag.createMany({
            data: tags.map((value) => ({ roomId: input.id, value })),
          });
        }
      }
      if (input.availability !== undefined) {
        await tx.roomAvailability.deleteMany({ where: { roomId: input.id } });
        const rows = toAvailabilityRows(input.availability);
        if (rows.length > 0) {
          await tx.roomAvailability.createMany({
            data: rows.map((r) => ({ roomId: input.id, startsAt: r.startsAt, endsAt: r.endsAt })),
          });
        }
      }
    });
    return { ok: true as const };
  }),

  delete: requireConf("moderator").rooms.delete.handler(async ({ input, context }) => {
    // Any unconference slot that placed a session in this room loses that
    // placement (UnconferencePlacement.room cascades on delete) → those slots
    // need a re-seat. Flag them stale before removing the room.
    const placements = await context.prisma.unconferencePlacement.findMany({
      where: { roomId: input.id, slot: { conferenceId: context.conferenceId, type: "unconference" } },
      select: { slotId: true },
    });
    const staleSlotIds = [...new Set(placements.map((p) => p.slotId))];
    await context.prisma.$transaction([
      context.prisma.agendaSlot.updateMany({
        where: { id: { in: staleSlotIds } }, data: { seatingStale: true },
      }),
      context.prisma.room.deleteMany({
        where: { id: input.id, conferenceId: context.conferenceId },
      }),
    ]);
    return { ok: true as const };
  }),
};
