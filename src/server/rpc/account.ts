// Cross-conference account linking (account-linking Phase 4).
//
// A verified global account can link the per-conference identities that share
// its email, so one global login resolves into every linked conference (see
// the linked-identity branch in resolveConferencePrincipal). Linking always
// proves control of the conference side via that identity's own password -
// email match alone is never enough. Discovery + listings are strictly
// self-scoped: linkedUserId and verification state never leak to anyone else.

import { ORPCError } from "@orpc/server";
import { verified } from "./shared";
import { verifyPassword } from "../auth";
import { assertLoginAllowed, recordLoginFailure, recordLoginSuccess } from "../lib/limits";

type Row = {
  role: "moderator" | "participant";
  conference: { slug: string; name: string };
};
function toLinkable(r: Row) {
  return { slug: r.conference.slug, name: r.conference.name, role: r.role };
}

export const accountRouter = {
  // Password-bearing identities matching the caller's email that aren't linked
  // yet. Owner-minted identities (null password) are excluded by construction,
  // so an owner never sees their own conference offered as "linkable".
  discoverLinkable: verified.account.discoverLinkable.handler(async ({ context }) => {
    const rows = await context.prisma.conferenceIdentity.findMany({
      where: { email: context.user.email, linkedUserId: null, passwordHash: { not: null } },
      select: { role: true, conference: { select: { slug: true, name: true } } },
      orderBy: { conference: { name: "asc" } },
    });
    return rows.map(toLinkable);
  }),

  // Conferences already linked to this account (password-bearing identities
  // only, so owner-minted rows that the backfill linked don't show up here -
  // they appear under the owner's own conference list instead).
  listLinked: verified.account.listLinked.handler(async ({ context }) => {
    const rows = await context.prisma.conferenceIdentity.findMany({
      where: { linkedUserId: context.user.id, passwordHash: { not: null } },
      select: { role: true, conference: { select: { slug: true, name: true } } },
      orderBy: { conference: { name: "asc" } },
    });
    return rows.map(toLinkable);
  }),

  linkConferenceIdentity: verified.account.linkConferenceIdentity.handler(async ({ input, context }) => {
    const conf = await context.prisma.conference.findUnique({
      where: { slug: input.slug }, select: { id: true, name: true },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });

    // Reuse the per-conference login lockout so password guessing here is
    // throttled exactly like a conference login (NAT-blind, per email).
    const lockoutKey = `conf:${input.slug}:${context.user.email}`;
    assertLoginAllowed(lockoutKey);

    const identity = await context.prisma.conferenceIdentity.findUnique({
      where: { conferenceId_email: { conferenceId: conf.id, email: context.user.email } },
    });
    if (!identity || !identity.passwordHash
        || !(await verifyPassword(input.password, identity.passwordHash))) {
      recordLoginFailure(lockoutKey);
      throw new ORPCError("UNAUTHORIZED", { message: "invalid_credentials" });
    }
    recordLoginSuccess(lockoutKey);

    // Idempotent if already linked to this account; refuse if linked elsewhere.
    if (identity.linkedUserId !== null && identity.linkedUserId !== context.user.id) {
      throw new ORPCError("CONFLICT", { message: "already_linked" });
    }
    if (identity.linkedUserId === null) {
      await context.prisma.conferenceIdentity.update({
        where: { id: identity.id },
        data: { linkedUserId: context.user.id },
      });
    }
    return { slug: input.slug, name: conf.name, role: identity.role };
  }),

  unlinkConferenceIdentity: verified.account.unlinkConferenceIdentity.handler(async ({ input, context }) => {
    const conf = await context.prisma.conference.findUnique({
      where: { slug: input.slug }, select: { id: true },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });
    // Only this account's own link is cleared. The identity keeps its password,
    // so the user can still sign in to the conference directly afterwards (no
    // stranding - the link flow never creates password-less identities).
    await context.prisma.conferenceIdentity.updateMany({
      where: { conferenceId: conf.id, linkedUserId: context.user.id },
      data: { linkedUserId: null },
    });
    return { ok: true as const };
  }),
};
