import { ORPCError } from "@orpc/server";
import type { PrismaClient, SubmissionStatus, Prisma } from "@prisma/client";
import {
  requireConf, actorIdentityId,
  normalizeLabels, filterToExistingRoomTags,
  resolveFinished,
} from "./shared";
import { notify, notifyMany, modIdentityIds } from "../notifications";
import { LIMITS, assertQuota, recordWrite } from "../lib/limits";

async function setStatus(prisma: PrismaClient, confId: number, id: number, status: SubmissionStatus) {
  await prisma.submission.updateMany({ where: { id, conferenceId: confId }, data: { status } });
}

export const submissionsRouter = {
  list: requireConf("participant").submissions.list.handler(async ({ input, context }) => {
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    const myIdentityId = actorIdentityId(context);
    // Mods see everything (optionally filtered by status chip). Participants
    // see published sessions plus their own (any status) so they can find a
    // session they just submitted and delete it before a mod decides on it.
    const where: Prisma.SubmissionWhereInput = isMod
      ? {
          conferenceId: context.conferenceId,
          ...(input.status ? { status: input.status } : {}),
        }
      : {
          conferenceId: context.conferenceId,
          OR: [
            { status: "published" as const },
            { submitterId: myIdentityId },
          ],
        };
    const [subs, conf] = await Promise.all([
      context.prisma.submission.findMany({
        where,
        include: {
          submitter: { select: { id: true, email: true, name: true, profilePublished: true } },
          _count: { select: { stars: true, placements: true, trackAssignments: true } },
          stars: { where: { userId: myIdentityId }, select: { userId: true } },
          tags: { select: { value: true }, orderBy: { value: "asc" } },
          requirements: { select: { value: true }, orderBy: { value: "asc" } },
          roomRequirements: { select: { value: true }, orderBy: { value: "asc" } },
          // Path C: every TrackAssignment whose submissionId points at this
          // sub. The Sessions tab uses this to render the inline "Scheduled
          // at: 10:00 Hall · 14:00 Hall" hint so users can see, at the
          // moment they're starring, where the planned schedule will pick
          // their interest up.
          trackAssignments: {
            include: {
              slot: { select: { startsAt: true, endsAt: true } },
              room: { select: { id: true, name: true } },
            },
            orderBy: { slot: { startsAt: "asc" } },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      context.prisma.conference.findUniqueOrThrow({
        where: { id: context.conferenceId },
        select: { submissionMaxPlacementsDefault: true },
      }),
    ]);

    const rows = subs.map((s) => {
      const placementCount = s._count.placements + s._count.trackAssignments;
      const { is_finished } = resolveFinished(
        { maxPlacements: s.maxPlacements, manuallyFinished: s.manuallyFinished },
        conf.submissionMaxPlacementsDefault,
        placementCount,
      );
      return {
        id: s.id,
        conference_id: s.conferenceId,
        submitter_id: s.submitterId,
        submitter_name: s.submitter.name,
        submitter_email: isMod ? s.submitter.email : null,
        submitter_profile_published: s.submitter.profilePublished,
        title: s.title,
        description: s.description,
        status: s.status,
        created_at: s.createdAt.getTime(),
        star_count: s._count.stars,
        starred_by_me: s.stars.length > 0,
        tags: s.tags.map((t) => t.value),
        requirements: s.requirements.map((r) => r.value),
        room_requirements: s.roomRequirements.map((r) => r.value),
        max_placements: s.maxPlacements,
        manually_finished: s.manuallyFinished,
        pre_assigned_room_id: s.preAssignedRoomId,
        allow_overlapping_placements: s.allowOverlappingPlacements,
        placement_count: placementCount,
        is_finished,
        scheduled_in: s.trackAssignments.map((t) => ({
          slot_id: t.slotId,
          starts_at: t.slot.startsAt.getTime(),
          ends_at: t.slot.endsAt.getTime(),
          room_id: t.roomId,
          room_name: t.room.name,
        })),
      };
    });

    // Path C: `is_finished` is informational only. Participants still see
    // every published submission, including fully-scheduled ones, so they
    // can star (and have planned tracks land on their schedule via the
    // derivation rule). Mods see the same list (plus their own drafts /
    // rejected when filtered).
    return rows.sort((a, b) =>
      b.star_count !== a.star_count ? b.star_count - a.star_count : b.created_at - a.created_at,
    );
  }),

  create: requireConf("participant").submissions.create.handler(async ({ input, context }) => {
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    if (!isMod) {
      const conf = await context.prisma.conference.findUniqueOrThrow({
        where: { id: context.conferenceId },
        select: { participantSubmissionsEnabled: true },
      });
      if (!conf.participantSubmissionsEnabled) {
        throw new ORPCError("FORBIDDEN", { message: "participant_submissions_disabled" });
      }
    }
    const tags = normalizeLabels(input.tags);
    const requirements = normalizeLabels(input.requirements);
    const roomRequirements = await filterToExistingRoomTags(
      context.prisma,
      context.conferenceId,
      normalizeLabels(input.room_requirements),
    );
    // Mod-only fields. Silently dropped for participants (the form doesn't
    // render them anyway; we double-enforce role here).
    const modData: Pick<
      Prisma.SubmissionUncheckedCreateInput,
      "maxPlacements" | "manuallyFinished" | "allowOverlappingPlacements" | "preAssignedRoomId"
    > = {};
    let submitterId = actorIdentityId(context);
    if (isMod) {
      if (input.max_placements !== undefined) {
        modData.maxPlacements = input.max_placements;
      }
      if (input.manually_finished !== undefined) {
        modData.manuallyFinished = input.manually_finished;
      }
      if (input.allow_overlapping_placements !== undefined) {
        modData.allowOverlappingPlacements = input.allow_overlapping_placements;
      }
      if (input.pre_assigned_room_id !== undefined && input.pre_assigned_room_id !== null) {
        const room = await context.prisma.room.findFirst({
          where: { id: input.pre_assigned_room_id, conferenceId: context.conferenceId },
          select: { id: true },
        });
        if (!room) throw new ORPCError("BAD_REQUEST", { message: "room_not_in_conference" });
        modData.preAssignedRoomId = room.id;
      }
      if (input.submitter_id !== undefined) {
        const identity = await context.prisma.conferenceIdentity.findFirst({
          where: { id: input.submitter_id, conferenceId: context.conferenceId },
          select: { id: true },
        });
        if (!identity) {
          throw new ORPCError("BAD_REQUEST", { message: "submitter_not_in_conference" });
        }
        submitterId = identity.id;
      }
    }
    // Per-user-per-conference cap — only enforced for participants. Mods
    // and owners need to be able to seed the agenda before opening
    // submissions (keynotes, sponsor talks, prepared workshops, etc.) and
    // the cap exists to prevent participant spam, not to ration trusted
    // organizers. This includes the mod-on-behalf-of path: if a mod
    // explicitly attributes a session to a participant via `submitter_id`,
    // they've made the trust decision and shouldn't be blocked by the
    // attributee's cap.
    if (!isMod) {
      const submitterSubmissionCount = await context.prisma.submission.count({
        where: { conferenceId: context.conferenceId, submitterId },
      });
      assertQuota(
        "sessions_per_user_per_conference",
        LIMITS.maxSessionsPerUserPerConference,
        submitterSubmissionCount,
      );
    }
    // Per-account write rate — uses the actor's global user id when they
    // have one (owners), or falls back to a negative-id keyed sentinel for
    // identity-only actors so participants still get a per-identity budget.
    const actorKey = context.principal.kind === "owner"
      ? context.principal.user.id
      : -actorIdentityId(context);
    recordWrite(actorKey);

    const created = await context.prisma.submission.create({
      data: {
        conferenceId: context.conferenceId, submitterId,
        title: input.title, description: input.description ?? "",
        ...modData,
        tags:             { create: tags.map((value) => ({ value })) },
        requirements:     { create: requirements.map((value) => ({ value })) },
        roomRequirements: { create: roomRequirements.map((value) => ({ value })) },
      },
    });
    // Notify mods/owners so they know there's something in the review queue.
    // Exclude the submitter — a mod submitting their own session shouldn't ping
    // themselves.
    const myId = actorIdentityId(context);
    const modIds = (await modIdentityIds(context.prisma, context.conferenceId))
      .filter((id) => id !== myId);
    await notifyMany(context.prisma, modIds.map((identityId) => ({
      identityId,
      kind: "submission_received" as const,
      title: "New session submission",
      body: input.title,
      ctaLabel: "Review",
      ctaHref: "tab:sessions",
    })));
    return { id: created.id, status: created.status };
  }),

  update: requireConf("participant").submissions.update.handler(async ({ input, context }) => {
    const cur = await context.prisma.submission.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    if (!cur) throw new ORPCError("NOT_FOUND");
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    if (cur.submitterId !== actorIdentityId(context) && !isMod) throw new ORPCError("FORBIDDEN");
    if (!isMod && cur.status !== "submitted") {
      throw new ORPCError("CONFLICT", { message: "already_decided" });
    }
    // Moderator-only fields. Silently ignored for participants (they can't
    // reach this handler with these set anyway because the form doesn't render
    // them, but we double-enforce role here to keep the contract honest).
    const modPatch: Prisma.SubmissionUpdateInput = {};
    if (isMod) {
      if (input.max_placements !== undefined) {
        modPatch.maxPlacements = input.max_placements;
      }
      if (input.manually_finished !== undefined) {
        modPatch.manuallyFinished = input.manually_finished;
      }
      if (input.pre_assigned_room_id !== undefined) {
        if (input.pre_assigned_room_id === null) {
          modPatch.preAssignedRoom = { disconnect: true };
        } else {
          // Validate the room belongs to this conference. We don't 404 here
          // because the form only shows rooms in this conference, so a bad
          // id is a contract violation worth rejecting with a 400.
          const room = await context.prisma.room.findFirst({
            where: { id: input.pre_assigned_room_id, conferenceId: context.conferenceId },
            select: { id: true },
          });
          if (!room) throw new ORPCError("BAD_REQUEST", { message: "room_not_in_conference" });
          modPatch.preAssignedRoom = { connect: { id: room.id } };
        }
      }
      if (input.allow_overlapping_placements !== undefined) {
        modPatch.allowOverlappingPlacements = input.allow_overlapping_placements;
      }
      if (input.submitter_id !== undefined) {
        // Validate the identity belongs to this conference. The picker
        // only offers in-conference identities, so a mismatch is a
        // contract violation worth rejecting with 400.
        const identity = await context.prisma.conferenceIdentity.findFirst({
          where: { id: input.submitter_id, conferenceId: context.conferenceId },
          select: { id: true },
        });
        if (!identity) {
          throw new ORPCError("BAD_REQUEST", { message: "submitter_not_in_conference" });
        }
        modPatch.submitter = { connect: { id: identity.id } };
      }
    }
    const ops: Prisma.PrismaPromise<unknown>[] = [
      context.prisma.submission.update({
        where: { id: input.id },
        data: {
          title: input.title ?? undefined,
          description: input.description ?? undefined,
          ...modPatch,
        },
      }),
    ];
    if (input.tags !== undefined) {
      const tags = normalizeLabels(input.tags);
      ops.push(context.prisma.submissionTag.deleteMany({ where: { submissionId: input.id } }));
      ops.push(context.prisma.submissionTag.createMany({
        data: tags.map((value) => ({ submissionId: input.id, value })),
      }));
    }
    if (input.requirements !== undefined) {
      const reqs = normalizeLabels(input.requirements);
      ops.push(context.prisma.submissionRequirement.deleteMany({ where: { submissionId: input.id } }));
      ops.push(context.prisma.submissionRequirement.createMany({
        data: reqs.map((value) => ({ submissionId: input.id, value })),
      }));
    }
    if (input.room_requirements !== undefined) {
      const roomReqs = await filterToExistingRoomTags(
        context.prisma,
        context.conferenceId,
        normalizeLabels(input.room_requirements),
      );
      ops.push(context.prisma.submissionRoomRequirement.deleteMany({ where: { submissionId: input.id } }));
      ops.push(context.prisma.submissionRoomRequirement.createMany({
        data: roomReqs.map((value) => ({ submissionId: input.id, value })),
      }));
    }
    await context.prisma.$transaction(ops);
    return { ok: true as const };
  }),

  delete: requireConf("participant").submissions.delete.handler(async ({ input, context }) => {
    const sub = await context.prisma.submission.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    if (!sub) throw new ORPCError("NOT_FOUND");
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    if (!isMod) {
      if (sub.submitterId !== actorIdentityId(context)) throw new ORPCError("FORBIDDEN");
      // Submitter can revoke their own session only while it's still in the
      // moderator queue. Once a mod has acted on it (publish or reject), the
      // submission becomes the conference's record and only mods can delete.
      if (sub.status !== "submitted") {
        throw new ORPCError("CONFLICT", { message: "already_decided" });
      }
    }
    // FK cascades handle stars / tags / requirements / slot memberships /
    // placements / user assignments. TrackAssignment.submissionId is nullable
    // with onDelete: SetNull, so any static track linked to this submission
    // keeps its row (the mod can re-pick a submission for it).
    await context.prisma.submission.delete({ where: { id: input.id } });
    return { ok: true as const };
  }),

  publish: requireConf("moderator").submissions.publish.handler(async ({ input, context }) => {
    await setStatus(context.prisma, context.conferenceId, input.id, "published");
    const sub = await context.prisma.submission.findUniqueOrThrow({
      where: { id: input.id }, select: { submitterId: true, title: true },
    });
    await notify(context.prisma, {
      identityId: sub.submitterId,
      kind: "submission_published",
      title: "Your session was published",
      body: sub.title,
      ctaLabel: "View",
      ctaHref: "tab:sessions",
    });
    return { ok: true as const };
  }),
  unpublish: requireConf("moderator").submissions.unpublish.handler(async ({ input, context }) => {
    await setStatus(context.prisma, context.conferenceId, input.id, "submitted");
    return { ok: true as const };
  }),
  reject: requireConf("moderator").submissions.reject.handler(async ({ input, context }) => {
    await setStatus(context.prisma, context.conferenceId, input.id, "rejected");
    const sub = await context.prisma.submission.findUniqueOrThrow({
      where: { id: input.id }, select: { submitterId: true, title: true },
    });
    await notify(context.prisma, {
      identityId: sub.submitterId,
      kind: "submission_rejected",
      title: "Your session was not accepted",
      body: sub.title,
      ctaLabel: "View",
      ctaHref: "tab:sessions",
    });
    return { ok: true as const };
  }),

  star: requireConf("participant").submissions.star.handler(async ({ input, context }) => {
    const sub = await context.prisma.submission.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    if (!sub) throw new ORPCError("NOT_FOUND");
    if (sub.status !== "published") throw new ORPCError("CONFLICT", { message: "not_published" });
    const myIdentityId = actorIdentityId(context);
    await context.prisma.star.upsert({
      where: { userId_submissionId: { userId: myIdentityId, submissionId: input.id } },
      create: { userId: myIdentityId, submissionId: input.id },
      update: {},
    });
    return { ok: true as const };
  }),

  unstar: requireConf("participant").submissions.unstar.handler(async ({ input, context }) => {
    const sub = await context.prisma.submission.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    if (!sub) throw new ORPCError("NOT_FOUND");
    await context.prisma.star.deleteMany({
      where: { userId: actorIdentityId(context), submissionId: input.id },
    });
    return { ok: true as const };
  }),
};
