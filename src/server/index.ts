import { Hono } from "hono";
import { logger } from "hono/logger";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPrisma } from "./db";
import { calendarRoutes } from "./routes/calendar";
import { handleRpc } from "./rpc";

export function buildApp(prisma = getPrisma()) {
  const app = new Hono();
  app.use("*", logger());

  app.get("/api/health", (c) => c.json({ ok: true }));

  // The only resource served as plain HTTP — calendar apps need a stable
  // text/calendar URL with no JSON envelope. Mounted BEFORE the oRPC
  // catch-all so it wins for `/api/calendar/<token>.ics`.
  app.route("/api/calendar", calendarRoutes(prisma));

  // All other API traffic flows through oRPC (contract-driven; see
  // src/shared/contract.ts + src/server/rpc.ts).
  app.all("/api/*", async (c) => {
    const res = await handleRpc(prisma, c.req.raw);
    if (res) return res;
    return c.notFound();
  });

  return app;
}

// Production static serving: if /dist exists, serve it.
// In dev we set SERVE_STATIC=0 so Vite (port 5173) owns the frontend.
function serveStatic(req: Request, distDir: string): Response | null {
  const url = new URL(req.url);
  let path = url.pathname;
  if (path === "/" || !path.includes(".")) path = "/index.html";
  const filePath = join(distDir, path);
  if (!filePath.startsWith(distDir)) return null; // prevent traversal
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback: any unknown route returns index.html so hash-router works.
    const fallback = join(distDir, "index.html");
    if (!existsSync(fallback)) return null;
    return new Response(readFileSync(fallback), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const type = mimeFor(filePath);
  return new Response(readFileSync(filePath), { headers: { "content-type": type } });
}

function mimeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

if (import.meta.main) {
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  const distDir = join(import.meta.dir, "../../dist");
  const wantsStatic = process.env.SERVE_STATIC !== "0" && existsSync(distDir);

  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) return app.fetch(req);
      if (wantsStatic) {
        const r = serveStatic(req, distDir);
        if (r) return r;
      }
      return new Response("Not Found (no static dist; in dev open the Vite URL)", { status: 404 });
    },
  });
  console.log(
    `simple-unconference API: http://localhost:${port}` +
      (wantsStatic ? " (serving dist/ statically)" : " (dev: open Vite at http://localhost:5173)"),
  );
}
