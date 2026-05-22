// HTTP avatar pipeline. Lives outside oRPC because:
//   - GET returns binary (image/webp) or image/svg+xml, not JSON.
//   - POST takes multipart/form-data, which the oRPC contract doesn't model.
//
// URL shape:
//   GET /api/avatars/:slug/:identityId            - SVG fallback (no avatar)
//   GET /api/avatars/:slug/:identityId/:hash      - real bytes, cache-keyed
//   POST /api/avatars/:slug/upload                - multipart upload
//
// Caching strategy (Cloudflare-friendly):
//   - Published profile + URL hash matches current ->
//       public, max-age=31536000, immutable
//   - Published profile + URL hash is stale (caller has an old version) ->
//       no-store (the URL no longer maps to current content; forces a
//       fresh fetch via the profile API to pick up the new hash).
//   - Unpublished profile + viewer is mod/self ->
//       private, max-age=300 (user-private; CDN won't cache).
//   - Existence-leak SVG (unpublished + non-mod/non-self) ->
//       no-store (response depends on auth state; never share it).
//   - Visible-but-no-file SVG (initials) ->
//       public, max-age=300 (initials only depend on name + identityId).
//
// Privacy contract (kept in lock-step with `profiles.get`):
//   - Unpublished profiles viewed by non-mod, non-self callers always return
//     the initials SVG with name=null so the route can't leak the identity's
//     name. Status code is always 200 (never 404) for existing identities so
//     visibility can't be probed by status.

import { Hono } from "hono";
import type { Context } from "hono";
import type { PrismaClient } from "@prisma/client";
import { resolveConferencePrincipal } from "../lib/permissions";
import {
  avatarPathFor,
  initialsSvg,
  readAvatar,
  writeAvatar,
} from "../lib/avatars";

const ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const MAX_BYTES = 5 * 1024 * 1024;

export function avatarRoutes(prisma: PrismaClient) {
  const app = new Hono();

  // Hashless GET: only returns the SVG fallback. Clients that have an avatar
  // hash from the profile API should use the hashed route for aggressive
  // caching; this route is the placeholder for "no avatar yet" callers.
  app.get("/:confSlug/:identityIdStr", async (c) => {
    return await serveAvatar(c, prisma, null);
  });

  // Hashed GET: cache-keyed by the URL. Match -> immutable. Stale -> no-store.
  app.get("/:confSlug/:identityIdStr/:hash", async (c) => {
    const hash = c.req.param("hash");
    return await serveAvatar(c, prisma, hash);
  });

  // POST /:confSlug/upload  (multipart: file=<binary>, identity_id?=<number>)
  // Self-uploads any time; mod+ can target another identity in the same conf.
  app.post("/:confSlug/upload", async (c) => {
    const confSlug = c.req.param("confSlug");
    const conf = await prisma.conference.findUnique({
      where: { slug: confSlug },
      select: { id: true },
    });
    if (!conf) return c.notFound();

    const principal = await resolveConferencePrincipal(prisma, c.req.raw, conf.id);
    if (!principal) return c.json({ error: "unauthorized" }, 401);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "bad_form" }, 400);
    }

    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "no_file", field: "file" }, 400);

    // Resolve target identity. `identity_id` form field is optional; absent
    // means "edit my own avatar". Mods can pass it explicitly to edit others.
    const targetRaw = form.get("identity_id");
    let targetId: number;
    if (targetRaw == null || targetRaw === "") {
      targetId = principal.identity.id;
    } else if (typeof targetRaw === "string") {
      const parsed = Number(targetRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return c.json({ error: "bad_identity_id", field: "identity_id" }, 400);
      }
      targetId = parsed;
    } else {
      return c.json({ error: "bad_identity_id", field: "identity_id" }, 400);
    }

    const isMod = principal.role === "owner" || principal.role === "moderator";
    const isMe = principal.identity.id === targetId;
    if (!isMe && !isMod) return c.json({ error: "forbidden" }, 403);

    // Cross-conference safety: the target identity must belong to this conf.
    const target = await prisma.conferenceIdentity.findFirst({
      where: { id: targetId, conferenceId: conf.id },
      select: { id: true },
    });
    if (!target) return c.json({ error: "not_found" }, 404);

    // SVG is intentionally excluded -- it can carry script payloads. Anything
    // outside the rasterized whitelist gets rejected before touching sharp.
    if (!ALLOWED_MIME.has(file.type)) {
      return c.json({ error: "bad_mime", field: "file" }, 400);
    }
    if (file.size > MAX_BYTES) {
      return c.json({ error: "too_large", field: "file" }, 400);
    }

    const buf = await file.arrayBuffer();
    let stored: { path: string; hash: string };
    try {
      stored = await writeAvatar(conf.id, target.id, buf);
    } catch {
      // sharp throws on unrecognized / malformed image data. Surface as 400
      // -- the bytes failed validation, not the server.
      return c.json({ error: "bad_image", field: "file" }, 400);
    }

    await prisma.conferenceIdentity.update({
      where: { id: target.id },
      data: { avatarPath: stored.path, avatarHash: stored.hash },
    });

    // Return the new hash so the client can compose the cacheable URL
    // immediately, without an extra round trip to `profiles.get`.
    return c.json({ ok: true, hash: stored.hash });
  });

  return app;
}

