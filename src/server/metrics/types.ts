// Cross-process metrics types. Workers push `MetricsSnapshot` payloads to the
// cluster launcher via Bun.spawn IPC; the launcher aggregates them and serves
// the result on the dedicated metrics port. Single-worker deployments build
// the same snapshot in-process and render directly — same code paths, just
// without the IPC hop.
//
// The wire shape is intentionally compact: no Prometheus formatting here, no
// labels, just raw numbers. All formatting lives in aggregate.ts so the IPC
// payload size stays bounded regardless of how many metric families we emit.

import type { BusMetricsSnapshot } from "../realtime/bus";
import type { RealtimeMetricsSnapshot } from "../realtime/metrics";

// Global (instance-wide) counts. Sourced from a single worker (the one with
// WORKER_ID=0, or the lone worker in single-process mode) so we don't fan
// out N Prisma count queries per push cycle.
export interface GlobalCounts {
  users: number;
  conferences: number;
  identities: number;
  submissions: number;
  // Submissions grouped by status enum value. Status values are emitted as
  // strings — keep the key set under control so Prometheus cardinality
  // stays bounded.
  submissionsByStatus: Record<string, number>;
  stars: number;
  notifications: number;
  rooms: number;
  invites: number;
  invitesUnclaimed: number;
  experts: number;
  expertBookings: number;
  chatConversations: number;
  chatConversationsAccepted: number;
  chatMessages: number;
  chatMessagesDeleted: number;
  chatReports: number;
  chatReportsOpen: number;
  chatBlocks: number;
  chatBannedIdentities: number;
  chatDisabledIdentities: number;
  storage: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    dbFileBytes: number;
  };
}

// Per-worker snapshot. `global` is non-null only for the worker that owns the
// global-counts query (worker 0). The aggregator picks the most recent
// non-null `global` across all snapshots so a restart of worker 0 doesn't
// blank out the DB numbers immediately — they decay only with snapshot age.
export interface MetricsSnapshot {
  workerId: number;
  // Process start ms (Date.now() at module load). Used to compute per-worker
  // uptime; the cluster-level uptime is the launcher's own process start.
  startedAt: number;
  bus: BusMetricsSnapshot;
  realtime: RealtimeMetricsSnapshot;
  global: GlobalCounts | null;
}

// IPC envelope: workers send these to the launcher in addition to bus events.
// The launcher demultiplexes by `type` in its ipc(message) handler.
export interface MetricsSnapshotMessage {
  type: "metrics-snapshot";
  payload: MetricsSnapshot;
}

export function isMetricsSnapshotMessage(m: unknown): m is MetricsSnapshotMessage {
  if (typeof m !== "object" || m === null) return false;
  const obj = m as { type?: unknown; payload?: unknown };
  if (obj.type !== "metrics-snapshot") return false;
  if (typeof obj.payload !== "object" || obj.payload === null) return false;
  const p = obj.payload as { workerId?: unknown; bus?: unknown; realtime?: unknown };
  return (
    typeof p.workerId === "number" &&
    typeof p.bus === "object" && p.bus !== null &&
    typeof p.realtime === "object" && p.realtime !== null
  );
}
