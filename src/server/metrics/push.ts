// Worker-side push loop: every PUSH_INTERVAL_MS, send a metrics snapshot to
// the launcher over Bun's spawn IPC channel. Worker 0 includes the global
// DB + storage counts; others send per-worker counters only.
//
// Best-effort: a missed push just shows up as a slightly older snapshot at
// the launcher. The aggregator's stale threshold (3x this interval) absorbs
// transient gaps without flapping `app_workers_total`.

import type { PrismaClient } from "@prisma/client";
import { collectLocalSnapshot } from "./collect";
import type { MetricsSnapshotMessage } from "./types";

export const PUSH_INTERVAL_MS = 5_000;

// Stops after the returned function is called. Safe to invoke at server
// shutdown to flush the interval handle.
export function startMetricsPusher(prisma: PrismaClient): () => void {
  // Without an IPC channel we're not in a cluster worker. Single-worker
  // mode renders metrics in-process via server.ts, so there's nothing to push.
  if (typeof process.send !== "function") return () => {};

  const workerId = Number(process.env.WORKER_ID ?? "0");
  // Worker 0 is the global-counts owner. In auto/manual cluster mode
  // cluster.ts always spawns worker 0; if it crashes, the launcher
  // respawns it with the same id, so this assignment is durable.
  const includeGlobal = workerId === 0;

  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const snapshot = await collectLocalSnapshot(prisma, { workerId, includeGlobal });
      const msg: MetricsSnapshotMessage = { type: "metrics-snapshot", payload: snapshot };
      process.send?.(msg);
    } catch (e) {
      // Logged at warning, not error: the launcher will mark this worker
      // stale via `app_workers_stale_total` and dashboards will surface it.
      // We don't want a transient Prisma hiccup to spam stderr on every tick.
      console.warn(`[metrics] push tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // First push happens immediately so the launcher's snapshot map is
  // populated by the time Prometheus's first scrape lands (~30s out by
  // default, plenty of margin, but the empty-launcher case looks like
  // "no workers" otherwise).
  void tick();

  const timer = setInterval(() => { void tick(); }, PUSH_INTERVAL_MS);
  // Don't keep the worker alive on this timer alone. The HTTP server is
  // already a ref'd handle.
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
