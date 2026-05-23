import { ORPCError } from "@orpc/server";
import { requireConf, normalizeLabels } from "./shared";
import { LIMITS, assertQuota } from "../lib/limits";
import { notifyQuotaThreshold } from "../notifications";

export const roomsRouter = {
  list: requireConf("participant").rooms.list.handler(async ({ context }) => {
    const rooms = await context.prisma.room.findMany({
      where: { conferenceId: context.conferenceId },
      orderBy: [{ capacity: "desc" }, { name: "asc" }],
      include: { tags: { select: { value: true }, orderBy: { value: "asc" } } },
    });
    return rooms.map((r) => ({
      id: r.id, name: r.name, capacity: r.capacity,
      description: r.description,
      tags: r.tags.map((t) => t.value),
    }));
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
    return {
      id: room.id, name: room.name, capacity: room.capacity,
      description: room.description, tags: room.tags.map((t) => t.value),
    };
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
    await context.prisma.room.deleteMany({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    return { ok: true as const };
  }),
};
