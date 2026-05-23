import { Hono } from "hono";
import { logger } from "hono/logger";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPrisma } from "./db";
import { calendarRoutes } from "./routes/calendar";
import { avatarRoutes } from "./routes/avatars";
import { realtimeRoutes } from "./routes/realtime";
import { handleRpc } from "./rpc";
import { startMetricsPusher } from "./metrics/push";
import {
  renderLocal,
  resolveMetricsPort,
  startMetricsServer,
} from "./metrics/server";

export function buildApp(prisma = getPrisma()) {
  const app = new Hono();
  // Skip the request logger under `bun test`: thousands of `<--`/`-->` lines
  // per run dominate test wall time and offer no signal — failures already
  // print their own stack traces.
  if (process.env.NODE_ENV !== "test") {
    app.use("*", logger());
  }

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Prometheus scrape lives on a dedicated port (METRICS_PORT), not on the
  // API server — see src/server/metrics/server.ts. Keeping it off the
  // public port lets ops gate it at the Service / NetworkPolicy layer.

  // The only resource served as plain HTTP — calendar apps need a stable
  // text/calendar URL with no JSON envelope. Mounted BEFORE the oRPC
  // catch-all so it wins for `/api/calendar/<token>.ics`.
  app.route("/api/calendar", calendarRoutes(prisma));

  // Avatar pipeline: binary upload/serve. Mounted before the oRPC catch-all
  // because multipart uploads and image/webp responses don't fit the oRPC
  // contract. See src/server/routes/avatars.ts for the privacy contract.
  app.route("/api/avatars", avatarRoutes(prisma));

  // Realtime SSE stream: one global connection per browser tab, mounted
  // before the oRPC catch-all because text/event-stream doesn't fit the
  // oRPC contract. See src/server/routes/realtime.ts for the wire format
  // and Last-Event-ID replay semantics.
  app.route("/api/realtime", realtimeRoutes(prisma));

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

// Starts the HTTP server. Exported so the cluster launcher can call it in
// single-worker mode without spawning a child. `reusePort` is enabled only
// when the cluster launcher forked us (it sets WORKER_ID), so the kernel
// can load-balance connections across multiple worker processes sharing
// this port. In single-process mode (dev `bun --hot`, plain `bun start`,
// WORKERS=1) we leave it off so Bun.serve fails fast with EADDRINUSE if
// the port is already bound — otherwise an orphaned old backend can keep
// answering requests alongside the new one and you'd never notice.
export function startServer(): void {
  const prisma = getPrisma();
  const app = buildApp(prisma);
  const port = Number(process.env.PORT ?? 3000);
  const distDir = join(import.meta.dir, "../../dist");
  const wantsStatic = process.env.SERVE_STATIC !== "0" && existsSync(distDir);
  const isClusterWorker = process.env.WORKER_ID !== undefined;
  const startedAt = Date.now();

  Bun.serve({
    port,
    reusePort: isClusterWorker,
    // Disable idle timeout. Bun's default (~10s) closes long-lived connections
    // like the /api/realtime/stream SSE endpoint before the first heartbeat
    // (20s) lands, causing the Vite dev proxy to log "socket hang up" loops
    // and the EventSource to never stabilize. SSE drives all chat + push
    // notifications, so this needs to be the default for the API server.
    // Short HTTP requests aren't affected — they complete on their own.
    idleTimeout: 0,
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
  const workerTag = process.env.WORKER_ID !== undefined ? ` [w${process.env.WORKER_ID}]` : "";
  console.log(
    `simple-unconference API${workerTag}: http://localhost:${port}` +
      (wantsStatic ? " (serving dist/ statically)" : " (dev: open Vite at http://localhost:5173)"),
  );

  // Metrics wiring: cluster workers push snapshots to the launcher; the
  // launcher owns the HTTP server. Single-process mode (no WORKER_ID, set
  // by the launcher even when WORKERS=1 except that the launcher calls
  // startServer() directly in-process — no fork — so WORKER_ID is unset)
  // boots its own metrics server when METRICS_PORT is configured.
  if (isClusterWorker) {
    startMetricsPusher(prisma);
  } else {
    const metricsPort = resolveMetricsPort(process.env.METRICS_PORT);
    if (metricsPort !== null) {
      startMetricsServer({
        port: metricsPort,
        render: async () => renderLocal(prisma, startedAt),
      });
    }
  }
}

if (import.meta.main) {
  startServer();
}
