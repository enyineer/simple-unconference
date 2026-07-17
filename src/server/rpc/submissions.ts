import { ORPCError } from "@orpc/server";
import type { PrismaClient, SubmissionStatus, Prisma } from "@prisma/client";
import {
  requireConf, actorIdentityId,
  normalizeLabels, filterToExistingRoomTags,
  pageOf, parsePageInput,
  resolveFinished,
} from "./shared";
import { createNotification, createNotifications, modIdentityIds } from "../notifications";
import { publishAgendaChanged } from "../realtime/bus";
import { LIMITS, assertQuota, recordWrite } from "../lib/limits";
import { expertDedicationOf } from "../lib/room-constraints";
import { effectiveSpeakers, normalizeSpeakerName } from "../lib/speakers";
import type { SpeakerInput } from "../../shared/schemas/submissions";

async function setStatus(prisma: PrismaClient, confId: number, id: number, status: SubmissionStatus) {
  await prisma.submission.updateMany({ where: { id, conferenceId: confId }, data: { status } });
}

const submissionInclude = (myIdentityId: number) => ({
  submitter: { select: { id: true, email: true, name: true, profilePublished: true } },
  _count: { select: { stars: true, placements: true, trackAssignments: true } },
  stars: { where: { userId: myIdentityId }, select: { userId: true } },
  tags: { select: { value: true }, orderBy: { value: "asc" as const } },
  requirements: { select: { value: true }, orderBy: { value: "asc" as const } },
  roomRequirements: { select: { value: true }, orderBy: { value: "asc" as const } },
  speakers: {
    select: {
      identityId: true,
      name: true,
      identity: { select: { name: true, profilePublished: true } },
    },
    orderBy: { position: "asc" as const },
  },
  trackAssignments: {
    include: {
      slot: { select: { startsAt: true, endsAt: true } },
      room: { select: { id: true, name: true } },
    },
    orderBy: { slot: { startsAt: "asc" as const } },
  },
});

type LoadedSubmission = Prisma.SubmissionGetPayload<{
  include: ReturnType<typeof submissionInclude>;
}>;

