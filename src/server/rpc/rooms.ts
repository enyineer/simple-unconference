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

function toRoomOut(r: {
  id: number; name: string; capacity: number;
  description: string | null;
  tags: { value: string }[];
}) {
  return {
    id: r.id,
    name: r.name,
    capacity: r.capacity,
    description: r.description,
    tags: r.tags.map((t) => t.value),
  };
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
    const [total, rooms] = await Promise.all([
      context.prisma.room.count({ where }),
      context.prisma.room.findMany({
        where,
        orderBy: [{ capacity: "desc" }, { name: "asc" }],
        include: { tags: { select: { value: true }, orderBy: { value: "asc" } } },
        skip: offset,
        take: limit,
      }),
    ]);
    return pageOf(rooms.map(toRoomOut), offset, limit, total);
  }),

  // Unpaginated list. Used by surfaces that have to enumerate every room
  // (slot pickers, session room-tag picker, expert/agenda views).
  listAll: requireConf("participant").rooms.listAll.handler(async ({ context }) => {
    const rooms = await context.prisma.room.findMany({
      where: { conferenceId: context.conferenceId },
      orderBy: [{ capacity: "desc" }, { name: "asc" }],
      include: { tags: { select: { value: true }, orderBy: { value: "asc" } } },
    });
    return rooms.map(toRoomOut);
  }),

  create: requireConf("moderator").rooms.create.handler(async ({ input, context }) => {
    const roomCount = await context.prisma.room.count({
      where: { conferenceId: context.conferenceId },
    });
    assertQuota("rooms_per_conference", LIMITS.maxRoomsPerConference, roomCount);

    const tags = normalizeLabels(input.tags);
    const room = await context.prisma.room.create({
      data: {
        conferenceId: context.conferenceId,
        name: input.name, capacity: input.capacity,
        description: input.description ?? null,
        tags: { create: tags.map((value) => ({ value })) },
      },
      include: { tags: { select: { value: true }, orderBy: { value: "asc" } } },
    });
    void notifyQuotaThreshold(context.prisma, context.conferenceId, {
      resource: "rooms_per_conference",
      label: "Rooms",
      current: roomCount + 1,
      limit: LIMITS.maxRoomsPerConference,
    });
    return toRoomOut(room);
  }),

  update: requireConf("moderator").rooms.update.handler(async ({ input, context }) => {
    const cur = await context.prisma.room.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    if (!cur) throw new ORPCError("NOT_FOUND");
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
