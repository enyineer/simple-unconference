// Day-of broadcast (F2). A moderator sends one short message that fans out as
// an `announcement` notification to every conference identity. Realtime
// delivery + bell coalescing are handled by the central notifications helper —
// this router only resolves recipients and calls it.

import { requireConf } from "./shared";
import { createNotifications } from "../notifications";

export const announcementsRouter = {
  send: requireConf("moderator").announcements.send.handler(async ({ input, context }) => {
    // The sender is included too (KISS: they see exactly what everyone saw).
    const identities = await context.prisma.conferenceIdentity.findMany({
      where: { conferenceId: context.conferenceId },
      select: { id: true },
    });
    // Each announcement is a distinct bell row — no dedupeKey coalescing.
    await createNotifications(
      context.prisma,
      identities.map((i) => ({
        identityId: i.id,
        kind: "announcement" as const,
        title: "Announcement",
        body: input.message,
      })),
    );
    return { ok: true as const };
  }),
};
