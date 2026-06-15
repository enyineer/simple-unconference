// Resolves who is calling for a given conference and gates by role.
//
// Two principal kinds:
//   - owner: holds the global cookie and matches `Conference.ownerId`. Auto-
//     mints a ConferenceIdentity on first resolution so the owner can submit
//     talks, star, and get assigned alongside everyone else.
//   - identity: a ConferenceIdentity row authenticated via the per-conference
//     cookie `uncon_session_<confId>`. Role comes from `ConferenceIdentity.role`.

import type { ConferenceIdentity, IdentityRole, PrismaClient, User } from "@prisma/client";
import { principalFromRequest } from "../auth";

export type Role = "owner" | IdentityRole;

const RANK: Record<Role, number> = { participant: 1, moderator: 2, owner: 3 };

export function hasRoleAtLeast(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export type ResolvedPrincipal =
  | { kind: "owner"; user: User; identity: ConferenceIdentity; role: "owner" }
  | { kind: "identity"; identity: ConferenceIdentity; role: IdentityRole };

export async function resolveConferencePrincipal(
  prisma: PrismaClient,
  req: Request,
  conferenceId: number,
): Promise<ResolvedPrincipal | null> {
  const conf = await prisma.conference.findUnique({
    where: { id: conferenceId },
    select: { id: true, ownerId: true },
  });
  if (!conf) return null;

  // Owner cookie wins when it matches the conference's owner record.
  const ownerPrincipal = await principalFromRequest(prisma, req, { type: "owner" });
  if (ownerPrincipal && ownerPrincipal.kind === "owner" && ownerPrincipal.user.id === conf.ownerId) {
    const identity = await ensureOwnerIdentity(prisma, conferenceId, ownerPrincipal.user);
    return { kind: "owner", user: ownerPrincipal.user, identity, role: "owner" };
  }

  // Linked global account: the global cookie belongs to a user who has linked
  // an identity in THIS conference (and isn't its owner). Act AS that identity
  // with its conference role. This is the payoff of account-linking - one
  // global login steps into every conference the user has explicitly linked,
  // with no per-conference password. Mirrors the owner path (global cookie ->
  // derived identity).
  if (ownerPrincipal && ownerPrincipal.kind === "owner") {
    const linked = await prisma.conferenceIdentity.findFirst({
      where: { conferenceId, linkedUserId: ownerPrincipal.user.id },
    });
    if (linked) return { kind: "identity", identity: linked, role: linked.role };
  }

  // Otherwise look for a per-conference identity session.
  const identityPrincipal = await principalFromRequest(prisma, req, {
    type: "conference",
    conferenceId,
  });
  if (identityPrincipal && identityPrincipal.kind === "identity") {
    return {
      kind: "identity",
      identity: identityPrincipal.identity,
      role: identityPrincipal.identity.role,
    };
  }

  return null;
}

// Eligibility result for chat between two identities in a conference. See
// plans/chat.md Phase 0 for the full rule set. Reasons are ordered from
// least to most "exists"-revealing — non-mod callers should map `not_published`
// and `self` to NOT_FOUND (so an unpublished target can't be probed for
// existence) and `chat_disabled` / `banned` / `blocked` to FORBIDDEN.
export type ChatEligibility =
  | { ok: true }
  | { ok: false; reason: "self" | "not_published" | "chat_disabled" | "banned" | "blocked" };

export async function canChatWith(args: {
  prisma: PrismaClient;
  viewer: ResolvedPrincipal;
  targetIdentityId: number;
  conferenceId: number;
}): Promise<ChatEligibility> {
  const { prisma, viewer, targetIdentityId, conferenceId } = args;
  if (viewer.identity.id === targetIdentityId) return { ok: false, reason: "self" };

  const target = await prisma.conferenceIdentity.findFirst({
    where: { id: targetIdentityId, conferenceId },
    select: {
      id: true,
      profilePublished: true,
      chatEnabled: true,
      chatBannedAt: true,
    },
  });
  // Target missing or in a different conference — caller decides whether to
  // surface as NOT_FOUND vs FORBIDDEN. We just report "not_published" so the
  // status code never distinguishes "doesn't exist" from "exists but hidden".
  if (!target) return { ok: false, reason: "not_published" };

  const isMod = viewer.role === "owner" || viewer.role === "moderator";

  // Viewer side: own ban or chat-disabled blocks even mods (you can't send
  // while banned). The own-chat-disabled check is symmetric — disabling chat
  // disables both directions.
  if (viewer.identity.chatBannedAt) return { ok: false, reason: "banned" };
  if (!viewer.identity.chatEnabled) return { ok: false, reason: "chat_disabled" };

  // Target side. Mods bypass the published check so they can DM unpublished
  // users for moderation outreach. Bans + the target's own chat-disabled
  // toggle still apply.
  if (!isMod && !target.profilePublished) return { ok: false, reason: "not_published" };
  if (target.chatBannedAt) return { ok: false, reason: "banned" };
  if (!target.chatEnabled) return { ok: false, reason: "chat_disabled" };

  // Blocks: either direction kills it. Use composite-PK lookup.
  const block = await prisma.chatBlock.findFirst({
    where: {
      OR: [
        { blockerIdentityId: viewer.identity.id, blockedIdentityId: target.id },
        { blockerIdentityId: target.id, blockedIdentityId: viewer.identity.id },
      ],
    },
    select: { blockerIdentityId: true },
  });
  if (block) return { ok: false, reason: "blocked" };

  return { ok: true };
}

// Idempotent: returns the existing owner-linked identity row, or creates one.
// Role on the row is participant; the owner's effective role comes from the
// Conference.ownerId check, not from this field.
export async function ensureOwnerIdentity(
  prisma: PrismaClient,
  conferenceId: number,
  user: User,
): Promise<ConferenceIdentity> {
  const existing = await prisma.conferenceIdentity.findUnique({
    where: { conferenceId_email: { conferenceId, email: user.email } },
  });
  if (existing) {
    if (existing.ownerUserId !== user.id) {
      return prisma.conferenceIdentity.update({
        where: { id: existing.id },
        data: { ownerUserId: user.id },
      });
    }
    return existing;
  }
  return prisma.conferenceIdentity.create({
    data: {
      conferenceId,
      email: user.email,
      name: user.name,
      passwordHash: null,
      role: "participant",
      ownerUserId: user.id,
      claimedAt: new Date(),
    },
  });
}