function toSubmissionOut(
  s: LoadedSubmission,
  ctx: { isMod: boolean; submissionMaxPlacementsDefault: number | null },
) {
  const placementCount = s._count.placements + s._count.trackAssignments;
  const { is_finished } = resolveFinished(
    { maxPlacements: s.maxPlacements, manuallyFinished: s.manuallyFinished },
    ctx.submissionMaxPlacementsDefault,
    placementCount,
  );
  return {
    id: s.id,
    conference_id: s.conferenceId,
    submitter_id: s.submitterId,
    submitter_name: s.submitter.name,
    submitter_email: ctx.isMod ? s.submitter.email : null,
    submitter_profile_published: s.submitter.profilePublished,
    speakers: effectiveSpeakers({
      submitterId: s.submitterId,
      submitter: { name: s.submitter.name, profilePublished: s.submitter.profilePublished },
      speakers: s.speakers,
    }).map((sp) => ({
      identity_id: sp.identityId,
      name: sp.name,
      profile_published: sp.profilePublished,
    })),
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
    priority: s.priority,
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
}

// Validate + normalize a mod-supplied speaker list into DB-ready rows.
//   - Each row must set EXACTLY ONE of `identity_id` / `name` (reject both/neither).
//   - Registered `identity_id`s must resolve to an identity in this conference.
//   - Dedupe: registered by identity id, free-form by normalized name.
//   - `position` follows input order (dropped duplicates don't advance it).
// Throws a BAD_REQUEST on any invalid row so the caller can surface it.
async function resolveSpeakerRows(
  prisma: PrismaClient,
  conferenceId: number,
  speakers: SpeakerInput[],
): Promise<{ identityId: number | null; name: string | null; position: number }[]> {
  const rows: { identityId: number | null; name: string | null; position: number }[] = [];
  const seenIdentity = new Set<number>();
  const seenName = new Set<string>();
  let position = 0;
  for (const sp of speakers) {
    const hasId = sp.identity_id !== undefined;
    const hasName = sp.name !== undefined;
    if (hasId === hasName) {
      // Both set or neither set — the row is ambiguous.
      throw new ORPCError("BAD_REQUEST", { message: "speaker_invalid" });
    }
    if (hasId) {
      const id = sp.identity_id!;
      if (seenIdentity.has(id)) continue;
      seenIdentity.add(id);
      rows.push({ identityId: id, name: null, position: position++ });
    } else {
      const name = sp.name!;
      const norm = normalizeSpeakerName(name);
      if (seenName.has(norm)) continue;
      seenName.add(norm);
      rows.push({ identityId: null, name, position: position++ });
    }
  }
  // Validate all registered identities belong to this conference in one query.
  const identityIds = [...seenIdentity];
  if (identityIds.length > 0) {
    const found = await prisma.conferenceIdentity.findMany({
      where: { id: { in: identityIds }, conferenceId },
      select: { id: true },
    });
    if (found.length !== identityIds.length) {
      throw new ORPCError("BAD_REQUEST", { message: "speaker_not_in_conference" });
    }
  }
  return rows;
}

function visibilityWhere(
  conferenceId: number,
  isMod: boolean,
  myIdentityId: number,
  status: SubmissionStatus | undefined,
): Prisma.SubmissionWhereInput {
  return isMod
    ? {
        conferenceId,
        ...(status ? { status } : {}),
      }
    : {
        conferenceId,
        OR: [
          { status: "published" as const },
          { submitterId: myIdentityId },
        ],
      };
}

export const submissionsRouter = {
  list: requireConf("participant").submissions.list.handler(async ({ input, context }) => {
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    const myIdentityId = actorIdentityId(context);
    const { offset, limit, q } = parsePageInput(input);
    // Tag chip filter — AND semantics. Normalize early so the case-folded
    // form matches what we persist on the join row.
    const tagFilters = (input.tags ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    const baseWhere = visibilityWhere(
      context.conferenceId, isMod, myIdentityId, input.status,
    );
    const filters: Prisma.SubmissionWhereInput[] = [];
    if (q) {
      const orBranches: Prisma.SubmissionWhereInput[] = [
        { title: { contains: q } },
        { description: { contains: q } },
        { submitter: { name: { contains: q } } },
        { tags: { some: { value: { contains: q } } } },
      ];
      // Mods can search by submitter email; for non-mods the email surface
      // is masked, so matching against it would leak existence by side
      // channel.
      if (isMod) {
        orBranches.push({ submitter: { email: { contains: q } } });
      }
      filters.push({ OR: orBranches });
    }
    if (tagFilters.length > 0) {
      filters.push({
        AND: tagFilters.map((value) => ({ tags: { some: { value } } })),
      });
    }
    if (input.starred_only) {
      filters.push({ stars: { some: { userId: myIdentityId } } });
    }
    const where: Prisma.SubmissionWhereInput = filters.length === 0
      ? baseWhere
      : { AND: [baseWhere, ...filters] };

    const [total, subs, conf] = await Promise.all([
      context.prisma.submission.count({ where }),
      context.prisma.submission.findMany({
        where,
        include: submissionInclude(myIdentityId),
        // Most-starred first (the agenda mod's primary signal), then newest.
        // Count + page share `where`, so paging totals stay accurate.
        orderBy: [{ stars: { _count: "desc" } }, { createdAt: "desc" }],
        skip: offset,
        take: limit,
      }),
      context.prisma.conference.findUniqueOrThrow({
        where: { id: context.conferenceId },
        select: { submissionMaxPlacementsDefault: true },
      }),
    ]);
    const rows = subs.map((s) => toSubmissionOut(s, {
      isMod,
      submissionMaxPlacementsDefault: conf.submissionMaxPlacementsDefault,
    }));
    return pageOf(rows, offset, limit, total);
  }),

  listAll: requireConf("participant").submissions.listAll.handler(async ({ input, context }) => {
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    const myIdentityId = actorIdentityId(context);
    const where = visibilityWhere(
      context.conferenceId, isMod, myIdentityId, input.status,
    );
    const [subs, conf] = await Promise.all([
      context.prisma.submission.findMany({
        where,
        include: submissionInclude(myIdentityId),
        orderBy: [{ stars: { _count: "desc" } }, { createdAt: "desc" }],
      }),
      context.prisma.conference.findUniqueOrThrow({
        where: { id: context.conferenceId },
        select: { submissionMaxPlacementsDefault: true },
      }),
    ]);
    return subs.map((s) => toSubmissionOut(s, {
      isMod,
      submissionMaxPlacementsDefault: conf.submissionMaxPlacementsDefault,
    }));
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
      "maxPlacements" | "manuallyFinished" | "allowOverlappingPlacements" | "preAssignedRoomId" | "priority"
    > = {};
    let submitterId = actorIdentityId(context);
    // Mod-only effective-speaker rows, resolved + validated below. Left
    // undefined (no speaker rows → defaults to the submitter) for participants.
    let speakerRows: { identityId: number | null; name: string | null; position: number }[] | undefined;
    if (isMod) {
      if (input.speakers !== undefined) {
        speakerRows = await resolveSpeakerRows(
          context.prisma, context.conferenceId, input.speakers,
        );
      }
      if (input.max_placements !== undefined) {
        modData.maxPlacements = input.max_placements;
      }
      if (input.manually_finished !== undefined) {
        modData.manuallyFinished = input.manually_finished;
      }
      if (input.allow_overlapping_placements !== undefined) {
        modData.allowOverlappingPlacements = input.allow_overlapping_placements;
      }
      if (input.priority !== undefined) {
        modData.priority = input.priority;
      }
      if (input.pre_assigned_room_id !== undefined && input.pre_assigned_room_id !== null) {
        const room = await context.prisma.room.findFirst({
          where: { id: input.pre_assigned_room_id, conferenceId: context.conferenceId },
          select: { id: true },
        });
        if (!room) throw new ORPCError("BAD_REQUEST", { message: "room_not_in_conference" });
        // A room reserved for expert conversations is never a valid pin target.
        const dedication = await expertDedicationOf(
          context.prisma, context.conferenceId, room.id,
        );
        if (dedication) {
          throw new ORPCError("BAD_REQUEST", {
            message: "room_expert_dedicated",
            data: { room_id: room.id, pool_name: dedication.poolName },
          });
        }
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
        ...(speakerRows
          ? { speakers: { create: speakerRows.map((r) => ({
              identityId: r.identityId, name: r.name, position: r.position,
            })) } }
          : {}),
      },
    });
    // Notify mods/owners so they know there's something in the review queue.
    // Exclude the submitter — a mod submitting their own session shouldn't ping
    // themselves.
    const myId = actorIdentityId(context);
    const modIds = (await modIdentityIds(context.prisma, context.conferenceId))
      .filter((id) => id !== myId);
    await createNotifications(context.prisma, modIds.map((identityId) => ({
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
          // A room reserved for expert conversations is never a valid pin target.
          const dedication = await expertDedicationOf(
            context.prisma, context.conferenceId, room.id,
          );
          if (dedication) {
            throw new ORPCError("BAD_REQUEST", {
              message: "room_expert_dedicated",
              data: { room_id: room.id, pool_name: dedication.poolName },
            });
          }
          modPatch.preAssignedRoom = { connect: { id: room.id } };
        }
      }
      if (input.allow_overlapping_placements !== undefined) {
        modPatch.allowOverlappingPlacements = input.allow_overlapping_placements;
      }
      if (input.priority !== undefined) {
        modPatch.priority = input.priority;
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
    // Mod-only speaker replacement. Resolved (and validated) BEFORE the write
    // transaction so a bad row rejects with a clean 400 and no partial write.
    const speakerRows = isMod && input.speakers !== undefined
      ? await resolveSpeakerRows(context.prisma, context.conferenceId, input.speakers)
      : undefined;
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
    if (speakerRows !== undefined) {
      ops.push(context.prisma.submissionSpeaker.deleteMany({ where: { submissionId: input.id } }));
      if (speakerRows.length > 0) {
        ops.push(context.prisma.submissionSpeaker.createMany({
          data: speakerRows.map((r) => ({
            submissionId: input.id, identityId: r.identityId, name: r.name, position: r.position,
          })),
        }));
      }
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
    // Any unconference slot this submission is placed in loses that placement
    // (UnconferencePlacement.submission cascades) → those slots need a re-seat.
    // Flag them stale before the delete. UserAssignment.submissionId is
    // onDelete: SetNull, so seats for this session would otherwise dangle with
    // a null submission — delete them explicitly.
    const placements = await context.prisma.unconferencePlacement.findMany({
      where: { submissionId: input.id, slot: { conferenceId: context.conferenceId } },
      select: { slotId: true },
    });
    const staleSlotIds = [...new Set(placements.map((p) => p.slotId))];
    // FK cascades handle stars / tags / requirements / slot memberships /
    // placements. TrackAssignment.submissionId is nullable with onDelete:
    // SetNull, so any static track linked to this submission keeps its row (the
    // mod can re-pick a submission for it).
    await context.prisma.$transaction([
      context.prisma.userAssignment.deleteMany({
        where: { submissionId: input.id, slot: { conferenceId: context.conferenceId } },
      }),
      context.prisma.agendaSlot.updateMany({
        where: { id: { in: staleSlotIds } }, data: { seatingStale: true },
      }),
      context.prisma.submission.delete({ where: { id: input.id } }),
    ]);
    return { ok: true as const };
  }),

  publish: requireConf("moderator").submissions.publish.handler(async ({ input, context }) => {
    await setStatus(context.prisma, context.conferenceId, input.id, "published");
    const sub = await context.prisma.submission.findUniqueOrThrow({
      where: { id: input.id }, select: { submitterId: true, title: true },
    });
    await createNotification(context.prisma, {
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
    await createNotification(context.prisma, {
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
    // Star counts drive the Live Board (and the pitch spotlight card), so a
    // star toggle is an agenda change for board purposes.
    publishAgendaChanged(context.conferenceId);
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
    publishAgendaChanged(context.conferenceId);
    return { ok: true as const };
  }),
};