// Shared GET handler. `urlHash` is the segment the caller had in the URL (or
// null for the hashless route). The handler always serves *current* bytes; the
// hash only governs cache headers.
async function serveAvatar(
  c: Context,
  prisma: PrismaClient,
  urlHash: string | null,
): Promise<Response> {
  const confSlug = c.req.param("confSlug");
  const identityIdStr = c.req.param("identityIdStr");
  const identityId = Number(identityIdStr);
  if (!Number.isInteger(identityId) || identityId <= 0) {
    return c.notFound();
  }
  const conf = await prisma.conference.findUnique({
    where: { slug: confSlug },
    select: { id: true },
  });
  if (!conf) return c.notFound();

  const ident = await prisma.conferenceIdentity.findFirst({
    where: { id: identityId, conferenceId: conf.id },
    select: {
      id: true,
      name: true,
      avatarPath: true,
      avatarHash: true,
      profilePublished: true,
    },
  });
  if (!ident) return c.notFound();

  // For published profiles, the avatar bytes are public. Skip the principal
  // lookup so Cloudflare can serve cache hits without ever hitting the origin.
  // For unpublished profiles we need to know who's asking.
  let isMod = false;
  let isMe = false;
  if (!ident.profilePublished) {
    const principal = await resolveConferencePrincipal(prisma, c.req.raw, conf.id);
    isMod = principal?.role === "owner" || principal?.role === "moderator";
    isMe = principal?.identity.id === ident.id;
  }
  const visible = ident.profilePublished || isMod || isMe;

  if (!visible) {
    // Existence-leak guard: generic SVG with NO name. Never cache shared.
    return new Response(initialsSvg(null, ident.id), {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  // No avatar file at all -> initials SVG. Public-cacheable since the output
  // is just a function of (name, identityId).
  if (!ident.avatarPath || !ident.avatarHash) {
    const bytes = ident.avatarPath ? readAvatar(conf.id, ident.id) : null;
    if (!bytes) {
      return new Response(initialsSvg(ident.name, ident.id), {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }
    // Path is set but hash isn't -- legacy row written before this column
    // existed. Serve the bytes but skip aggressive caching until next upload
    // populates the hash.
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "image/webp",
        "cache-control": ident.profilePublished
          ? "public, max-age=60, must-revalidate"
          : "private, max-age=60",
      },
    });
  }

  const bytes = readAvatar(conf.id, ident.id);
  if (!bytes) {
    // File missing despite avatarPath being set. Fall back to SVG.
    return new Response(initialsSvg(ident.name, ident.id), {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });
  }

  // Caching:
  //   - Hashed URL + matches current -> immutable forever (Cloudflare-cacheable)
  //   - Hashed URL + stale -> no-store (the URL is no longer canonical)
  //   - Hashless URL -> private/public short cache depending on publish state
  let cacheControl: string;
  if (urlHash !== null) {
    if (urlHash === ident.avatarHash) {
      cacheControl = ident.profilePublished
        ? "public, max-age=31536000, immutable"
        : "private, max-age=300";
    } else {
      cacheControl = "no-store";
    }
  } else {
    cacheControl = ident.profilePublished
      ? "public, max-age=60, must-revalidate"
      : "private, max-age=60";
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/webp",
      "cache-control": cacheControl,
    },
  });
}

// Re-export internal helpers for tests that want to assert on disk paths.
export const __avatarTestExports = { avatarPathFor };
