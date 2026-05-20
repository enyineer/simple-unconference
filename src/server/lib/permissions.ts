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

// Idempotent: returns the existing owner-linked identity row, or creates one.
// Role on the row is participant; the owner's effective role comes from the
// Conference.ownerId check, not from this field.
async function ensureOwnerIdentity(
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
