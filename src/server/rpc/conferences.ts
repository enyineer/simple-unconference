import { ORPCError } from "@orpc/server";
import type { Prisma } from "@prisma/client";
import {
  base, authed, verified, requireConf, actorIdentityId, clientIp,
  generateUniqueSlug, INVITE_TTL_MS, newOpaqueToken, joinUrl, boardUrl, calendarFeedPath,
  pageOf, parsePageInput,
  toInviteOut, toConfMeOut,
  type RpcContext,
} from "./shared";
import { startOfDayInstant } from "../../shared/tz";
import {
  hashPassword, verifyPassword,
  createIdentitySession, destroySession,
  setIdentityCookie, clearIdentityCookie,
  readCookie, identityCookieName,
  principalFromRequest,
} from "../auth";
import { notifyQuotaThreshold } from "../notifications";
import {
  LIMITS,
  assertQuota,
  assertLoginAllowed, isLoginLocked, recordLoginFailure, recordLoginSuccess,
  assertPasswordResetAllowed,
  recordWrite,
} from "../lib/limits";
import { assertTurnstile } from "../lib/turnstile";
import {
  generateResetToken, hashResetToken, resetTokenTtlMs, resetTokenTtlMinutes,
  identityResetUrl,
} from "../lib/password-reset";
import { sendPasswordResetEmail } from "../lib/email";

// When an anonymous claim/join is made while a verified global account with the
// SAME email is signed in on this browser, the new per-conference identity is
// auto-linked to that account. Mirrors `account.linkConferenceIdentity` minus
// the password proof — the claimer just set that password themselves, so the
// conference side is already controlled. Returns the user id to stamp as
// `linkedUserId`, or null when there is no eligible global session (missing /
// expired cookie, unverified email, or a different email). Never links across
// mismatched emails. Emails are already normalized (both go through the `Email`
// primitive), so a strict equality check is correct.
async function resolveAutoLinkUserId(
  context: RpcContext,
  identityEmail: string,
): Promise<number | null> {
  const principal = await principalFromRequest(context.prisma, context.req, { type: "owner" });
  if (!principal || principal.kind !== "owner") return null;
  const { user } = principal;
  if (user.emailVerifiedAt === null) return null;
  if (user.email !== identityEmail) return null;
  return user.id;
}

// Shape the owner-facing board link state. `enabled` is simply "token is set".
function toBoardLinkOut(slug: string, token: string | null) {
  return {
    enabled: token !== null,
    token,
    url: token ? boardUrl(slug, token) : null,
  };
}

