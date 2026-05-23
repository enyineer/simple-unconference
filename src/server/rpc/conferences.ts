import { ORPCError } from "@orpc/server";
import {
  base, authed, requireConf, actorIdentityId,
  slugify, INVITE_TTL_MS, newOpaqueToken, joinUrl, calendarFeedPath,
  toInviteOut, toConfMeOut,
} from "./shared";
import {
  hashPassword, verifyPassword,
  createIdentitySession, destroySession,
  setIdentityCookie, clearIdentityCookie,
  readCookie, identityCookieName,
} from "../auth";
import { notifyQuotaThreshold } from "../notifications";
import {
  LIMITS,
  assertQuota,
  assertLoginAllowed, recordLoginFailure, recordLoginSuccess,
  recordWrite,
} from "../lib/limits";
import { assertTurnstile } from "../lib/turnstile";

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

  create: authed.conferences.create.handler(async ({ input, context }) => {
    const ownedCount = await context.prisma.conference.count({
      where: { ownerId: context.user.id },
    });
    assertQuota("conferences_per_user", LIMITS.maxConferencesPerUser, ownedCount);
    recordWrite(context.user.id);

    const baseSlug = slugify(input.name);
    let slug = baseSlug;
    let n = 1;
    while (await context.prisma.conference.findUnique({ where: { slug }, select: { id: true } })) {
      n++;
      slug = `${baseSlug}-${n}`;
    }
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
    await context.prisma.conference.delete({
      where: { id: context.conferenceId },
    });
    return { ok: true as const };
  }),

  // Roster surface. `user_id` in the response is the ConferenceIdentity.id.
  // Identities with ownerUserId set are surfaced as role="owner" because the
  // conference owner has authority via Conference.ownerId regardless of the
  // identity row's stored role.
  listParticipants: requireConf("moderator").conferences.listParticipants.handler(async ({ context }) => {
    const identities = await context.prisma.conferenceIdentity.findMany({
      where: { conferenceId: context.conferenceId },
      select: { id: true, email: true, name: true, role: true, ownerUserId: true },
      orderBy: { email: "asc" },
    });
    return identities.map((i) => ({
      user_id: i.id,
      email: i.email,
      name: i.name,
      role: i.ownerUserId !== null ? ("owner" as const) : i.role,
    }));
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

  listInvites: requireConf("moderator").conferences.listInvites.handler(async ({ context }) => {
    const invites = await context.prisma.conferenceInvite.findMany({
      where: { conferenceId: context.conferenceId },
      include: { conference: { select: { slug: true } } },
      orderBy: { createdAt: "desc" },
    });
    return invites.map(toInviteOut);
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
    const identity = await context.prisma.$transaction(async (tx) => {
      const created = await tx.conferenceIdentity.create({
        data: {
          conferenceId: conf.id,
          email: invite.email,
          name: input.name?.trim() || null,
          passwordHash,
          role: invite.role,
          claimedAt: new Date(),
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
    const identity = await context.prisma.$transaction(async (tx) => {
      const created = await tx.conferenceIdentity.create({
        data: {
          conferenceId: conf.id,
          email: input.email,
          name: input.name?.trim() || null,
          passwordHash,
          role: "participant",
          claimedAt: new Date(),
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
      where: { slug: input.slug }, select: { id: true },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });
    const identity = await context.prisma.conferenceIdentity.findUnique({
      where: { conferenceId_email: { conferenceId: conf.id, email: input.email } },
    });
    if (!identity || !identity.passwordHash
        || !(await verifyPassword(input.password, identity.passwordHash))) {
      recordLoginFailure(lockoutKey);
      throw new ORPCError("UNAUTHORIZED", { message: "invalid_credentials" });
    }
    recordLoginSuccess(lockoutKey);
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
