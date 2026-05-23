// HTTP server for the metrics port. Bound by:
//   - cluster.ts (launcher): aggregates worker snapshots received via IPC.
//   - index.ts (single worker): collects locally on each scrape.
//
// The path is `/metrics` (no `/api/` prefix — this is not the API server).
// Auth is via Bearer token if `METRICS_TOKEN` is set; unset = open, which
// is appropriate when the port is only reachable from in-cluster scrapers.

import type { PrismaClient } from "@prisma/client";
import type { StoredSnapshot } from "./aggregate";
import { renderPrometheusText } from "./aggregate";
import { collectLocalSnapshot } from "./collect";
import { PUSH_INTERVAL_MS } from "./push";

// 3x the worker push interval. A single missed tick is normal under load;
// three missed ticks (15s) is the point where we want operators to see
// `app_workers_stale_total` go non-zero.
export const STALE_THRESHOLD_MS = 3 * PUSH_INTERVAL_MS;

export const DEFAULT_METRICS_PORT = 9090;

// Resolved at access time so test code setting/unsetting METRICS_TOKEN
// between cases sees the current value (matches metrics.ts / turnstile.ts).
function metricsToken(): string | null {
  return process.env.METRICS_TOKEN?.trim() || null;
}

function authorized(req: Request): boolean {
  const token = metricsToken();
  if (token === null) return true; // open endpoint
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}

export interface MetricsHandlerOptions {
  // Returns the rendered Prometheus text for a single scrape. The function
  // is responsible for collecting + aggregating; the handler only wraps
  // auth + HTTP response details.
  render: () => Promise<string>;
}

// Pure-Request handler. Exported so tests can drive it without binding a
// port. Returns 401 when METRICS_TOKEN is set and the request didn't match,
// 404 for non-/metrics paths, 200 with text/plain otherwise.
export function createMetricsHandler(opts: MetricsHandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/metrics") {
      return new Response("not found", { status: 404 });
    }
    if (!authorized(req)) {
      return new Response("metrics endpoint requires Bearer token", { status: 401 });
    }
    const body = await opts.render();
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  };
}

// Render function for cluster mode: pulls from the launcher's snapshot map.
export function renderFromStore(
  store: Map<number, StoredSnapshot>,
  rendererStartedAt: number,
): string {
  return renderPrometheusText({
    snapshots: store,
    nowMs: Date.now(),
    rendererStartedAt,
    staleThresholdMs: STALE_THRESHOLD_MS,
  });
}

// Render function for single-worker mode: collect locally each scrape,
// build a single-entry snapshot map, render. The single worker is always
// worker 0 (no WORKER_ID env set), and always owns global counts.
export async function renderLocal(
  prisma: PrismaClient,
  rendererStartedAt: number,
): Promise<string> {
  const snapshot = await collectLocalSnapshot(prisma, { workerId: 0, includeGlobal: true });
  const store = new Map<number, StoredSnapshot>([
    [0, { snapshot, receivedAt: Date.now() }],
  ]);
  return renderPrometheusText({
    snapshots: store,
    nowMs: Date.now(),
    rendererStartedAt,
    staleThresholdMs: STALE_THRESHOLD_MS,
  });
}

export interface MetricsServerOptions {
  port: number;
  // Forwarded to createMetricsHandler.
  render: () => Promise<string>;
}

// Boots a Bun.serve on the given port. Returns a stop() to halt it during
// shutdown. Exits the process if the port is already bound — the user
// asked for a dedicated port; silently falling back to a different one
// would be confusing.
export function startMetricsServer(opts: MetricsServerOptions): { stop: () => void } {
  const handler = createMetricsHandler(opts);
  const server = Bun.serve({
    port: opts.port,
    // No idleTimeout override needed — scrapes are short HTTP requests.
    fetch: handler,
  });
  console.log(`[metrics] listening on http://localhost:${server.port}/metrics`);
  return {
    stop: () => {
      try { server.stop(); } catch { /* already stopped */ }
    },
  };
}

// Parse the METRICS_PORT env var. Returns null when the var is unset or
// invalid — callers treat that as "don't expose metrics."
export function resolveMetricsPort(raw: string | undefined): number | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn(`[metrics] METRICS_PORT="${v}" is not a valid TCP port; metrics disabled`);
    return null;
  }
  return n;
}
