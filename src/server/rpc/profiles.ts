import { ORPCError } from "@orpc/server";
import type { PrismaClient, Prisma } from "@prisma/client";
import { requireConf, actorIdentityId, pageOf, parsePageInput } from "./shared";
// Renamed at import to avoid shadowing the `profiles.deleteAvatar` handler key.
import { deleteAvatar as deleteAvatarFile } from "../lib/avatars";

// Maps the principal's effective role to the wire-level role label used in
// `ProfileOut.role`. Mirrors the resolution in `toConfMeOut`: owner-linked
// identities always report "owner" regardless of the row's IdentityRole.
function profileRoleFor(
  ident: { role: "moderator" | "participant"; ownerUserId: number | null },
): "owner" | "moderator" | "participant" {
  return ident.ownerUserId !== null ? "owner" : ident.role;
}

// Builds the on-the-wire `ProfileOut` for the given identity, applying the
// per-viewer field stripping rules:
//   - non-mod, non-self viewers see only `isPublic=true` entries.
//   - `email` is null for non-mod, non-self viewers (canonical email never
//     leaks; public contact email lives in a ProfileEntry row).
//   - `profile_completion_dismissed` is only meaningful for the viewer's
//     own profile; it's always false for everyone else's payload.
async function buildProfileOut(
  prisma: PrismaClient,
  conferenceId: number,
  identityId: number,
  viewerIdentityId: number,
  isMod: boolean,
): Promise<{
  identity_id: number;
  conference_id: number;
  name: string | null;
  email: string | null;
  role: "owner" | "moderator" | "participant";
  profile_published: boolean;
  bio: string | null;
  pronouns: string | null;
  title: string | null;
  company: string | null;
  avatar_hash: string | null;
  entries: {
    id: number; kind: string; value: string; href: string | null;
    category: "link" | "contact"; is_public: boolean; position: number;
  }[];
  tags: string[];
  is_expert: boolean;
  is_me: boolean;
  can_edit: boolean;
  profile_completion_dismissed: boolean;
}> {
  const ident = await prisma.conferenceIdentity.findFirst({
    where: { id: identityId, conferenceId },
    include: {
      profileEntries: { orderBy: [{ position: "asc" }, { id: "asc" }] },
      profileTags: { orderBy: { tag: "asc" } },
      expertProfile: { select: { id: true } },
    },
  });
  if (!ident) throw new ORPCError("NOT_FOUND");
  const isMe = ident.id === viewerIdentityId;
  const entries = ident.profileEntries
    .filter((e) => isMod || isMe || e.isPublic)
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      value: e.value,
      href: e.href,
      category: e.category,
      is_public: e.isPublic,
      position: e.position,
    }));
  return {
    identity_id: ident.id,
    conference_id: ident.conferenceId,
    name: ident.name,
    email: isMod || isMe ? ident.email : null,
    role: profileRoleFor(ident),
    profile_published: ident.profilePublished,
    bio: ident.bio,
    pronouns: ident.pronouns,
    title: ident.title,
    company: ident.company,
    avatar_hash: ident.avatarHash,
    entries,
    tags: ident.profileTags.map((t) => t.tag),
    is_expert: ident.expertProfile !== null,
    is_me: isMe,
    can_edit: isMe || isMod,
    profile_completion_dismissed: isMe ? ident.profileCompletionDismissed : false,
  };
}

// Shared mutation helper. Touches only the keys present in `input` (scalar
// fields on ConferenceIdentity), and replaces entries/tags wholesale when
// those arrays are provided. Caller must have already verified the target
// identity belongs to `conferenceId`.
async function applyProfileUpdate(
  prisma: PrismaClient,
  identityId: number,
  input: {
    profile_published?: boolean;
    bio?: string | null;
    pronouns?: string | null;
    title?: string | null;
    company?: string | null;
    profile_completion_dismissed?: boolean;
    entries?: {
      kind: string; value: string; href?: string | null;
      category: "link" | "contact"; is_public: boolean; position: number;
    }[];
    tags?: string[];
  },
): Promise<void> {
  // Build the scalar patch from keys explicitly present in input. We mirror
  // valibot's `optional()` semantics: an omitted key means "leave it alone".
  // A key with value `null` clears the column.
  const data: Prisma.ConferenceIdentityUpdateInput = {};
  if (Object.hasOwn(input, "profile_published") && input.profile_published !== undefined) {
    data.profilePublished = input.profile_published;
  }
  if (Object.hasOwn(input, "bio")) data.bio = input.bio ?? null;
  if (Object.hasOwn(input, "pronouns")) data.pronouns = input.pronouns ?? null;
  if (Object.hasOwn(input, "title")) data.title = input.title ?? null;
  if (Object.hasOwn(input, "company")) data.company = input.company ?? null;
  if (
    Object.hasOwn(input, "profile_completion_dismissed")
    && input.profile_completion_dismissed !== undefined
  ) {
    data.profileCompletionDismissed = input.profile_completion_dismissed;
  }

  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.conferenceIdentity.update({ where: { id: identityId }, data });
    }
    if (input.entries !== undefined) {
      await tx.profileEntry.deleteMany({ where: { identityId } });
      if (input.entries.length > 0) {
        await tx.profileEntry.createMany({
          data: input.entries.map((e) => ({
            identityId,
            kind: e.kind,
            value: e.value,
            href: e.href ?? null,
            category: e.category,
            isPublic: e.is_public,
            position: e.position,
          })),
        });
      }
    }
    if (input.tags !== undefined) {
      await tx.profileTag.deleteMany({ where: { identityId } });
      // Dedup verbatim — schema already caps at 20 and 48 chars per tag.
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const t of input.tags) {
        if (seen.has(t)) continue;
        seen.add(t);
        unique.push(t);
      }
      if (unique.length > 0) {
        await tx.profileTag.createMany({
          data: unique.map((tag) => ({ identityId, tag })),
        });
      }
    }
  });
}

