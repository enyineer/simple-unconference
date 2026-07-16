// Session takeaways (Harvest & Wrap-up, F3). Anyone in a conference can capture
// a short learning / link against a published session; the note is visible to
// every member. Author DISPLAY NAMES only ever leave this router — never
// emails (privacy parity with the wider profile / submission rules).

import { ORPCError } from "@orpc/server";
import { requireConf, actorIdentityId } from "./shared";
import type { TakeawayOut } from "../../shared/contract/types";

// Cheap per-identity anti-spam cap (KISS). Enough for genuine multi-note use,
// low enough that a single identity can't flood a session's takeaway list.
const MAX_TAKEAWAYS_PER_SUBMISSION = 10;

function toTakeawayOut(
  t: {
    id: number; submissionId: number; text: string; url: string | null;
    createdAt: Date; identityId: number; identity: { name: string | null };
  },
  viewerIdentityId: number,
): TakeawayOut {
  return {
    id: t.id,
    submission_id: t.submissionId,
    text: t.text,
    url: t.url,
    created_at: t.createdAt.getTime(),
    author_name: t.identity.name,
    author_identity_id: t.identityId,
    mine: t.identityId === viewerIdentityId,
  };
}

export const takeawaysRouter = {
  list: requireConf("participant").takeaways.list.handler(async ({ input, context }) => {
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    const me = actorIdentityId(context);
    const submission = await context.prisma.submission.findFirst({
      where: { id: input.submission_id, conferenceId: context.conferenceId },
      select: { id: true, status: true, submitterId: true },
    });
    // Existence isn't leaked: a submission the viewer can't otherwise see reads
    // as missing (mirrors submissions.list visibility — mods see all;
    // participants see published + their own).
    if (!submission
        || (!isMod && submission.status !== "published" && submission.submitterId !== me)) {
      throw new ORPCError("NOT_FOUND", { message: "submission_not_found" });
    }
    const rows = await context.prisma.sessionTakeaway.findMany({
      where: { submissionId: submission.id },
      orderBy: { createdAt: "desc" },
      include: { identity: { select: { name: true } } },
    });
    return rows.map((r) => toTakeawayOut(r, me));
  }),

  add: requireConf("participant").takeaways.add.handler(async ({ input, context }) => {
    const me = actorIdentityId(context);
    const submission = await context.prisma.submission.findFirst({
      where: { id: input.submission_id, conferenceId: context.conferenceId },
      select: { id: true, status: true },
    });
    if (!submission) throw new ORPCError("NOT_FOUND", { message: "submission_not_found" });
    if (submission.status !== "published") {
      throw new ORPCError("BAD_REQUEST", { message: "submission_not_published" });
    }
    const mine = await context.prisma.sessionTakeaway.count({
      where: { submissionId: submission.id, identityId: me },
    });
    if (mine >= MAX_TAKEAWAYS_PER_SUBMISSION) {
      throw new ORPCError("BAD_REQUEST", { message: "too_many_takeaways" });
    }
    const created = await context.prisma.sessionTakeaway.create({
      data: {
        submissionId: submission.id,
        identityId: me,
        text: input.text,
        url: input.url ?? null,
      },
      include: { identity: { select: { name: true } } },
    });
    return toTakeawayOut(created, me);
  }),

  remove: requireConf("participant").takeaways.remove.handler(async ({ input, context }) => {
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    const me = actorIdentityId(context);
    // Scope the lookup to the conference so a takeaway id from another
    // conference can't be probed or deleted.
    const row = await context.prisma.sessionTakeaway.findFirst({
      where: { id: input.id, submission: { conferenceId: context.conferenceId } },
      select: { id: true, identityId: true },
    });
    if (!row) throw new ORPCError("NOT_FOUND", { message: "takeaway_not_found" });
    if (!isMod && row.identityId !== me) throw new ORPCError("FORBIDDEN");
    await context.prisma.sessionTakeaway.delete({ where: { id: row.id } });
    return { ok: true as const };
  }),
};
