// Per-conference web app manifest (PWA install). Mounted under /api (so the
// Vite dev proxy forwards it) BEFORE the oRPC catch-all — it returns
// application/manifest+json, which doesn't fit the oRPC contract.
//
//   GET /api/manifest/:slug.webmanifest
//
// Each conference is a DISTINCT installable app: a stable per-conference `id`
// lets multiple installs coexist, and `start_url` deep-links into the
// conference so the installed icon opens straight into it. Icons point at the
// owner's custom conference icon (hash-cache-busted) when set, else the
// built-in defaults. Paths are root-relative so they resolve against the origin
// regardless of the manifest's own URL. Unknown slug -> 404.

import { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";

// Dark chrome that matches the Live Board. Kept in sync with the board's
// background so an installed app's splash/theme reads as the same product.
const THEME_COLOR = "#0a0d12";

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

export function manifestRoutes(prisma: PrismaClient) {
  const app = new Hono();

  app.get("/:file", async (c) => {
    const file = c.req.param("file");
    // The route param carries the trailing `.webmanifest`; strip it to get the
    // slug. Reject anything that doesn't end in the expected suffix.
    const suffix = ".webmanifest";
    if (!file.endsWith(suffix)) return c.notFound();
    const slug = file.slice(0, -suffix.length);
    if (slug.length === 0) return c.notFound();

    const conf = await prisma.conference.findUnique({
      where: { slug },
      select: { name: true, iconHash: true },
    });
    if (!conf) return c.notFound();

    const icons: ManifestIcon[] = conf.iconHash
      ? [
          {
            src: `/api/conference-icons/${slug}/192/${conf.iconHash}`,
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: `/api/conference-icons/${slug}/512/${conf.iconHash}`,
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ]
      : [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ];

    const manifest = {
      name: conf.name,
      short_name: conf.name,
      // Launching the installed icon lands straight in the conference. The
      // trailing slash is REQUIRED: `scope` is matched as a path prefix, so a
      // slash-terminated scope (/conferences/foo/) is what stops one conference
      // from capturing another whose slug it prefixes (e.g. `ai` vs `ai-2026`).
      start_url: `/conferences/${slug}/`,
      scope: `/conferences/${slug}/`,
      // Per-conference identity within scope so browsers treat each conference
      // as a separate installable app (multiple installs coexist).
      id: `/conferences/${slug}/`,
      display: "standalone",
      theme_color: THEME_COLOR,
      background_color: THEME_COLOR,
      icons,
    };

    return new Response(JSON.stringify(manifest), {
      headers: {
        "content-type": "application/manifest+json; charset=utf-8",
        // Short cache: the name/icon can change from Settings, and the icon URL
        // is already hash-busted, so a brief TTL is a safe freshness tradeoff.
        "cache-control": "public, max-age=300",
      },
    });
  });

  return app;
}