export const profilesRouter = {
  get: requireConf("participant").profiles.get.handler(async ({ input, context }) => {
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    const viewerIdentityId = actorIdentityId(context);
    // Cross-conference safety: only consider identities in this conference.
    // Pre-fetch publish state so we can NOT_FOUND non-visible profiles before
    // building the full payload.
    const ident = await context.prisma.conferenceIdentity.findFirst({
      where: { id: input.identity_id, conferenceId: context.conferenceId },
      select: { id: true, profilePublished: true },
    });
    if (!ident) throw new ORPCError("NOT_FOUND");
    const isMe = ident.id === viewerIdentityId;
    if (!ident.profilePublished && !isMod && !isMe) {
      throw new ORPCError("NOT_FOUND");
    }
    return buildProfileOut(
      context.prisma, context.conferenceId, ident.id, viewerIdentityId, isMod,
    );
  }),

  list: requireConf("participant").profiles.list.handler(async ({ input, context }) => {
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    const { offset, limit, q } = parsePageInput(input);
    const queryFilters: Prisma.ConferenceIdentityWhereInput[] = [];
    if (q) {
      queryFilters.push({
        OR: [
          { name: { contains: q } },
          { title: { contains: q } },
          { company: { contains: q } },
          { profileTags: { some: { tag: { contains: q } } } },
        ],
      });
    }
    if (input.tag) {
      queryFilters.push({ profileTags: { some: { tag: input.tag } } });
    }
    const where: Prisma.ConferenceIdentityWhereInput = {
      conferenceId: context.conferenceId,
      ...(isMod ? {} : { profilePublished: true }),
      ...(queryFilters.length > 0 ? { AND: queryFilters } : {}),
    };
    const [total, rows] = await Promise.all([
      context.prisma.conferenceIdentity.count({ where }),
      context.prisma.conferenceIdentity.findMany({
        where,
        include: {
          profileTags: { orderBy: { tag: "asc" } },
          expertProfile: { select: { id: true } },
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        skip: offset,
        take: limit,
      }),
    ]);
    const items = rows.map((r) => ({
      identity_id: r.id,
      name: r.name,
      title: r.title,
      company: r.company,
      pronouns: r.pronouns,
      avatar_hash: r.avatarHash,
      tags: r.profileTags.map((t) => t.tag),
      is_expert: r.expertProfile !== null,
    }));
    return pageOf(items, offset, limit, total);
  }),

  updateMine: requireConf("participant").profiles.updateMine.handler(async ({ input, context }) => {
    const viewerIdentityId = actorIdentityId(context);
    // Sanity check: the actor's identity row must belong to this conference.
    // (Always true in practice — the middleware resolves the principal scoped
    // to the conference — but the explicit lookup keeps the contract honest
    // for owner-linked identities and future changes.)
    const ident = await context.prisma.conferenceIdentity.findFirst({
      where: { id: viewerIdentityId, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!ident) throw new ORPCError("NOT_FOUND");
    await applyProfileUpdate(context.prisma, ident.id, input);
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    return buildProfileOut(
      context.prisma, context.conferenceId, ident.id, viewerIdentityId, isMod,
    );
  }),

  updateAny: requireConf("moderator").profiles.updateAny.handler(async ({ input, context }) => {
    const target = await context.prisma.conferenceIdentity.findFirst({
      where: { id: input.identity_id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND");
    await applyProfileUpdate(context.prisma, target.id, input);
    const viewerIdentityId = actorIdentityId(context);
    // Mods always see everything in the response payload.
    return buildProfileOut(
      context.prisma, context.conferenceId, target.id, viewerIdentityId, true,
    );
  }),

  // Clears the avatar reference for the target identity AND best-effort
  // removes the on-disk .webp. Ordering: file unlink first, then null both
  // DB columns. If the unlink fails (file already gone, permission error,
  // etc.) we swallow and proceed to update the DB anyway -- the DB columns
  // are the source of truth for "has an avatar"; leaving a dangling file is
  // strictly less bad than leaving a dangling DB pointer.
  deleteAvatar: requireConf("participant").profiles.deleteAvatar.handler(async ({ input, context }) => {
    const viewerIdentityId = actorIdentityId(context);
    const isMod = context.principal.role === "owner" || context.principal.role === "moderator";
    const targetId = input.identity_id ?? viewerIdentityId;
    if (targetId !== viewerIdentityId && !isMod) throw new ORPCError("FORBIDDEN");
    const target = await context.prisma.conferenceIdentity.findFirst({
      where: { id: targetId, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND");
    try {
      deleteAvatarFile(context.conferenceId, target.id);
    } catch {
      // Best-effort: a missing file or permission glitch shouldn't block
      // the DB cleanup. The next upload will overwrite anyway.
    }
    await context.prisma.conferenceIdentity.update({
      where: { id: target.id },
      data: { avatarPath: null, avatarHash: null },
    });
    return { ok: true as const };
  }),
};