export const conferenceRouter = {
  // Owner-only: list conferences this global account owns. Identities never
  // call this (each per-conference cookie addresses exactly one conference,
  // which the client already knows by slug).
  list: authed.conferences.list.handler(async ({ context }) => {
    const owned = await context.prisma.conference.findMany({
      where: { ownerId: context.user.id },
      orderBy: { createdAt: "desc" },
    });
    return owned.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      owner_id: c.ownerId,
      role: "owner" as const,
      timezone: c.timezone,
      created_at: c.createdAt.getTime(),
    }));
  }),

  create: verified.conferences.create.handler(async ({ input, context }) => {
    const ownedCount = await context.prisma.conference.count({
      where: { ownerId: context.user.id },
    });
    assertQuota("conferences_per_user", LIMITS.maxConferencesPerUser, ownedCount);
    recordWrite(context.user.id);

    const slug = await generateUniqueSlug(context.prisma, input.name);
    const conf = await context.prisma.conference.create({
      data: {
        name: input.name, slug, ownerId: context.user.id,
        timezone: input.timezone ?? "UTC",
      },
    });
    return {
      id: conf.id, name: conf.name, slug: conf.slug,
      owner_id: conf.ownerId, timezone: conf.timezone,
      created_at: conf.createdAt.getTime(),
    };
  }),

  get: requireConf("participant").conferences.get.handler(async ({ context }) => {
    const conf = await context.prisma.conference.findUniqueOrThrow({
      where: { id: context.conferenceId },
    });

    // Cap-relevant submission count for the *current* identity, regardless
    // of role. Hidden statuses (rejected, finished) still consume quota slots,
    // so the client needs the true number — not just what `submissions.list`
    // returns to them.
    const mySessionCount = await context.prisma.submission.count({
      where: { conferenceId: context.conferenceId, submitterId: actorIdentityId(context) },
    });

    // Mod-only usage counters. Participants see `usage: null` — keeping the
    // four counts off the public path also avoids leaking exact attendee
    // counts to non-mods.
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    type Usage = {
      participants:    { current: number; limit: number | null };
      pending_invites: { current: number; limit: number | null };
      rooms:           { current: number; limit: number | null };
      total_sessions:  { current: number; limit: null };
    };
    let usage: Usage | null = null;
    if (isMod) {
      const [participants, pendingInvites, rooms, totalSessions] = await Promise.all([
        context.prisma.conferenceIdentity.count({ where: { conferenceId: context.conferenceId } }),
        context.prisma.conferenceInvite.count({
          where: { conferenceId: context.conferenceId, claimedAt: null },
        }),
        context.prisma.room.count({ where: { conferenceId: context.conferenceId } }),
        context.prisma.submission.count({ where: { conferenceId: context.conferenceId } }),
      ]);
      const toLimit = (n: number) => (n === 0 ? null : n); // 0 = unlimited per LIMITS convention
      usage = {
        participants:    { current: participants, limit: toLimit(LIMITS.maxParticipantsPerConference) },
        pending_invites: { current: pendingInvites, limit: toLimit(LIMITS.maxPendingInvitesPerConference) },
        rooms:           { current: rooms, limit: toLimit(LIMITS.maxRoomsPerConference) },
        total_sessions:  { current: totalSessions, limit: null },
      };
    }

    return {
      id: conf.id, name: conf.name, slug: conf.slug,
      owner_id: conf.ownerId, created_at: conf.createdAt.getTime(),
      design_system: conf.designSystem,
      timezone: conf.timezone,
      mixer_avoid_repeats_default: conf.mixerAvoidRepeatsDefault,
      submission_max_placements_default: conf.submissionMaxPlacementsDefault,
      participant_submissions_enabled: conf.participantSubmissionsEnabled,
      my_role: context.principal.role,
      my_session_count: mySessionCount,
      usage,
    };
  }),

  update: requireConf("owner").conferences.update.handler(async ({ input, context }) => {
    if (input.design_system !== undefined) {
      const allowed = ["github", "minimal"];
      if (!allowed.includes(input.design_system)) {
        throw new ORPCError("BAD_REQUEST", { message: "unknown_design_system" });
      }
    }
    await context.prisma.conference.update({
      where: { id: context.conferenceId },
      data: {
        name: input.name ?? undefined,
        designSystem: input.design_system ?? undefined,
        timezone: input.timezone ?? undefined,
        mixerAvoidRepeatsDefault: input.mixer_avoid_repeats_default ?? undefined,
        // `null` is meaningful here ("unlimited"), so distinguish "not in patch"
        // from explicit null. PosInt or null are both writeable.
        submissionMaxPlacementsDefault:
          input.submission_max_placements_default === undefined
            ? undefined
            : input.submission_max_placements_default,
        participantSubmissionsEnabled:
          input.participant_submissions_enabled ?? undefined,
      },
    });
    return { ok: true as const };
  }),

  // Owner-only conference deletion. Every related row is removed via the
  // schema's onDelete: Cascade rules (identities, submissions, slots,
  // experts, notifications, …). The owner's *global* User account stays
  // untouched. After this call succeeds the client must navigate away —
  // any further request scoped to this slug will 404.
  delete: requireConf("owner").conferences.delete.handler(async ({ context }) => {
    // Chat retention rule (plans/chat.md Phase 9): block conference deletion
    // when there are any unresolved chat reports for messages in this
    // conference. MessageReport.messageId is onDelete:Restrict, so without
    // this check the cascade chain would fail mid-delete with a
    // foreign-key error — friendlier to surface it up-front so the owner
    // can resolve the reports first.
    const openReports = await context.prisma.messageReport.count({
      where: {
        resolvedAt: null,
        message: { conversation: { conferenceId: context.conferenceId } },
      },
    });
    if (openReports > 0) {
      throw new ORPCError("FORBIDDEN", {
        message: "open_chat_reports",
        data: { count: openReports },
      });
    }
    // Already-resolved reports still block via the same Restrict rule, so
    // hard-delete them first. They're stored audit trails — once resolved,
    // they're not needed once the conference itself is gone.
    await context.prisma.messageReport.deleteMany({
      where: { message: { conversation: { conferenceId: context.conferenceId } } },
    });
    await context.prisma.conference.delete({
      where: { id: context.conferenceId },
    });
    return { ok: true as const };
  }),

  // Wrap-up report (F3). Aggregated counts for the whole conference, computed
  // in a single parallel batch (no N+1). Names only, never emails.
  report: requireConf("moderator").conferences.report.handler(async ({ context }) => {
    const confId = context.conferenceId;
    const [
      participantCount,
      submitted,
      published,
      seatsFilled,
      starsTotal,
      publishedRows,
      rooms,
      tracks,
      placements,
      totalSlots,
      expertBookingsCount,
      takeawayCount,
    ] = await Promise.all([
      context.prisma.conferenceIdentity.count({ where: { conferenceId: confId } }),
      context.prisma.submission.count({ where: { conferenceId: confId } }),
      context.prisma.submission.count({ where: { conferenceId: confId, status: "published" } }),
      context.prisma.userAssignment.count({
        where: { slot: { conferenceId: confId, type: "unconference" } },
      }),
      context.prisma.star.count({ where: { submission: { conferenceId: confId } } }),
      context.prisma.submission.findMany({
        where: { conferenceId: confId, status: "published" },
        select: {
          id: true, title: true,
          submitter: { select: { name: true } },
          _count: { select: { stars: true } },
        },
      }),
      context.prisma.room.findMany({
        where: { conferenceId: confId },
        select: { id: true, name: true, capacity: true },
        orderBy: [{ capacity: "desc" }, { name: "asc" }],
      }),
      context.prisma.trackAssignment.findMany({
        where: { slot: { conferenceId: confId } },
        select: { roomId: true, slotId: true, submissionId: true },
      }),
      context.prisma.unconferencePlacement.findMany({
        where: { slot: { conferenceId: confId } },
        select: { roomId: true, slotId: true, submissionId: true },
      }),
      context.prisma.agendaSlot.count({ where: { conferenceId: confId } }),
      context.prisma.expertBooking.count({ where: { expert: { conferenceId: confId } } }),
      context.prisma.sessionTakeaway.count({ where: { submission: { conferenceId: confId } } }),
    ]);

    // Fold tracks + placements once: distinct placed submissions, and the set
    // of distinct slots each room hosts.
    const placedSubs = new Set<number>();
    const roomSlots = new Map<number, Set<number>>();
    for (const row of [...tracks, ...placements]) {
      placedSubs.add(row.submissionId);
      let set = roomSlots.get(row.roomId);
      if (!set) { set = new Set(); roomSlots.set(row.roomId, set); }
      set.add(row.slotId);
    }

    const topSessions = publishedRows
      .map((s) => ({ title: s.title, star_count: s._count.stars, submitter_name: s.submitter.name }))
      .sort((a, b) => b.star_count - a.star_count || a.title.localeCompare(b.title))
      .slice(0, 5);

    return {
      participant_count: participantCount,
      sessions: { submitted, published, placed_or_scheduled: placedSubs.size },
      seats_filled: seatsFilled,
      stars_total: starsTotal,
      top_sessions: topSessions,
      rooms: rooms.map((r) => ({
        name: r.name,
        capacity: r.capacity,
        used_slots: roomSlots.get(r.id)?.size ?? 0,
        available_slots: totalSlots,
      })),
      expert_bookings_count: expertBookingsCount,
      takeaway_count: takeawayCount,
      generated_at: Date.now(),
    };
  }),

  // Templates / duplicate (F5). Clone a conference's CONFIG + rooms + a slot /
  // series skeleton into a fresh conference owned by the same user. Explicitly
  // NOT cloned: identities, submissions, tracks, placements, seatings, experts,
  // invites, join/board tokens, spotlight. Slot + room-availability times shift
  // by the delta between the requested first day and the source's first slot.
  duplicate: requireConf("owner").conferences.duplicate.handler(async ({ input, context }) => {
    const source = await context.prisma.conference.findUniqueOrThrow({
      where: { id: context.conferenceId },
    });
    // requireConf("owner") guarantees the caller is the conference owner, so the
    // clone is owned by the source's owner. Respect the same per-user quota as
    // `create`.
    const ownerId = source.ownerId;
    const ownedCount = await context.prisma.conference.count({ where: { ownerId } });
    assertQuota("conferences_per_user", LIMITS.maxConferencesPerUser, ownedCount);
    recordWrite(ownerId);

    const [rooms, slots, series, slotRooms, seriesRooms] = await Promise.all([
      context.prisma.room.findMany({
        where: { conferenceId: source.id },
        include: {
          tags: { select: { value: true } },
          availabilities: { select: { startsAt: true, endsAt: true } },
        },
      }),
      context.prisma.agendaSlot.findMany({ where: { conferenceId: source.id } }),
      context.prisma.slotSeries.findMany({ where: { conferenceId: source.id } }),
      context.prisma.slotRoom.findMany({ where: { slot: { conferenceId: source.id } } }),
      context.prisma.seriesRoom.findMany({ where: { series: { conferenceId: source.id } } }),
    ]);

    // Day delta: align the earliest slot's day to `first_day`, preserving each
    // slot's wall-clock time. Zero when the source has no slots.
    let delta = 0;
    if (slots.length > 0) {
      const minStart = Math.min(...slots.map((s) => s.startsAt.getTime()));
      delta = startOfDayInstant(input.first_day, source.timezone)
        - startOfDayInstant(minStart, source.timezone);
    }

    const newSlug = await generateUniqueSlug(context.prisma, input.name);

    const created = await context.prisma.$transaction(async (tx) => {
      const conf = await tx.conference.create({
        data: {
          name: input.name,
          slug: newSlug,
          ownerId,
          designSystem: source.designSystem,
          timezone: source.timezone,
          mixerAvoidRepeatsDefault: source.mixerAvoidRepeatsDefault,
          submissionMaxPlacementsDefault: source.submissionMaxPlacementsDefault,
          participantSubmissionsEnabled: source.participantSubmissionsEnabled,
          // boardToken / spotlightSubmissionId deliberately left fresh (null).
        },
      });

      // Rooms (+ tags, + availability windows shifted by delta).
      const roomIdMap = new Map<number, number>();
      for (const r of rooms) {
        const newRoom = await tx.room.create({
          data: {
            conferenceId: conf.id,
            name: r.name,
            capacity: r.capacity,
            description: r.description,
            tags: { create: r.tags.map((t) => ({ value: t.value })) },
            availabilities: {
              create: r.availabilities.map((a) => ({
                startsAt: new Date(a.startsAt.getTime() + delta),
                endsAt: new Date(a.endsAt.getTime() + delta),
              })),
            },
          },
        });
        roomIdMap.set(r.id, newRoom.id);
      }

      // Series config (submission scoping dropped — no submissions cloned).
      const seriesIdMap = new Map<number, number>();
      for (const s of series) {
        const newSeries = await tx.slotSeries.create({
          data: {
            conferenceId: conf.id,
            type: s.type,
            title: s.title,
            description: s.description,
            unconfUseAllRooms: s.unconfUseAllRooms,
            unconfUseAllSubmissions: s.unconfUseAllSubmissions,
            unconfAvoidRepeats: s.unconfAvoidRepeats,
            mixerAvoidRepeats: s.mixerAvoidRepeats,
            avoidRepeatsAcrossSiblings: s.avoidRepeatsAcrossSiblings,
          },
        });
        seriesIdMap.set(s.id, newSeries.id);
      }

      // Slots (times shifted; series remapped; seating reset; no tracks/placements).
      const slotIdMap = new Map<number, number>();
      for (const sl of slots) {
        const newSlot = await tx.agendaSlot.create({
          data: {
            conferenceId: conf.id,
            type: sl.type,
            title: sl.title,
            description: sl.description,
            startsAt: new Date(sl.startsAt.getTime() + delta),
            endsAt: new Date(sl.endsAt.getTime() + delta),
            unconfUseAllRooms: sl.unconfUseAllRooms,
            unconfUseAllSubmissions: sl.unconfUseAllSubmissions,
            unconfAvoidRepeats: sl.unconfAvoidRepeats,
            mixerAvoidRepeats: sl.mixerAvoidRepeats,
            seriesId: sl.seriesId === null ? null : (seriesIdMap.get(sl.seriesId) ?? null),
            seatingStale: false,
          },
        });
        slotIdMap.set(sl.id, newSlot.id);
      }

      // Room-scoping selections (remapped to the cloned rooms). Submission
      // scoping is intentionally not carried over — no submissions are cloned.
      const slotRoomData = slotRooms
        .map((sr) => ({ slotId: slotIdMap.get(sr.slotId), roomId: roomIdMap.get(sr.roomId) }))
        .filter((x): x is { slotId: number; roomId: number } =>
          x.slotId !== undefined && x.roomId !== undefined);
      if (slotRoomData.length > 0) await tx.slotRoom.createMany({ data: slotRoomData });

      const seriesRoomData = seriesRooms
        .map((sr) => ({ seriesId: seriesIdMap.get(sr.seriesId), roomId: roomIdMap.get(sr.roomId) }))
        .filter((x): x is { seriesId: number; roomId: number } =>
          x.seriesId !== undefined && x.roomId !== undefined);
      if (seriesRoomData.length > 0) await tx.seriesRoom.createMany({ data: seriesRoomData });

      return conf;
    });

    return { slug: created.slug };
  }),

  // Roster surface. `user_id` in the response is the ConferenceIdentity.id.
  // Identities with ownerUserId set are surfaced as role="owner" because the
  // conference owner has authority via Conference.ownerId regardless of the
  // identity row's stored role.
  listParticipants: requireConf("moderator").conferences.listParticipants.handler(async ({ input, context }) => {
    const { offset, limit, q } = parsePageInput(input);
    const where: Prisma.ConferenceIdentityWhereInput = {
      conferenceId: context.conferenceId,
      ...(q
        ? {
            OR: [
              { email: { contains: q } },
              { name: { contains: q } },
            ],
          }
        : {}),
    };
    const [total, identities] = await Promise.all([
      context.prisma.conferenceIdentity.count({ where }),
      context.prisma.conferenceIdentity.findMany({
        where,
        select: { id: true, email: true, name: true, role: true, ownerUserId: true },
        orderBy: { email: "asc" },
        skip: offset,
        take: limit,
      }),
    ]);
    const items = identities.map((i) => ({
      user_id: i.id,
      email: i.email,
      name: i.name,
      role: i.ownerUserId !== null ? ("owner" as const) : i.role,
    }));
    return pageOf(items, offset, limit, total);
  }),

  removeParticipant: requireConf("moderator").conferences.removeParticipant.handler(async ({ input, context }) => {
    const target = await context.prisma.conferenceIdentity.findFirst({
      where: { id: input.user_id, conferenceId: context.conferenceId },
      select: { id: true, role: true, ownerUserId: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "not_a_member" });
    if (target.ownerUserId !== null) {
      throw new ORPCError("BAD_REQUEST", { message: "cannot_remove_owner" });
    }
    if (target.role === "moderator" && context.principal.role !== "owner") {
      throw new ORPCError("FORBIDDEN");
    }
    // Chat retention (plans/chat.md Phase 9): a removed identity's sent
    // messages would cascade-delete via Message.senderIdentityId → Cascade.
    // But MessageReport.messageId is onDelete:Restrict so any report
    // referencing those messages would block the cascade. Pre-resolve by
    // hard-deleting reports filed against this user's messages — the user
    // is being removed entirely, so the audit trail is closing with them.
    await context.prisma.messageReport.deleteMany({
      where: { message: { senderIdentityId: target.id } },
    });
    await context.prisma.conferenceIdentity.delete({ where: { id: target.id } });
    return { ok: true as const };
  }),

  addModerator: requireConf("owner").conferences.addModerator.handler(async ({ input, context }) => {
    const target = await context.prisma.conferenceIdentity.findFirst({
      where: { id: input.user_id, conferenceId: context.conferenceId },
      select: { id: true, role: true, ownerUserId: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "not_a_member" });
    if (target.ownerUserId !== null) {
      throw new ORPCError("BAD_REQUEST", { message: "already_owner" });
    }
    await context.prisma.conferenceIdentity.update({
      where: { id: target.id },
      data: { role: "moderator" },
    });
    return { ok: true as const };
  }),

  removeModerator: requireConf("owner").conferences.removeModerator.handler(async ({ input, context }) => {
    await context.prisma.conferenceIdentity.updateMany({
      where: {
        id: input.user_id,
        conferenceId: context.conferenceId,
        role: "moderator",
        ownerUserId: null,
      },
      data: { role: "participant" },
    });
    return { ok: true as const };
  }),

  // Hand ownership to another existing global User. Owner-only.
  //
  // Error codes:
  //   - same_user           caller tried to transfer to themselves
  //   - user_not_found      no global User with that email exists; the new
  //                         owner needs to sign up first
  //   - signup_disabled     informational; can't auto-onboard the target
  //                         (handled by caller when the new owner doesn't
  //                         have an account yet)
  //
  // After the update, Conference.ownerId points at the new user. Their
  // ConferenceIdentity auto-mints on next visit (see ensureOwnerIdentity in
  // permissions.ts). The previous owner's auto-minted identity row stays
  // intact but is no longer the privileged path — they'll need to be
  // invited as a moderator if they want to keep helping run the conference.
  transferOwnership: requireConf("owner").conferences.transferOwnership.handler(async ({ input, context }) => {
    const target = await context.prisma.user.findUnique({
      where: { email: input.new_owner_email },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "user_not_found" });
    // requireConf("owner") guarantees the caller's principal is owner-kind,
    // so principal.user is set. Refuse no-op self-transfers up front.
    const callerUserId = context.principal.kind === "owner" ? context.principal.user.id : null;
    if (callerUserId === target.id) {
      throw new ORPCError("CONFLICT", { message: "same_user" });
    }
    await context.prisma.conference.update({
      where: { id: context.conferenceId },
      data: { ownerId: target.id },
    });
    return { ok: true as const };
  }),

  createInvite: requireConf("moderator").conferences.createInvite.handler(async ({ input, context }) => {
    const pendingCount = await context.prisma.conferenceInvite.count({
      where: { conferenceId: context.conferenceId, claimedAt: null },
    });
    assertQuota("pending_invites_per_conference", LIMITS.maxPendingInvitesPerConference, pendingCount);

    const existing = await context.prisma.conferenceIdentity.findUnique({
      where: { conferenceId_email: { conferenceId: context.conferenceId, email: input.email } },
      select: { id: true },
    });
    if (existing) throw new ORPCError("CONFLICT", { message: "email_already_in_conference" });

    const conf = await context.prisma.conference.findUniqueOrThrow({
      where: { id: context.conferenceId }, select: { slug: true },
    });
    // Rotate any pending invite for the same email so resends are idempotent.
    await context.prisma.conferenceInvite.deleteMany({
      where: { conferenceId: context.conferenceId, email: input.email, claimedAt: null },
    });
    const invite = await context.prisma.conferenceInvite.create({
      data: {
        conferenceId: context.conferenceId,
        email: input.email,
        token: newOpaqueToken(),
        role: "participant",
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    // Re-count after insert and fire a threshold heads-up if this insert
    // crossed 80% or hit the cap exactly. Fire-and-forget; mods don't need
    // to wait for the inbox write.
    const pendingNow = await context.prisma.conferenceInvite.count({
      where: { conferenceId: context.conferenceId, claimedAt: null },
    });
    void notifyQuotaThreshold(context.prisma, context.conferenceId, {
      resource: "pending_invites_per_conference",
      label: "Pending invites",
      current: pendingNow,
      limit: LIMITS.maxPendingInvitesPerConference,
    });
    return toInviteOut({ ...invite, conference: { slug: conf.slug } });
  }),

  importInvites: requireConf("moderator").conferences.importInvites.handler(async ({ input, context }) => {
    const conf = await context.prisma.conference.findUniqueOrThrow({
      where: { id: context.conferenceId }, select: { slug: true },
    });
    const lines = input.csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    let added = 0, skipped = 0;
    const errors: { email: string; reason: string }[] = [];
    const invites: ReturnType<typeof toInviteOut>[] = [];
    for (const rawEmail of lines) {
      const email = rawEmail.toLowerCase();
      if (!/^.+@.+\..+$/.test(email)) {
        errors.push({ email, reason: "invalid_email" }); skipped++; continue;
      }
      const dup = await context.prisma.conferenceIdentity.findUnique({
        where: { conferenceId_email: { conferenceId: context.conferenceId, email } },
        select: { id: true },
      });
      if (dup) {
        errors.push({ email, reason: "already_in_conference" }); skipped++; continue;
      }
      try {
        await context.prisma.conferenceInvite.deleteMany({
          where: { conferenceId: context.conferenceId, email, claimedAt: null },
        });
        const invite = await context.prisma.conferenceInvite.create({
          data: {
            conferenceId: context.conferenceId,
            email,
            token: newOpaqueToken(),
            role: "participant",
            expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          },
        });
        invites.push(toInviteOut({ ...invite, conference: { slug: conf.slug } }));
        added++;
      } catch (e) {
        errors.push({ email, reason: String(e) }); skipped++;
      }
    }
    return { added, skipped, errors, invites };
  }),

  listInvites: requireConf("moderator").conferences.listInvites.handler(async ({ input, context }) => {
    const { offset, limit, q } = parsePageInput(input);
    const statusWhere: Prisma.ConferenceInviteWhereInput =
      input.status === "claimed"
        ? { claimedAt: { not: null } }
        : input.status === "all"
          ? {}
          : { claimedAt: null };
    const where: Prisma.ConferenceInviteWhereInput = {
      conferenceId: context.conferenceId,
      ...statusWhere,
      ...(q ? { email: { contains: q } } : {}),
    };
    const [total, invites] = await Promise.all([
      context.prisma.conferenceInvite.count({ where }),
      context.prisma.conferenceInvite.findMany({
        where,
        include: { conference: { select: { slug: true } } },
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      }),
    ]);
    return pageOf(invites.map(toInviteOut), offset, limit, total);
  }),

  exportInvites: requireConf("moderator").conferences.exportInvites.handler(async ({ input, context }) => {
    // Server-side full enumeration of pending invites matching the same `q`
    // the table view applied. The CSV download path needs the full set —
    // looping pages on the client would race against creates/claims and is
    // 10-100x slower for big rosters.
    const q = (input.q ?? "").trim();
    const where: Prisma.ConferenceInviteWhereInput = {
      conferenceId: context.conferenceId,
      claimedAt: null,
      ...(q ? { email: { contains: q } } : {}),
    };
    const invites = await context.prisma.conferenceInvite.findMany({
      where,
      include: { conference: { select: { slug: true } } },
      orderBy: { createdAt: "desc" },
    });
    return { invites: invites.map(toInviteOut) };
  }),

  revokeInvite: requireConf("moderator").conferences.revokeInvite.handler(async ({ input, context }) => {
    await context.prisma.conferenceInvite.deleteMany({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    return { ok: true as const };
  }),

  getJoinLink: requireConf("owner").conferences.getJoinLink.handler(async ({ context }) => {
    const conf = await context.prisma.conference.findUniqueOrThrow({
      where: { id: context.conferenceId }, select: { slug: true },
    });
    const link = await context.prisma.conferenceJoinLink.findUnique({
      where: { conferenceId: context.conferenceId },
    });
    if (!link) {
      return {
        enabled: false, token: null, url: null,
        expires_at: null, max_uses: null, used_count: 0,
      };
    }
    return {
      enabled: link.enabled,
      token: link.token,
      url: joinUrl(conf.slug, link.token),
      expires_at: link.expiresAt?.getTime() ?? null,
      max_uses: link.maxUses,
      used_count: link.usedCount,
    };
  }),

  setJoinLink: requireConf("owner").conferences.setJoinLink.handler(async ({ input, context }) => {
    const conf = await context.prisma.conference.findUniqueOrThrow({
      where: { id: context.conferenceId }, select: { slug: true },
    });
    const existing = await context.prisma.conferenceJoinLink.findUnique({
      where: { conferenceId: context.conferenceId },
    });
    const expiresAt = input.expires_at === undefined
      ? undefined
      : (input.expires_at === null ? null : new Date(input.expires_at));
    const maxUses = input.max_uses === undefined ? undefined : input.max_uses;
    const link = existing
      ? await context.prisma.conferenceJoinLink.update({
          where: { conferenceId: context.conferenceId },
          data: { enabled: input.enabled, expiresAt, maxUses },
        })
      : await context.prisma.conferenceJoinLink.create({
          data: {
            conferenceId: context.conferenceId,
            token: newOpaqueToken(),
            enabled: input.enabled,
            expiresAt: input.expires_at ? new Date(input.expires_at) : null,
            maxUses: input.max_uses ?? null,
          },
        });
    return {
      enabled: link.enabled,
      token: link.token,
      url: joinUrl(conf.slug, link.token),
      expires_at: link.expiresAt?.getTime() ?? null,
      max_uses: link.maxUses,
      used_count: link.usedCount,
    };
  }),

  rotateJoinLink: requireConf("owner").conferences.rotateJoinLink.handler(async ({ context }) => {
    const conf = await context.prisma.conference.findUniqueOrThrow({
      where: { id: context.conferenceId }, select: { slug: true },
    });
    const token = newOpaqueToken();
    const link = await context.prisma.conferenceJoinLink.upsert({
      where: { conferenceId: context.conferenceId },
      update: { token, rotatedAt: new Date(), usedCount: 0 },
      create: { conferenceId: context.conferenceId, token, enabled: false },
    });
    return {
      enabled: link.enabled,
      token: link.token,
      url: joinUrl(conf.slug, link.token),
      expires_at: link.expiresAt?.getTime() ?? null,
      max_uses: link.maxUses,
      used_count: link.usedCount,
    };
  }),

  // ----- public Live Board link (owner-only) -------------------------------
  // The token is the board's only secret — anyone with the URL can view the
  // read-only board. Board state lives on `Conference.boardToken`; enabled is
  // simply "token is set".
  getBoardLink: requireConf("owner").conferences.getBoardLink.handler(async ({ context }) => {
    const conf = await context.prisma.conference.findUniqueOrThrow({
      where: { id: context.conferenceId }, select: { slug: true, boardToken: true },
    });
    return toBoardLinkOut(conf.slug, conf.boardToken);
  }),

  setBoardLink: requireConf("owner").conferences.setBoardLink.handler(async ({ input, context }) => {
    const conf = await context.prisma.conference.findUniqueOrThrow({
      where: { id: context.conferenceId }, select: { slug: true, boardToken: true },
    });
    // Enabling keeps an existing token (stable URL) or mints one; disabling
    // clears the token so the old URL stops resolving.
    const token = input.enabled ? (conf.boardToken ?? newOpaqueToken()) : null;
    if (token !== conf.boardToken) {
      await context.prisma.conference.update({
        where: { id: context.conferenceId }, data: { boardToken: token },
      });
    }
    return toBoardLinkOut(conf.slug, token);
  }),

  rotateBoardLink: requireConf("owner").conferences.rotateBoardLink.handler(async ({ context }) => {
    const conf = await context.prisma.conference.findUniqueOrThrow({
      where: { id: context.conferenceId }, select: { slug: true },
    });
    const token = newOpaqueToken();
    await context.prisma.conference.update({
      where: { id: context.conferenceId }, data: { boardToken: token },
    });
    return toBoardLinkOut(conf.slug, token);
  }),

  previewInvite: base.conferences.previewInvite.handler(async ({ input, context }) => {
    const conf = await context.prisma.conference.findUnique({
      where: { slug: input.slug }, select: { id: true, name: true, slug: true },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });
    const invite = await context.prisma.conferenceInvite.findUnique({
      where: { token: input.token },
    });
    if (!invite || invite.conferenceId !== conf.id) {
      throw new ORPCError("NOT_FOUND", { message: "invalid_invite" });
    }
    if (invite.claimedAt !== null) throw new ORPCError("CONFLICT", { message: "already_claimed" });
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new ORPCError("CONFLICT", { message: "expired" });
    }
    return {
      conference_name: conf.name,
      conference_slug: conf.slug,
      email: invite.email,
      expires_at: invite.expiresAt.getTime(),
    };
  }),

  claimInvite: base.conferences.claimInvite.handler(async ({ input, context }) => {
    // Gate with Turnstile so a hostile mod can't burn the participant cap
    // by self-inviting + bot-redeeming 2500 fake addresses they control.
    // Legitimate invitees see the same invisible auto-pass as elsewhere.
    await assertTurnstile(input.turnstile_token);

    const conf = await context.prisma.conference.findUnique({
      where: { slug: input.slug }, select: { id: true },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });
    const invite = await context.prisma.conferenceInvite.findUnique({
      where: { token: input.token },
    });
    if (!invite || invite.conferenceId !== conf.id) {
      throw new ORPCError("NOT_FOUND", { message: "invalid_invite" });
    }
    if (invite.claimedAt !== null) throw new ORPCError("CONFLICT", { message: "already_claimed" });
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new ORPCError("CONFLICT", { message: "expired" });
    }
    const identityCount = await context.prisma.conferenceIdentity.count({
      where: { conferenceId: conf.id },
    });
    assertQuota("participants_per_conference", LIMITS.maxParticipantsPerConference, identityCount);
    const dup = await context.prisma.conferenceIdentity.findUnique({
      where: { conferenceId_email: { conferenceId: conf.id, email: invite.email } },
      select: { id: true },
    });
    if (dup) throw new ORPCError("CONFLICT", { message: "email_already_in_conference" });

    const passwordHash = await hashPassword(input.password);
    const linkedUserId = await resolveAutoLinkUserId(context, invite.email);
    const identity = await context.prisma.$transaction(async (tx) => {
      const created = await tx.conferenceIdentity.create({
        data: {
          conferenceId: conf.id,
          email: invite.email,
          name: input.name?.trim() || null,
          passwordHash,
          role: invite.role,
          claimedAt: new Date(),
          linkedUserId,
        },
      });
      await tx.conferenceInvite.update({
        where: { id: invite.id },
        data: { claimedAt: new Date(), claimedByIdentityId: created.id },
      });
      return created;
    });
    const participantsNow = await context.prisma.conferenceIdentity.count({
      where: { conferenceId: conf.id },
    });
    void notifyQuotaThreshold(context.prisma, conf.id, {
      resource: "participants_per_conference",
      label: "Participants",
      current: participantsNow,
      limit: LIMITS.maxParticipantsPerConference,
    });
    const sessionToken = await createIdentitySession(context.prisma, identity.id);
    setIdentityCookie(context.responseHeaders, conf.id, sessionToken);
    return toConfMeOut(identity);
  }),

  signupViaLink: base.conferences.signupViaLink.handler(async ({ input, context }) => {
    await assertTurnstile(input.turnstile_token);

    const conf = await context.prisma.conference.findUnique({
      where: { slug: input.slug }, select: { id: true },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });
    const link = await context.prisma.conferenceJoinLink.findUnique({
      where: { conferenceId: conf.id },
    });
    if (!link || !link.enabled || link.token !== input.token) {
      throw new ORPCError("NOT_FOUND", { message: "invalid_join_link" });
    }
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
      throw new ORPCError("CONFLICT", { message: "join_link_expired" });
    }
    if (link.maxUses !== null && link.usedCount >= link.maxUses) {
      throw new ORPCError("CONFLICT", { message: "join_link_exhausted" });
    }
    const identityCount = await context.prisma.conferenceIdentity.count({
      where: { conferenceId: conf.id },
    });
    assertQuota("participants_per_conference", LIMITS.maxParticipantsPerConference, identityCount);
    const dup = await context.prisma.conferenceIdentity.findUnique({
      where: { conferenceId_email: { conferenceId: conf.id, email: input.email } },
      select: { id: true },
    });
    if (dup) throw new ORPCError("CONFLICT", { message: "email_already_in_conference" });

    const passwordHash = await hashPassword(input.password);
    const linkedUserId = await resolveAutoLinkUserId(context, input.email);
    const identity = await context.prisma.$transaction(async (tx) => {
      const created = await tx.conferenceIdentity.create({
        data: {
          conferenceId: conf.id,
          email: input.email,
          name: input.name?.trim() || null,
          passwordHash,
          role: "participant",
          claimedAt: new Date(),
          linkedUserId,
        },
      });
      await tx.conferenceJoinLink.update({
        where: { conferenceId: conf.id },
        data: { usedCount: { increment: 1 } },
      });
      return created;
    });
    const participantsNow = await context.prisma.conferenceIdentity.count({
      where: { conferenceId: conf.id },
    });
    void notifyQuotaThreshold(context.prisma, conf.id, {
      resource: "participants_per_conference",
      label: "Participants",
      current: participantsNow,
      limit: LIMITS.maxParticipantsPerConference,
    });
    const sessionToken = await createIdentitySession(context.prisma, identity.id);
    setIdentityCookie(context.responseHeaders, conf.id, sessionToken);
    return toConfMeOut(identity);
  }),

  login: base.conferences.login.handler(async ({ input, context }) => {
    // Scope the lockout key with the slug so an attacker can't burn another
    // conference's lockout budget for the same email, and the per-event
    // counter cleanly isolates from the global `auth.login` counter.
    const lockoutKey = `conf:${input.slug}:${input.email}`;
    assertLoginAllowed(lockoutKey);

    const conf = await context.prisma.conference.findUnique({
      where: { slug: input.slug },
      select: { id: true, owner: { select: { email: true } } },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });
    const identity = await context.prisma.conferenceIdentity.findUnique({
      where: { conferenceId_email: { conferenceId: conf.id, email: input.email } },
    });
    if (!identity || !identity.passwordHash
        || !(await verifyPassword(input.password, identity.passwordHash))) {
      // Record the failed attempt BEFORE branching so the two targeted codes
      // below are throttled byte-for-byte like a wrong-password guess — an
      // attacker can't probe owner/invite existence faster than they can
      // brute-force a password (accepted, rate-limit-mitigated enumeration).
      recordLoginFailure(lockoutKey);
      if (identity && identity.passwordHash === null) {
        // Identity exists but has no password: either the owner's auto-minted
        // row (send them to the global login) or an invite never claimed.
        throw new ORPCError("UNAUTHORIZED", {
          message: identity.ownerUserId !== null
            ? "owner_use_main_login"
            : "invite_not_claimed",
        });
      }
      if (!identity) {
        if (input.email === conf.owner.email) {
          // Owner who never touched this conference, so no identity was minted.
          // Email is normalized identically on both sides (the `Email` schema
          // trims + lowercases; owner emails are stored the same way).
          throw new ORPCError("UNAUTHORIZED", { message: "owner_use_main_login" });
        }
        // An unclaimed invite means the account was set up but never claimed,
        // so there's no identity row yet. Include expired invites — the client
        // copy tells them to ask an organizer for a fresh invite either way.
        // createInvite runs invite emails through the same `Email` schema, so a
        // direct match against the normalized login email is safe.
        const pendingInvite = await context.prisma.conferenceInvite.findFirst({
          where: { conferenceId: conf.id, email: input.email, claimedAt: null },
          select: { id: true },
        });
        if (pendingInvite) {
          throw new ORPCError("UNAUTHORIZED", { message: "invite_not_claimed" });
        }
      }
      // Last resort before the generic error: did the caller type their GLOBAL
      // organizer-account password here (confusing their two logins)? This is
      // safe to surface because the distinct response only fires for a caller
      // who ALREADY holds valid organizer credentials — they could sign in at
      // auth.login regardless — so it reveals nothing they don't already know.
      //
      // SECURITY: this verifies against the GLOBAL password hash, so it must
      // honour the GLOBAL login budget on BOTH sides, using the exact key
      // auth.login uses (the bare email):
      //  - Gate on the global lock FIRST via the non-throwing `isLoginLocked`.
      //    If the global account is locked we SKIP detection entirely and fall
      //    through to invalid_credentials — a locked account must never act as
      //    a password oracle, and we must not throw account_locked here (that
      //    would itself leak that a global account exists).
      //  - A FAILED global verify records a failure against the global key too
      //    (the conference key was already recorded above), so this endpoint
      //    can't become a global brute-force bypass. A MATCH records no global
      //    failure — it wasn't a wrong global password.
      const globalUser = await context.prisma.user.findUnique({
        where: { email: input.email },
      });
      if (globalUser && !isLoginLocked(input.email)) {
        if (await verifyPassword(input.password, globalUser.passwordHash)) {
          throw new ORPCError("UNAUTHORIZED", { message: "organizer_password_used" });
        }
        recordLoginFailure(input.email);
      }
      throw new ORPCError("UNAUTHORIZED", { message: "invalid_credentials" });
    }
    recordLoginSuccess(lockoutKey);
    const sessionToken = await createIdentitySession(context.prisma, identity.id);
    setIdentityCookie(context.responseHeaders, conf.id, sessionToken);
    return toConfMeOut(identity);
  }),

  // Request a reset link for a per-conference identity. Mirrors the owner flow
  // (no enumeration, rate-limited, Turnstile-protected) but scoped to one
  // conference. Only identities that have actually set a password (claimed
  // their account) get an email; unclaimed rows still return Ok.
  requestPasswordReset: base.conferences.requestPasswordReset.handler(async ({ input, context }) => {
    const ip = clientIp(context.req);
    assertPasswordResetAllowed(`conf:${input.slug}:${input.email}`, ip);
    await assertTurnstile(input.turnstile_token, ip ?? undefined);

    const conf = await context.prisma.conference.findUnique({
      where: { slug: input.slug }, select: { id: true, name: true },
    });
    if (conf) {
      const identity = await context.prisma.conferenceIdentity.findUnique({
        where: { conferenceId_email: { conferenceId: conf.id, email: input.email } },
      });
      if (identity && identity.passwordHash) {
        const token = generateResetToken();
        await context.prisma.conferenceIdentity.update({
          where: { id: identity.id },
          data: {
            passwordResetTokenHash: hashResetToken(token),
            passwordResetExpiresAt: new Date(Date.now() + resetTokenTtlMs()),
          },
        });
        await sendPasswordResetEmail({
          to: identity.email,
          resetUrl: identityResetUrl(input.slug, token),
          ttlMinutes: resetTokenTtlMinutes(),
          scopeName: conf.name,
        });
      }
    }
    return { ok: true as const };
  }),

  // Consume a per-conference reset token: set the new password, clear the
  // token, sign out this identity's other sessions, and log them in here.
  resetPassword: base.conferences.resetPassword.handler(async ({ input, context }) => {
    await assertTurnstile(input.turnstile_token, clientIp(context.req) ?? undefined);

    const conf = await context.prisma.conference.findUnique({
      where: { slug: input.slug }, select: { id: true },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });

    const tokenHash = hashResetToken(input.token);
    const identity = await context.prisma.conferenceIdentity.findUnique({
      where: { passwordResetTokenHash: tokenHash },
    });
    // Token must exist, be unexpired, and belong to THIS conference (defence in
    // depth — the hash is globally unique, but the slug is part of the link).
    if (!identity || identity.conferenceId !== conf.id
        || !identity.passwordResetExpiresAt
        || identity.passwordResetExpiresAt.getTime() <= Date.now()) {
      throw new ORPCError("BAD_REQUEST", { message: "invalid_or_expired_token" });
    }

    const passwordHash = await hashPassword(input.password);
    await context.prisma.$transaction([
      context.prisma.conferenceIdentity.update({
        where: { id: identity.id },
        data: {
          passwordHash,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
        },
      }),
      context.prisma.session.deleteMany({ where: { conferenceIdentityId: identity.id } }),
    ]);

    const sessionToken = await createIdentitySession(context.prisma, identity.id);
    setIdentityCookie(context.responseHeaders, conf.id, sessionToken);
    return toConfMeOut(identity);
  }),

  logout: base.conferences.logout.handler(async ({ input, context }) => {
    const conf = await context.prisma.conference.findUnique({
      where: { slug: input.slug }, select: { id: true },
    });
    if (conf) {
      const cookieToken = readCookie(context.req, identityCookieName(conf.id));
      if (cookieToken) await destroySession(context.prisma, cookieToken);
      clearIdentityCookie(context.responseHeaders, conf.id);
    }
    return { ok: true as const };
  }),

  me: requireConf("participant").conferences.me.handler(async ({ context }) => {
    return toConfMeOut(context.principal.identity);
  }),

  updateConfMe: requireConf("participant").conferences.updateConfMe.handler(async ({ input, context }) => {
    const updated = await context.prisma.conferenceIdentity.update({
      where: { id: context.principal.identity.id },
      data: {
        colorMode: input.color_mode ?? undefined,
        name: input.name === undefined ? undefined : (input.name || null),
      },
    });
    return toConfMeOut(updated);
  }),

  getCalendar: requireConf("participant").conferences.getCalendar.handler(async ({ context }) => {
    let token = context.principal.identity.calendarToken;
    if (!token) {
      token = newOpaqueToken();
      await context.prisma.conferenceIdentity.update({
        where: { id: context.principal.identity.id },
        data: { calendarToken: token },
      });
    }
    return { token, path: calendarFeedPath(token) };
  }),

  resetCalendar: requireConf("participant").conferences.resetCalendar.handler(async ({ context }) => {
    const token = newOpaqueToken();
    await context.prisma.conferenceIdentity.update({
      where: { id: context.principal.identity.id },
      data: { calendarToken: token },
    });
    return { token, path: calendarFeedPath(token) };
  }),
};
