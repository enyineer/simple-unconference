// oRPC server router: every API procedure declared in `src/shared/contract.ts`
// is implemented here. The shape returned by each handler is checked at
// compile time against the contract via the `implement(contract)` pattern,
// so client/server drift surfaces as a TypeScript error.
//
// One exception: GET /api/calendar/<token>.ics is served directly by Hono
// (see `src/server/routes/calendar.ts`) because it produces text/calendar
// for third-party calendar clients to subscribe to.

import { implement, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { PrismaClient, SubmissionStatus, Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { contract } from "../shared/contract";
import {
  hashPassword, verifyPassword,
  createOwnerSession, createIdentitySession, destroySession,
  principalFromRequest,
  setOwnerCookie, clearOwnerCookie,
  setIdentityCookie, clearIdentityCookie,
  readCookie, ownerCookieName, identityCookieName,
} from "./auth";
import {
  hasRoleAtLeast,
  resolveConferencePrincipal,
  type ResolvedPrincipal,
  type Role,
} from "./lib/permissions";
import { assignUnconferenceSlot, assignMixerSlot, pairKey, type AssignmentInput } from "./assignment";
import { deriveSlots, pickAvailableRoom } from "./experts";
import { notify, notifyMany, modIdentityIds } from "./notifications";

// ----- shared types ---------------------------------------------------------

export interface RpcContext {
  prisma: PrismaClient;
  // Raw fetch request — used to read session cookies + set Set-Cookie.
  req: Request;
  // Filled by handle() to forward Set-Cookie headers from the procedure
  // back into the final HTTP response.
  responseHeaders: Headers;
}

function toUserOut(u: { id: number; email: string; name: string | null }) {
  return { id: u.id, email: u.email, name: u.name };
}

// Returns the acting identity's id for any conference-scoped handler. For
// owners this is the auto-minted ConferenceIdentity row; for identity-kind
// principals it is the identity itself.
export function actorIdentityId(ctx: { principal: ResolvedPrincipal }): number {
  return ctx.principal.identity.id;
}

// ----- implementer + middlewares -------------------------------------------

const base = implement(contract).$context<RpcContext>();

// Owner-only auth gate. Reads the global cookie; raises UNAUTHORIZED otherwise.
const authed = base.use(async ({ context, next }) => {
  const principal = await principalFromRequest(context.prisma, context.req, { type: "owner" });
  if (!principal || principal.kind !== "owner") {
    throw new ORPCError("UNAUTHORIZED", { message: "not_authenticated" });
  }
  return next({ context: { ...context, user: principal.user } });
});

// Conference-scoped gate. Resolves the principal for this conference (owner
// via global cookie OR per-conference identity cookie) and enforces minRole.
// Sets `conferenceId` and `principal` on context for downstream handlers.
function requireConf(minRole: Role) {
  return base.use(async ({ context, next }, input) => {
    const slug = (input as { slug?: string }).slug;
    if (typeof slug !== "string") throw new ORPCError("BAD_REQUEST");
    const conf = await context.prisma.conference.findUnique({
      where: { slug }, select: { id: true },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });
    const principal = await resolveConferencePrincipal(context.prisma, context.req, conf.id);
    if (!principal) {
      throw new ORPCError("UNAUTHORIZED", { message: "not_authenticated" });
    }
    if (!hasRoleAtLeast(principal.role, minRole)) {
      throw new ORPCError("FORBIDDEN");
    }
    return next({ context: { ...context, conferenceId: conf.id, principal } });
  });
}

// ----- small helpers reused across handlers --------------------------------

function slugify(name: string): string {
  return (
    name.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "conf"
  );
}

function normalizeLabels(input: string[] | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const v = raw.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// ----- invite + join-link + calendar helpers -------------------------------

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function newOpaqueToken(): string {
  // 64 hex characters. The calendar feed validator expects 16-128 hex, so
  // the same shape works for invite / join-link / calendar tokens alike.
  return randomBytes(32).toString("hex");
}

function joinUrl(slug: string, token: string): string {
  return `/c/${slug}/join?t=${token}`;
}

function calendarFeedPath(token: string): string {
  return `/api/calendar/${token}.ics`;
}

type InviteRow = {
  id: number;
  email: string;
  token: string;
  role: "moderator" | "participant";
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  conference: { slug: string };
};

function toInviteOut(invite: InviteRow): {
  id: number; email: string; token: string; url: string;
  role: "moderator" | "participant";
  created_at: number; expires_at: number; claimed_at: number | null;
} {
  return {
    id: invite.id,
    email: invite.email,
    token: invite.token,
    url: joinUrl(invite.conference.slug, invite.token),
    role: invite.role,
    created_at: invite.createdAt.getTime(),
    expires_at: invite.expiresAt.getTime(),
    claimed_at: invite.claimedAt?.getTime() ?? null,
  };
}

// Conference-scoped identity payload returned by login / claim / signup / me.
function toConfMeOut(identity: {
  id: number; email: string; name: string | null; role: "moderator" | "participant";
  colorMode: string; ownerUserId: number | null;
}): {
  id: number; email: string; name: string | null;
  role: "owner" | "moderator" | "participant";
  color_mode: "auto" | "light" | "dark";
} {
  const cm = (identity.colorMode === "light" || identity.colorMode === "dark"
    ? identity.colorMode
    : "auto") as "auto" | "light" | "dark";
  const role = identity.ownerUserId !== null ? "owner" as const : identity.role;
  return {
    id: identity.id,
    email: identity.email,
    name: identity.name,
    role,
    color_mode: cm,
  };
}

// =========================================================================
// AUTH
// =========================================================================

const authRouter = {
  signup: base.auth.signup.handler(async ({ input, context }) => {
    const existing = await context.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ORPCError("CONFLICT", { message: "email_taken" });
    const passwordHash = await hashPassword(input.password);
    const user = await context.prisma.user.create({
      data: { email: input.email, name: input.name?.trim() || null, passwordHash },
    });
    const token = await createOwnerSession(context.prisma, user.id);
    setOwnerCookie(context.responseHeaders, token);
    return toUserOut(user);
  }),

  login: base.auth.login.handler(async ({ input, context }) => {
    const user = await context.prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new ORPCError("UNAUTHORIZED", { message: "invalid_credentials" });
    }
    const token = await createOwnerSession(context.prisma, user.id);
    setOwnerCookie(context.responseHeaders, token);
    return toUserOut(user);
  }),

  logout: base.auth.logout.handler(async ({ context }) => {
    const token = readCookie(context.req, ownerCookieName());
    if (token) await destroySession(context.prisma, token);
    clearOwnerCookie(context.responseHeaders);
    return { ok: true as const };
  }),

  me: authed.auth.me.handler(async ({ context }) => {
    return toUserOut(context.user);
  }),
};

// =========================================================================
// CONFERENCES
// =========================================================================

const conferenceRouter = {
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
    return {
      id: conf.id, name: conf.name, slug: conf.slug,
      owner_id: conf.ownerId, created_at: conf.createdAt.getTime(),
      design_system: conf.designSystem,
      timezone: conf.timezone,
      mixer_avoid_repeats_default: conf.mixerAvoidRepeatsDefault,
      submission_max_placements_default: conf.submissionMaxPlacementsDefault,
      participant_submissions_enabled: conf.participantSubmissionsEnabled,
      my_role: context.principal.role,
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

  // =========================================================================
  // INVITES (moderator+)
  // =========================================================================

  createInvite: requireConf("moderator").conferences.createInvite.handler(async ({ input, context }) => {
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

  // =========================================================================
  // JOIN LINK (owner-only)
  // =========================================================================

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

  // =========================================================================
  // ANONYMOUS ONBOARDING + LOGIN
  // =========================================================================

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
    const sessionToken = await createIdentitySession(context.prisma, identity.id);
    setIdentityCookie(context.responseHeaders, conf.id, sessionToken);
    return toConfMeOut(identity);
  }),

  signupViaLink: base.conferences.signupViaLink.handler(async ({ input, context }) => {
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
    const sessionToken = await createIdentitySession(context.prisma, identity.id);
    setIdentityCookie(context.responseHeaders, conf.id, sessionToken);
    return toConfMeOut(identity);
  }),

  login: base.conferences.login.handler(async ({ input, context }) => {
    const conf = await context.prisma.conference.findUnique({
      where: { slug: input.slug }, select: { id: true },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });
    const identity = await context.prisma.conferenceIdentity.findUnique({
      where: { conferenceId_email: { conferenceId: conf.id, email: input.email } },
    });
    if (!identity || !identity.passwordHash
        || !(await verifyPassword(input.password, identity.passwordHash))) {
      throw new ORPCError("UNAUTHORIZED", { message: "invalid_credentials" });
    }
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

  // =========================================================================
  // PER-CONFERENCE IDENTITY ME + CALENDAR
  // =========================================================================

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

// =========================================================================
// ROOMS
// =========================================================================

const roomsRouter = {
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

// =========================================================================
// SUBMISSIONS
// =========================================================================

async function setStatus(prisma: PrismaClient, confId: number, id: number, status: SubmissionStatus) {
  await prisma.submission.updateMany({ where: { id, conferenceId: confId }, data: { status } });
}

// Resolves a submission's "finished" state against the conference default.
// A submission is finished when the moderator manually flagged it, or when
// the placement count meets/exceeds the effective cap (per-submission override
// falls back to Conference.submissionMaxPlacementsDefault).
//
// `placement_count` here is the sum of static TrackAssignments and
// UnconferencePlacements pointing at this submission. Both count because
// either kind of placement means the talk has been "given" in the schedule.
function resolveFinished(
  sub: { maxPlacements: number | null; manuallyFinished: boolean },
  confDefault: number | null,
  placementCount: number,
): { effective_cap: number | null; is_finished: boolean } {
  const cap = sub.maxPlacements ?? confDefault;
  if (sub.manuallyFinished) return { effective_cap: cap, is_finished: true };
  if (cap === null) return { effective_cap: null, is_finished: false };
  return { effective_cap: cap, is_finished: placementCount >= cap };
}

const submissionsRouter = {
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
          submitter: { select: { id: true, email: true, name: true } },
          _count: { select: { stars: true, placements: true, trackAssignments: true } },
          stars: { where: { userId: myIdentityId }, select: { userId: true } },
          tags: { select: { value: true }, orderBy: { value: "asc" } },
          requirements: { select: { value: true }, orderBy: { value: "asc" } },
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
        title: s.title,
        description: s.description,
        status: s.status,
        created_at: s.createdAt.getTime(),
        star_count: s._count.stars,
        starred_by_me: s.stars.length > 0,
        tags: s.tags.map((t) => t.value),
        requirements: s.requirements.map((r) => r.value),
        max_placements: s.maxPlacements,
        manually_finished: s.manuallyFinished,
        placement_count: placementCount,
        is_finished,
      };
    });

    // Hide finished sessions from non-mods on the overview. Mods/owners still
    // see them (rendered with a "finished" badge in the UI) so they can flip
    // the manual override or bump the cap.
    const visible = isMod ? rows : rows.filter((r) => !r.is_finished);

    return visible.sort((a, b) =>
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
    const created = await context.prisma.submission.create({
      data: {
        conferenceId: context.conferenceId, submitterId: actorIdentityId(context),
        title: input.title, description: input.description ?? "",
        tags:         { create: tags.map((value) => ({ value })) },
        requirements: { create: requirements.map((value) => ({ value })) },
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

// =========================================================================
// AGENDA
// =========================================================================

async function runAssignmentForSlot(prisma: PrismaClient, confId: number, slotId: number) {
  const slot = await prisma.agendaSlot.findUniqueOrThrow({
    where: { id: slotId },
    include: {
      selectedRooms: { select: { roomId: true } },
      selectedSubmissions: { select: { submissionId: true } },
    },
  });

  const roomWhere = slot.unconfUseAllRooms
    ? { conferenceId: confId }
    : { conferenceId: confId, id: { in: slot.selectedRooms.map((r) => r.roomId) } };
  const rooms = await prisma.room.findMany({
    where: roomWhere, select: { id: true, capacity: true },
  });

  const subWhere = slot.unconfUseAllSubmissions
    ? { conferenceId: confId, status: "published" as const }
    : {
        conferenceId: confId, status: "published" as const,
        id: { in: slot.selectedSubmissions.map((s) => s.submissionId) },
      };
  const rawSubs = await prisma.submission.findMany({
    where: subWhere,
    select: {
      id: true, submitterId: true,
      maxPlacements: true, manuallyFinished: true,
    },
  });
  // Count placements + static tracks per submission, excluding the current
  // slot itself so a re-run doesn't push a still-eligible submission over
  // the cap. Both kinds of placement count toward "finished".
  const [otherPlacements, otherTracks, confRow] = await Promise.all([
    prisma.unconferencePlacement.groupBy({
      by: ["submissionId"],
      where: {
        slotId: { not: slotId },
        slot: { conferenceId: confId },
      },
      _count: { submissionId: true },
    }),
    prisma.trackAssignment.groupBy({
      by: ["submissionId"],
      where: {
        slotId: { not: slotId },
        slot: { conferenceId: confId },
        submissionId: { not: null },
      },
      _count: { submissionId: true },
    }),
    prisma.conference.findUniqueOrThrow({
      where: { id: confId }, select: { submissionMaxPlacementsDefault: true },
    }),
  ]);
  const placementCountBySub = new Map<number, number>();
  for (const p of otherPlacements) {
    placementCountBySub.set(p.submissionId, (placementCountBySub.get(p.submissionId) ?? 0) + p._count.submissionId);
  }
  for (const t of otherTracks) {
    if (t.submissionId === null) continue;
    placementCountBySub.set(t.submissionId, (placementCountBySub.get(t.submissionId) ?? 0) + t._count.submissionId);
  }
  const submissions = rawSubs
    .filter((s) => {
      const { is_finished } = resolveFinished(
        { maxPlacements: s.maxPlacements, manuallyFinished: s.manuallyFinished },
        confRow.submissionMaxPlacementsDefault,
        placementCountBySub.get(s.id) ?? 0,
      );
      return !is_finished;
    })
    .map((s) => ({ id: s.id, submitterId: s.submitterId }));
  const submissionIds = new Set(submissions.map((s) => s.id));

  const starsRows = await prisma.star.findMany({
    where: { submission: { conferenceId: confId, status: "published" } },
    select: { userId: true, submissionId: true },
  });
  const identityRows = await prisma.conferenceIdentity.findMany({
    where: { conferenceId: confId }, select: { id: true },
  });
  const stars = new Map<number, Set<number>>();
  for (const i of identityRows) stars.set(i.id, new Set());
  for (const s of starsRows) {
    if (!submissionIds.has(s.submissionId)) continue;
    stars.get(s.userId)?.add(s.submissionId);
  }

  const prior = await prisma.userAssignment.findMany({
    where: {
      slot: { conferenceId: confId, type: "unconference", id: { not: slotId } },
      submissionId: { not: null },
    },
    select: { userId: true, submissionId: true },
  });
  const priorAssignments = new Map<number, Set<number>>();
  for (const p of prior) {
    if (p.submissionId === null) continue;
    let set = priorAssignments.get(p.userId);
    if (!set) { set = new Set(); priorAssignments.set(p.userId, set); }
    set.add(p.submissionId);
  }

  const manualRows = await prisma.userAssignment.findMany({
    where: { slotId, manual: true, submissionId: { not: null } },
    select: { userId: true, submissionId: true },
  });
  const fixedAssignments = new Map<number, number>();
  for (const m of manualRows) {
    if (m.submissionId !== null) fixedAssignments.set(m.userId, m.submissionId);
  }

  const input: AssignmentInput = {
    rooms,
    submissions: submissions.map((s) => ({ id: s.id, submitter_id: s.submitterId })),
    stars, priorAssignments,
    avoidRepeats: slot.unconfAvoidRepeats,
    fixedAssignments,
  };
  const result = assignUnconferenceSlot(input);

  const roomBySubmission = new Map<number, number>();
  for (const p of result.placements) roomBySubmission.set(p.submission_id, p.room_id);
  const honoredManual = new Set<number>();
  for (const a of result.user_assignments) {
    if (fixedAssignments.get(a.user_id) === a.submission_id) honoredManual.add(a.user_id);
  }

  await prisma.$transaction([
    prisma.unconferencePlacement.deleteMany({ where: { slotId } }),
    prisma.userAssignment.deleteMany({ where: { slotId } }),
    prisma.unconferencePlacement.createMany({
      data: result.placements.map((p) => ({
        slotId, submissionId: p.submission_id, roomId: p.room_id,
      })),
    }),
    prisma.userAssignment.createMany({
      data: result.user_assignments.map((a) => ({
        slotId, userId: a.user_id, submissionId: a.submission_id,
        roomId: roomBySubmission.get(a.submission_id) ?? null,
        manual: honoredManual.has(a.user_id),
      })),
    }),
  ]);

  return {
    placements: result.placements.map((p) => ({ ...p, slot_id: slotId })),
    user_assignments: result.user_assignments.map((a) => ({ ...a, slot_id: slotId })),
    unplaced_users: result.unplaced_users,
  };
}

async function runMixerForSlot(prisma: PrismaClient, confId: number, slotId: number) {
  const slot = await prisma.agendaSlot.findUniqueOrThrow({
    where: { id: slotId },
    include: { selectedRooms: { select: { roomId: true } } },
  });
  const conf = await prisma.conference.findUniqueOrThrow({
    where: { id: confId },
    select: { mixerAvoidRepeatsDefault: true },
  });

  const roomWhere = slot.unconfUseAllRooms
    ? { conferenceId: confId }
    : { conferenceId: confId, id: { in: slot.selectedRooms.map((r) => r.roomId) } };
  const rooms = await prisma.room.findMany({
    where: roomWhere, select: { id: true, capacity: true },
  });
  const identityRows = await prisma.conferenceIdentity.findMany({
    where: { conferenceId: confId }, select: { id: true },
  });

  // Resolve the slot's effective mode against the conference default. When
  // exclusive, gather pairings from every OTHER exclusive mixer in the
  // conference. "Other" excludes this slot itself so re-running a mixer
  // doesn't avoid the pairings it produced last time (which would force the
  // algorithm to scramble pointlessly on every rerun).
  const effectiveAvoid = slot.mixerAvoidRepeats ?? conf.mixerAvoidRepeatsDefault;
  let priorPairings: Set<string> | undefined;
  if (effectiveAvoid) {
    const otherMixers = await prisma.agendaSlot.findMany({
      where: {
        conferenceId: confId,
        type: "mixer",
        id: { not: slotId },
      },
      select: { id: true, mixerAvoidRepeats: true },
    });
    const exclusiveSlotIds = otherMixers
      .filter((m) => (m.mixerAvoidRepeats ?? conf.mixerAvoidRepeatsDefault))
      .map((m) => m.id);
    priorPairings = new Set<string>();
    if (exclusiveSlotIds.length > 0) {
      const priorAssigns = await prisma.userAssignment.findMany({
        where: { slotId: { in: exclusiveSlotIds }, roomId: { not: null } },
        select: { slotId: true, userId: true, roomId: true },
      });
      const byRoom = new Map<string, number[]>();
      for (const a of priorAssigns) {
        const key = `${a.slotId}:${a.roomId}`;
        const arr = byRoom.get(key) ?? [];
        arr.push(a.userId);
        byRoom.set(key, arr);
      }
      for (const [, users] of byRoom) {
        for (let i = 0; i < users.length; i++) {
          for (let j = i + 1; j < users.length; j++) {
            priorPairings.add(pairKey(users[i]!, users[j]!));
          }
        }
      }
    }
  }

  const result = assignMixerSlot({
    rooms, userIds: identityRows.map((i) => i.id), seed: slotId, priorPairings,
  });

  await prisma.$transaction([
    prisma.unconferencePlacement.deleteMany({ where: { slotId } }),
    prisma.userAssignment.deleteMany({ where: { slotId } }),
    prisma.userAssignment.createMany({
      data: result.room_assignments.map((a) => ({
        slotId, userId: a.user_id, submissionId: null, roomId: a.room_id,
      })),
    }),
  ]);

  return {
    room_assignments: result.room_assignments.map((a) => ({ ...a, slot_id: slotId })),
    unplaced_users: result.unplaced_users,
  };
}

const agendaRouter = {
  get: requireConf("participant").agenda.get.handler(async ({ context }) => {
    const confId = context.conferenceId;
    const userId = actorIdentityId(context);
    const [slots, tracks, placements, slotRooms, slotSubs, myStaticStars, mixerAssigns, unconfCounts, conf] = await Promise.all([
      context.prisma.agendaSlot.findMany({
        where: { conferenceId: confId }, orderBy: { startsAt: "asc" },
      }),
      context.prisma.trackAssignment.findMany({
        where: { slot: { conferenceId: confId } },
        include: {
          _count: { select: { stars: true } },
          requirements: { select: { value: true }, orderBy: { value: "asc" } },
        },
      }),
      context.prisma.unconferencePlacement.findMany({
        where: { slot: { conferenceId: confId } },
      }),
      context.prisma.slotRoom.findMany({ where: { slot: { conferenceId: confId } } }),
      context.prisma.slotSubmission.findMany({ where: { slot: { conferenceId: confId } } }),
      context.prisma.staticStar.findMany({
        where: { userId, track: { slot: { conferenceId: confId } } },
        select: { trackId: true },
      }),
      context.prisma.userAssignment.groupBy({
        by: ["slotId", "roomId"],
        where: { slot: { conferenceId: confId, type: "mixer" }, roomId: { not: null } },
        _count: { userId: true },
      }),
      context.prisma.userAssignment.groupBy({
        by: ["slotId", "submissionId"],
        where: { slot: { conferenceId: confId, type: "unconference" }, submissionId: { not: null } },
        _count: { userId: true },
      }),
      context.prisma.conference.findUniqueOrThrow({
        where: { id: confId },
        select: { mixerAvoidRepeatsDefault: true },
      }),
    ]);
    const starredTrackIds = new Set(myStaticStars.map((s) => s.trackId));
    return {
      slots: slots.map((s) => ({
        id: s.id, type: s.type, title: s.title, description: s.description,
        starts_at: s.startsAt.getTime(), ends_at: s.endsAt.getTime(),
        unconf_use_all_rooms: s.unconfUseAllRooms,
        unconf_use_all_submissions: s.unconfUseAllSubmissions,
        unconf_avoid_repeats: s.unconfAvoidRepeats,
        mixer_avoid_repeats: s.mixerAvoidRepeats,
        mixer_avoid_repeats_effective: s.mixerAvoidRepeats ?? conf.mixerAvoidRepeatsDefault,
        unconf_room_ids: slotRooms.filter((r) => r.slotId === s.id).map((r) => r.roomId),
        unconf_submission_ids: slotSubs.filter((x) => x.slotId === s.id).map((x) => x.submissionId),
      })),
      tracks: tracks.map((t) => ({
        id: t.id, slot_id: t.slotId, room_id: t.roomId,
        submission_id: t.submissionId, title: t.title, speakers: t.speakers,
        star_count: t._count.stars,
        starred_by_me: starredTrackIds.has(t.id),
        requirements: t.requirements.map((r) => r.value),
        mandatory: t.mandatory,
      })),
      placements: placements.map((p) => {
        const count = unconfCounts.find((u) =>
          u.slotId === p.slotId && u.submissionId === p.submissionId)?._count.userId ?? 0;
        return {
          slot_id: p.slotId, submission_id: p.submissionId, room_id: p.roomId,
          attendee_count: count,
        };
      }),
      mixer_placements: mixerAssigns
        .filter((m) => m.roomId !== null)
        .map((m) => ({
          slot_id: m.slotId, room_id: m.roomId as number,
          attendee_count: m._count.userId,
        })),
    };
  }),

  createSlot: requireConf("moderator").agenda.createSlot.handler(async ({ input, context }) => {
    // Cross-field check that lived on `CreateSlotSchema` via `v.forward`.
    // It got dropped when we spread the schema entries into the contract
    // (the spread loses the pipe-attached validator); enforced here instead.
    if (input.ends_at <= input.starts_at) {
      throw new ORPCError("BAD_REQUEST", { message: "ends_before_starts" });
    }
    const created = await context.prisma.agendaSlot.create({
      data: {
        conferenceId: context.conferenceId,
        type: input.type,
        title: input.title ?? null,
        description: input.description ?? null,
        startsAt: new Date(input.starts_at),
        endsAt: new Date(input.ends_at),
        // Only meaningful for mixer slots; harmless null on others.
        mixerAvoidRepeats: input.type === "mixer"
          ? (input.mixer_avoid_repeats ?? null)
          : null,
      },
    });
    return { id: created.id };
  }),

  updateSlot: requireConf("moderator").agenda.updateSlot.handler(async ({ input, context }) => {
    // Same cross-field check as createSlot — only fire when both sides supplied.
    if (input.starts_at !== undefined && input.ends_at !== undefined
        && input.ends_at <= input.starts_at) {
      throw new ORPCError("BAD_REQUEST", { message: "ends_before_starts" });
    }
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    await context.prisma.$transaction(async (tx) => {
      await tx.agendaSlot.update({
        where: { id: input.id },
        data: {
          title: input.title ?? undefined,
          description: input.description ?? undefined,
          startsAt: input.starts_at ? new Date(input.starts_at) : undefined,
          endsAt: input.ends_at ? new Date(input.ends_at) : undefined,
          unconfUseAllRooms: input.unconf_use_all_rooms ?? undefined,
          unconfUseAllSubmissions: input.unconf_use_all_submissions ?? undefined,
          unconfAvoidRepeats: input.unconf_avoid_repeats ?? undefined,
          // Distinguish "not in the patch" from "explicit null (inherit)".
          // `mixer_avoid_repeats` is the only nullable field on this update.
          mixerAvoidRepeats: input.mixer_avoid_repeats === undefined
            ? undefined
            : input.mixer_avoid_repeats,
        },
      });
      if (input.unconf_room_ids !== undefined) {
        const validRooms = await tx.room.findMany({
          where: { conferenceId: context.conferenceId, id: { in: input.unconf_room_ids } },
          select: { id: true },
        });
        const ok = new Set(validRooms.map((r) => r.id));
        await tx.slotRoom.deleteMany({ where: { slotId: input.id } });
        if (ok.size > 0) {
          await tx.slotRoom.createMany({
            data: [...ok].map((roomId) => ({ slotId: input.id, roomId })),
          });
        }
      }
      if (input.unconf_submission_ids !== undefined) {
        const validSubs = await tx.submission.findMany({
          where: { conferenceId: context.conferenceId, id: { in: input.unconf_submission_ids } },
          select: { id: true },
        });
        const ok = new Set(validSubs.map((s) => s.id));
        await tx.slotSubmission.deleteMany({ where: { slotId: input.id } });
        if (ok.size > 0) {
          await tx.slotSubmission.createMany({
            data: [...ok].map((submissionId) => ({ slotId: input.id, submissionId })),
          });
        }
      }
    });
    return { ok: true as const };
  }),

  deleteSlot: requireConf("moderator").agenda.deleteSlot.handler(async ({ input, context }) => {
    await context.prisma.agendaSlot.deleteMany({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    return { ok: true as const };
  }),

  setTrack: requireConf("moderator").agenda.setTrack.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    if (slot.type !== "normal") throw new ORPCError("BAD_REQUEST", { message: "not_a_static_slot" });
    const speakers = (input.speakers ?? "").trim() || null;
    // Track requirements are replaced (not merged) on each save so the
    // editor's "clear all" intent is honored. When omitted, leave the
    // existing set untouched.
    const reqs = input.requirements === undefined
      ? undefined
      : normalizeLabels(input.requirements);

    await context.prisma.$transaction(async (tx) => {
      const track = await tx.trackAssignment.upsert({
        where: { slotId_roomId: { slotId: input.slot_id, roomId: input.room_id } },
        create: {
          slotId: input.slot_id, roomId: input.room_id,
          submissionId: input.submission_id ?? null,
          title: input.title ?? null, speakers,
          mandatory: input.mandatory ?? false,
        },
        update: {
          submissionId: input.submission_id ?? null,
          title: input.title ?? null, speakers,
          // Omit from update payload when client didn't send it, so existing
          // value sticks (avoids clobbering a mod-toggled flag on unrelated edits).
          mandatory: input.mandatory ?? undefined,
        },
        select: { id: true },
      });
      if (reqs !== undefined) {
        await tx.trackRequirement.deleteMany({ where: { trackId: track.id } });
        if (reqs.length > 0) {
          await tx.trackRequirement.createMany({
            data: reqs.map((value) => ({ trackId: track.id, value })),
          });
        }
      }
    });
    return { ok: true as const };
  }),

  clearTrack: requireConf("moderator").agenda.clearTrack.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    await context.prisma.trackAssignment.deleteMany({
      where: { slotId: input.slot_id, roomId: input.room_id },
    });
    return { ok: true as const };
  }),

  starTrack: requireConf("participant").agenda.starTrack.handler(async ({ input, context }) => {
    const t = await context.prisma.trackAssignment.findFirst({
      where: { id: input.track_id, slotId: input.slot_id, slot: { conferenceId: context.conferenceId } },
      select: { id: true, mandatory: true, slot: { select: { type: true } } },
    });
    if (!t) throw new ORPCError("NOT_FOUND");
    if (t.slot.type !== "normal") throw new ORPCError("BAD_REQUEST", { message: "not_a_static_track" });
    // Mandatory tracks are force-attended — starring is a no-op. We accept it
    // silently so a client that hasn't refreshed yet doesn't error out.
    if (t.mandatory) return { ok: true as const };
    const myIdentityId = actorIdentityId(context);
    await context.prisma.staticStar.upsert({
      where: { userId_trackId: { userId: myIdentityId, trackId: input.track_id } },
      create: { userId: myIdentityId, trackId: input.track_id },
      update: {},
    });
    return { ok: true as const };
  }),

  unstarTrack: requireConf("participant").agenda.unstarTrack.handler(async ({ input, context }) => {
    const t = await context.prisma.trackAssignment.findFirst({
      where: { id: input.track_id, slot: { conferenceId: context.conferenceId } },
      select: { id: true, mandatory: true },
    });
    if (!t) throw new ORPCError("NOT_FOUND");
    // Mandatory tracks can't be unstarred — they're force-attended by design.
    if (t.mandatory) throw new ORPCError("FORBIDDEN", { message: "track_is_mandatory" });
    await context.prisma.staticStar.deleteMany({
      where: { userId: actorIdentityId(context), trackId: input.track_id },
    });
    return { ok: true as const };
  }),

  assign: requireConf("moderator").agenda.assign.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    if (slot.type === "unconference") {
      const r = await runAssignmentForSlot(context.prisma, context.conferenceId, input.slot_id);
      // Notify each assigned participant. The "manual" picks (preserved across
      // re-runs) re-notify too — harmless and lets the participant know the
      // round was finalized.
      const subTitles = new Map<number, string>(
        (await context.prisma.submission.findMany({
          where: { id: { in: r.user_assignments.map((a) => a.submission_id) } },
          select: { id: true, title: true },
        })).map((s) => [s.id, s.title]),
      );
      await notifyMany(context.prisma, r.user_assignments.map((a) => ({
        identityId: a.user_id,
        kind: "unconf_assigned" as const,
        title: "You were assigned to a session",
        body: subTitles.get(a.submission_id) ?? null,
        ctaLabel: "Open schedule",
        ctaHref: "tab:me",
      })));
      return { kind: "unconference" as const, ...r };
    }
    if (slot.type === "mixer") {
      const r = await runMixerForSlot(context.prisma, context.conferenceId, input.slot_id);
      const roomNames = new Map<number, string>(
        (await context.prisma.room.findMany({
          where: { id: { in: r.room_assignments.map((a) => a.room_id) } },
          select: { id: true, name: true },
        })).map((rm) => [rm.id, rm.name]),
      );
      await notifyMany(context.prisma, r.room_assignments.map((a) => ({
        identityId: a.user_id,
        kind: "mixer_assigned" as const,
        title: "You were placed for a mixer",
        body: roomNames.get(a.room_id) ?? null,
        ctaLabel: "Open schedule",
        ctaHref: "tab:me",
      })));
      return { kind: "mixer" as const, ...r };
    }
    throw new ORPCError("BAD_REQUEST", { message: "not_an_assignable_slot" });
  }),

  myAssignments: requireConf("participant").agenda.myAssignments.handler(async ({ context }) => {
    const confId = context.conferenceId;
    const userId = actorIdentityId(context);
    const [assigns, placements, staticStars, mandatoryTracks, expertBookerBookings, ownExpert] = await Promise.all([
      context.prisma.userAssignment.findMany({
        where: { userId, slot: { conferenceId: confId } },
        include: {
          submission: { select: { title: true } },
          slot: { select: { id: true, type: true, startsAt: true, endsAt: true } },
          room: { select: { id: true, name: true } },
        },
      }),
      context.prisma.unconferencePlacement.findMany({
        where: { slot: { conferenceId: confId } },
      }),
      context.prisma.staticStar.findMany({
        where: { userId, track: { slot: { conferenceId: confId } } },
        include: {
          track: {
            include: {
              submission: { select: { title: true } },
              slot: { select: { startsAt: true, endsAt: true } },
            },
          },
        },
      }),
      // Mandatory static tracks are force-attended — fetch every mandatory
      // track in the conference and union with the user's own StaticStars,
      // deduplicated by track id.
      context.prisma.trackAssignment.findMany({
        where: { mandatory: true, slot: { conferenceId: confId } },
        include: {
          submission: { select: { title: true } },
          slot: { select: { startsAt: true, endsAt: true } },
        },
      }),
      // Bookings I made as the booker.
      context.prisma.expertBooking.findMany({
        where: { bookerId: userId, expert: { conferenceId: confId } },
        include: {
          expert: { include: { identity: { select: { name: true, email: true } } } },
        },
      }),
      // If this identity is promoted to expert in this conference, surface
      // every booking other people made against them too.
      context.prisma.expert.findUnique({
        where: { identityId: userId },
        include: {
          bookings: {
            include: { booker: { select: { name: true, email: true } } },
          },
        },
      }),
    ]);
    const placementBySubAndSlot = new Map<string, number>();
    for (const p of placements) {
      placementBySubAndSlot.set(`${p.slotId}:${p.submissionId}`, p.roomId);
    }
    const assignableSlots = await context.prisma.agendaSlot.findMany({
      where: { conferenceId: confId, type: { in: ["unconference", "mixer"] } },
      select: { id: true },
    });
    const myAssignedSlots = new Set(assigns.map((a) => a.slotId));
    const slotsWithAssignments = new Set([
      ...placements.map((p) => p.slotId),
      ...(await context.prisma.userAssignment.findMany({
        where: { slot: { conferenceId: confId, type: "mixer" } },
        select: { slotId: true }, distinct: ["slotId"],
      })).map((a) => a.slotId),
    ]);
    const unplaced_slots = assignableSlots
      .filter((s) => slotsWithAssignments.has(s.id) && !myAssignedSlots.has(s.id))
      .map((s) => s.id);

    // Bookings against this user as the expert are only surfaced when the
    // expert record is in *this* conference (Expert.identityId is globally
    // unique on a ConferenceIdentity, which is already conference-scoped, but
    // we still guard the include payload).
    const expertSelfBookings = (ownExpert && ownExpert.conferenceId === confId)
      ? ownExpert.bookings
      : [];

    return {
      assignments: [
        ...assigns.map((a) => ({
          source: a.slot.type === "mixer" ? "mixer" as const : "unconference" as const,
          slot_id: a.slotId,
          submission_id: a.submissionId,
          room_id: a.roomId
            ?? (a.submissionId
              ? placementBySubAndSlot.get(`${a.slotId}:${a.submissionId}`) ?? null
              : null),
          starts_at: a.slot.startsAt.getTime(),
          ends_at: a.slot.endsAt.getTime(),
          title: a.submission?.title
            ?? (a.slot.type === "mixer" ? a.room?.name ?? null : null),
          manual: a.manual,
        })),
        // Union of: (a) user-starred static tracks, (b) every mandatory static
        // track in the conference. Dedup by track id — a mandatory track the
        // user happens to have starred is still a single schedule row, but
        // surfaces with `mandatory: true` so the UI can render the badge and
        // hide the unstar action.
        ...(() => {
          const seen = new Set<number>();
          const rows: Array<{
            source: "static";
            slot_id: number;
            submission_id: number | null;
            room_id: number;
            starts_at: number;
            ends_at: number;
            title: string | null;
            manual: false;
            mandatory: boolean;
          }> = [];
          for (const s of staticStars) {
            if (seen.has(s.track.id)) continue;
            seen.add(s.track.id);
            rows.push({
              source: "static",
              slot_id: s.track.slotId,
              submission_id: s.track.submissionId,
              room_id: s.track.roomId,
              starts_at: s.track.slot.startsAt.getTime(),
              ends_at: s.track.slot.endsAt.getTime(),
              title: s.track.submission?.title ?? s.track.title ?? null,
              manual: false,
              mandatory: s.track.mandatory,
            });
          }
          for (const t of mandatoryTracks) {
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            rows.push({
              source: "static",
              slot_id: t.slotId,
              submission_id: t.submissionId,
              room_id: t.roomId,
              starts_at: t.slot.startsAt.getTime(),
              ends_at: t.slot.endsAt.getTime(),
              title: t.submission?.title ?? t.title ?? null,
              manual: false,
              mandatory: true,
            });
          }
          return rows;
        })(),
        ...expertBookerBookings.map((b) => ({
          source: "expert" as const,
          slot_id: null,
          submission_id: null,
          room_id: b.roomId,
          starts_at: b.startsAt.getTime(),
          ends_at: b.endsAt.getTime(),
          title: `Expert: ${b.expert.identity.name ?? b.expert.identity.email}`,
          manual: true,
          booking_id: b.id,
          expert_role: "booker" as const,
        })),
        ...expertSelfBookings.map((b) => ({
          source: "expert" as const,
          slot_id: null,
          submission_id: null,
          room_id: b.roomId,
          starts_at: b.startsAt.getTime(),
          ends_at: b.endsAt.getTime(),
          title: `Booked by ${b.booker.name ?? b.booker.email}`,
          manual: false,
          booking_id: b.id,
          expert_role: "expert" as const,
        })),
      ],
      unplaced_slots,
    };
  }),

  pickAssignment: requireConf("participant").agenda.pickAssignment.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
      select: { id: true, type: true },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    if (slot.type !== "unconference") {
      throw new ORPCError("BAD_REQUEST", { message: "not_an_unconference_slot" });
    }
    return context.prisma.$transaction(async (tx) => {
      const placement = await tx.unconferencePlacement.findFirst({
        where: { slotId: input.slot_id, submissionId: input.submission_id },
        select: { roomId: true, room: { select: { capacity: true } } },
      });
      if (!placement) throw new ORPCError("NOT_FOUND", { message: "not_placed" });
      const myIdentityId = actorIdentityId(context);
      const load = await tx.userAssignment.count({
        where: {
          slotId: input.slot_id, submissionId: input.submission_id,
          NOT: { userId: myIdentityId },
        },
      });
      if (load >= placement.room.capacity) {
        throw new ORPCError("CONFLICT", { message: "session_full" });
      }
      await tx.userAssignment.upsert({
        where: { slotId_userId: { slotId: input.slot_id, userId: myIdentityId } },
        create: {
          slotId: input.slot_id, userId: myIdentityId,
          submissionId: input.submission_id, roomId: placement.roomId, manual: true,
        },
        update: {
          submissionId: input.submission_id, roomId: placement.roomId, manual: true,
        },
      });
      return { ok: true as const };
    });
  }),

  unpickAssignment: requireConf("participant").agenda.unpickAssignment.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    await context.prisma.userAssignment.deleteMany({
      where: { slotId: input.slot_id, userId: actorIdentityId(context), manual: true },
    });
    return { ok: true as const };
  }),
};

// =========================================================================
// EXPERT BOOKINGS
// =========================================================================

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
      identity: { select: { id: true, name: true, email: true } },
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

const expertsRouter = {
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
        startsAt: new Date(input.starts_at),
        endsAt: new Date(input.ends_at),
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
      let frame: typeof candidateFrames[number] | null = null;
      let slotEnd = 0;
      for (const tf of candidateFrames) {
        const slots = deriveSlots(tf.startsAt, tf.endsAt, tf.slotDurationMinutes);
        const hit = slots.find((s) => s.startsAt === input.starts_at);
        if (hit) { frame = tf; slotEnd = hit.endsAt; break; }
      }
      if (!frame) throw new ORPCError("NOT_FOUND", { message: "slot_not_found" });
      if (input.starts_at <= Date.now()) {
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
          endsAt: { gt: new Date(input.starts_at) },
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
          endsAt: { gt: new Date(input.starts_at) },
        },
        select: { roomId: true, startsAt: true, endsAt: true },
      });
      const roomId = pickAvailableRoom(
        candidateRoomIds,
        conflictingRows.map((r) => ({
          roomId: r.roomId, startsAt: r.startsAt.getTime(), endsAt: r.endsAt.getTime(),
        })),
        { startsAt: input.starts_at, endsAt: slotEnd },
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
          startsAt: new Date(input.starts_at),
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

// =========================================================================
// NOTIFICATIONS
// =========================================================================

const notificationsRouter = {
  list: requireConf("participant").notifications.list.handler(async ({ context }) => {
    const identityId = actorIdentityId(context);
    const [items, unread] = await Promise.all([
      // Cap at 50 — the bell UI is for recent activity, not an archive. Older
      // notifications fall off; nothing references them.
      context.prisma.notification.findMany({
        where: { identityId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      context.prisma.notification.count({
        where: { identityId, readAt: null },
      }),
    ]);
    return {
      items: items.map((n) => ({
        id: n.id,
        kind: n.kind as
          | "submission_published" | "submission_rejected" | "submission_received"
          | "unconf_assigned" | "mixer_assigned"
          | "expert_booked" | "expert_booking_cancelled",
        title: n.title,
        body: n.body,
        cta_label: n.ctaLabel,
        cta_href: n.ctaHref,
        read_at: n.readAt ? n.readAt.getTime() : null,
        created_at: n.createdAt.getTime(),
      })),
      unread_count: unread,
    };
  }),

  markRead: requireConf("participant").notifications.markRead.handler(async ({ input, context }) => {
    const identityId = actorIdentityId(context);
    // updateMany so a stale id (already deleted, or owned by another identity)
    // is a silent no-op instead of throwing.
    await context.prisma.notification.updateMany({
      where: { id: input.id, identityId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true as const };
  }),

  markAllRead: requireConf("participant").notifications.markAllRead.handler(async ({ context }) => {
    const identityId = actorIdentityId(context);
    await context.prisma.notification.updateMany({
      where: { identityId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true as const };
  }),
};

// =========================================================================
// ROUTER
// =========================================================================

export function buildRouter() {
  return base.router({
    auth: authRouter,
    conferences: conferenceRouter,
    rooms: roomsRouter,
    submissions: submissionsRouter,
    agenda: agendaRouter,
    experts: expertsRouter,
    notifications: notificationsRouter,
  });
}

export type AppRouter = ReturnType<typeof buildRouter>;

// Hono adapter — call from a `app.all("/api/*", ...)` route. Returns null
// when oRPC didn't match (so the caller can hand off to other Hono routes).
export async function handleRpc(
  prisma: PrismaClient,
  req: Request,
): Promise<Response | null> {
  const handler = new RPCHandler(buildRouter());
  const responseHeaders = new Headers();
  const { matched, response } = await handler.handle(req, {
    prefix: "/api",
    context: { prisma, req, responseHeaders },
  });
  if (!matched) return null;
  // Splice any Set-Cookie headers the procedures wrote (login/logout/etc).
  for (const [k, v] of responseHeaders) response.headers.append(k, v);
  return response;
}
