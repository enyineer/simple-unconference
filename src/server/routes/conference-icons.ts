// HTTP conference-icon pipeline (per-conference PWA install icon). Lives
// outside oRPC because:
//   - GET returns binary (image/png), not JSON.
//   - POST takes multipart/form-data, which the oRPC contract doesn't model.
//
// URL shape (the client + the web app manifest build these EXACT paths):
//   GET  /api/conference-icons/:slug/:size            - current bytes, short cache
//   GET  /api/conference-icons/:slug/:size/:hash      - current bytes, cache-keyed
//   POST /api/conference-icons/:slug/upload           - multipart upload (owner)
// where :size is 192 or 512.
//
// The GET route NEVER 404s: with no custom icon (or a hashless request) it
// serves the built-in default icon bytes, so the manifest icon always resolves.
// Cache-Control mirrors the avatar pipeline: a hashed URL matching the current
// iconHash is immutable-cacheable; a stale/hashless URL is short-lived.
//
// Icons are conference BRANDING, so upload is OWNER-only (not mods), matching
// the other owner-gated conference settings.

import { Hono } from "hono";
import type { Context } from "hono";
import type { PrismaClient } from "@prisma/client";
import { resolveConferencePrincipal } from "../lib/permissions";
import {
  ICON_SIZES,
  type IconSize,
  writeConferenceIcon,
  readConferenceIcon,
  defaultIconBytes,
} from "../lib/conference-icons";

const ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const MAX_BYTES = 5 * 1024 * 1024;

function parseSize(raw: string | undefined): IconSize | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return ICON_SIZES.find((s) => s === n) ?? null;
}

export function conferenceIconRoutes(prisma: PrismaClient) {
  const app = new Hono();

  // Hashless GET: current bytes with a short cache (the client should prefer
  // the hashed route for aggressive caching once it knows the hash).
  app.get("/:confSlug/:sizeStr", async (c) => {
    return await serveIcon(c, prisma, null);
  });

  // Hashed GET: cache-keyed by the URL. Match -> immutable. Stale -> no-store.
  app.get("/:confSlug/:sizeStr/:hash", async (c) => {
    return await serveIcon(c, prisma, c.req.param("hash"));
  });

  // POST /:confSlug/upload  (multipart: file=<binary>) — OWNER-only.
  app.post("/:confSlug/upload", async (c) => {
    const confSlug = c.req.param("confSlug");
    const conf = await prisma.conference.findUnique({
      where: { slug: confSlug },
      select: { id: true },
    });
    if (!conf) return c.notFound();

    const principal = await resolveConferencePrincipal(prisma, c.req.raw, conf.id);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    // Icons are conference branding — owner-only, like the other owner-gated
    // settings (board link, join link, design system).
    if (principal.role !== "owner") return c.json({ error: "forbidden" }, 403);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "bad_form" }, 400);
    }

    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "no_file", field: "file" }, 400);

    // SVG is intentionally excluded — it can carry script payloads. Anything
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
      stored = await writeConferenceIcon(conf.id, buf);
    } catch {
      // sharp throws on unrecognized / malformed image data. Surface as 400 —
      // the bytes failed validation, not the server.
      return c.json({ error: "bad_image", field: "file" }, 400);
    }

    await prisma.conference.update({
      where: { id: conf.id },
      data: { iconPath: stored.path, iconHash: stored.hash },
    });

    // Return the new hash so the client can compose the cacheable URL (and
    // update the live manifest/apple-touch-icon links) without a round trip.
    return c.json({ ok: true, hash: stored.hash });
  });

  return app;
}

// Shared GET handler. Serves the conference's custom icon at the requested size
// when one is stored, else the built-in default — never a 404, so the manifest
// icon always resolves. `urlHash` governs cache headers only.
async function serveIcon(
  c: Context,
  prisma: PrismaClient,
  urlHash: string | null,
): Promise<Response> {
  const size = parseSize(c.req.param("sizeStr"));
  if (size === null) return c.notFound();

  const conf = await prisma.conference.findUnique({
    where: { slug: c.req.param("confSlug") },
    select: { id: true, iconPath: true, iconHash: true },
  });

  // Default-icon fallbacks (unknown conference, no custom icon, or file missing
  // on disk) all return the built-in bytes with a short public cache. They're
  // static assets, so they're safe to share and cheap to refetch.
  const serveDefault = (): Response =>
    new Response(new Uint8Array(defaultIconBytes(size)), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600",
      },
    });

  if (!conf || !conf.iconPath || !conf.iconHash) return serveDefault();

  const bytes = readConferenceIcon(conf.id, size);
  if (!bytes) return serveDefault();

  // Caching:
  //   - Hashed URL + matches current -> immutable forever (CDN-cacheable)
  //   - Hashed URL + stale -> no-store (the URL is no longer canonical)
  //   - Hashless URL -> short public cache
  let cacheControl: string;
  if (urlHash !== null) {
    cacheControl = urlHash === conf.iconHash
      ? "public, max-age=31536000, immutable"
      : "no-store";
  } else {
    cacheControl = "public, max-age=3600";
  }

  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": "image/png", "cache-control": cacheControl },
  });
}
