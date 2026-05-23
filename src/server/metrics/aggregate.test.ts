// Unit tests for the pure aggregator. No I/O — just builds snapshot maps and
// asserts on the resulting Prometheus text.

import { describe, test, expect } from "bun:test";
import { renderPrometheusText, type StoredSnapshot } from "./aggregate";
import type { GlobalCounts, MetricsSnapshot } from "./types";

const NOW = 1_700_000_000_000;
const STALE = 15_000;

function emptyGlobal(): GlobalCounts {
  return {
    users: 0, conferences: 0, identities: 0, submissions: 0,
    submissionsByStatus: {},
    stars: 0, notifications: 0, rooms: 0,
    invites: 0, invitesUnclaimed: 0,
    experts: 0, expertBookings: 0,
    chatConversations: 0, chatConversationsAccepted: 0,
    chatMessages: 0, chatMessagesDeleted: 0,
    chatReports: 0, chatReportsOpen: 0,
    chatBlocks: 0, chatBannedIdentities: 0, chatDisabledIdentities: 0,
    storage: { totalBytes: 0, freeBytes: 0, usedBytes: 0, dbFileBytes: 0 },
  };
}

function mkSnapshot(workerId: number, opts: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    workerId,
    startedAt: NOW - 60_000,
    bus: {
      publishedByKind: {},
      deliveredByKind: {},
      ipcSent: 0,
      ipcReceived: 0,
      activeSubscriptions: 0,
    },
    realtime: {
      activeConnections: 0,
      totalConnections: 0,
      replayMessageEvents: 0,
      replayNotificationEvents: 0,
    },
    global: null,
    ...opts,
  };
}

function mkStore(entries: Array<{ workerId: number; snapshot: MetricsSnapshot; receivedAt: number }>): Map<number, StoredSnapshot> {
  return new Map(entries.map((e) => [e.workerId, { snapshot: e.snapshot, receivedAt: e.receivedAt }]));
}

describe("renderPrometheusText", () => {
  test("emits per-worker SSE active gauge labeled by worker id", () => {
    const store = mkStore([
      { workerId: 0, snapshot: mkSnapshot(0, { realtime: { activeConnections: 12, totalConnections: 100, replayMessageEvents: 5, replayNotificationEvents: 2 } }), receivedAt: NOW - 1_000 },
      { workerId: 1, snapshot: mkSnapshot(1, { realtime: { activeConnections: 7,  totalConnections: 80,  replayMessageEvents: 1, replayNotificationEvents: 0 } }), receivedAt: NOW - 1_000 },
    ]);
    const out = renderPrometheusText({ snapshots: store, nowMs: NOW, rendererStartedAt: NOW - 5_000, staleThresholdMs: STALE });
    expect(out).toMatch(/^realtime_sse_active_connections\{worker="0"\} 12$/m);
    expect(out).toMatch(/^realtime_sse_active_connections\{worker="1"\} 7$/m);
    expect(out).toMatch(/^# TYPE realtime_sse_active_connections gauge$/m);
    expect(out).toMatch(/^realtime_sse_total_connections\{worker="0"\} 100$/m);
    expect(out).toMatch(/^realtime_sse_total_connections\{worker="1"\} 80$/m);
  });

  test("active gauges are zeroed for stale workers but counters preserved", () => {
    const store = mkStore([
      { workerId: 0, snapshot: mkSnapshot(0, { realtime: { activeConnections: 5, totalConnections: 50, replayMessageEvents: 0, replayNotificationEvents: 0 } }), receivedAt: NOW - 1_000 },
      { workerId: 1, snapshot: mkSnapshot(1, { realtime: { activeConnections: 9, totalConnections: 90, replayMessageEvents: 4, replayNotificationEvents: 0 } }), receivedAt: NOW - 60_000 },
    ]);
    const out = renderPrometheusText({ snapshots: store, nowMs: NOW, rendererStartedAt: NOW - 5_000, staleThresholdMs: STALE });
    // Stale worker keeps its counter value (monotonic), gauges zero out.
    expect(out).toMatch(/^realtime_sse_active_connections\{worker="1"\} 0$/m);
    expect(out).toMatch(/^realtime_sse_total_connections\{worker="1"\} 90$/m);
    expect(out).toMatch(/^app_workers_total 1$/m);
    expect(out).toMatch(/^app_workers_stale_total 1$/m);
  });

  test("global counts come from a non-null global snapshot", () => {
    const global = emptyGlobal();
    global.users = 42;
    global.conferences = 7;
    global.submissionsByStatus = { ACCEPTED: 3, REJECTED: 1 };
    global.storage.totalBytes = 1024 * 1024 * 1024;

    const store = mkStore([
      { workerId: 0, snapshot: mkSnapshot(0, { global }), receivedAt: NOW - 2_000 },
      { workerId: 1, snapshot: mkSnapshot(1), receivedAt: NOW - 2_000 }, // no global
    ]);
    const out = renderPrometheusText({ snapshots: store, nowMs: NOW, rendererStartedAt: NOW - 5_000, staleThresholdMs: STALE });
    expect(out).toMatch(/^users_total 42$/m);
    expect(out).toMatch(/^conferences_total 7$/m);
    expect(out).toMatch(/^submissions_by_status_total\{status="ACCEPTED"\} 3$/m);
    expect(out).toMatch(/^submissions_by_status_total\{status="REJECTED"\} 1$/m);
    expect(out).toMatch(/^storage_pvc_total_bytes 1073741824$/m);
    expect(out).toMatch(/^app_metrics_global_stale 0$/m);
  });

  test("flags global counts as stale when only stale snapshots carry them", () => {
    const global = emptyGlobal();
    global.users = 5;
    const store = mkStore([
      { workerId: 0, snapshot: mkSnapshot(0, { global }), receivedAt: NOW - 60_000 },
      { workerId: 1, snapshot: mkSnapshot(1), receivedAt: NOW - 1_000 },
    ]);
    const out = renderPrometheusText({ snapshots: store, nowMs: NOW, rendererStartedAt: NOW - 5_000, staleThresholdMs: STALE });
    // The stale worker-0 snapshot is still the only source of global counts —
    // we render them and flag staleness so dashboards can paint a banner.
    expect(out).toMatch(/^users_total 5$/m);
    expect(out).toMatch(/^app_metrics_global_stale 1$/m);
  });

  test("omits global metric families entirely when no snapshot has them", () => {
    const store = mkStore([
      { workerId: 0, snapshot: mkSnapshot(0), receivedAt: NOW - 1_000 },
    ]);
    const out = renderPrometheusText({ snapshots: store, nowMs: NOW, rendererStartedAt: NOW - 5_000, staleThresholdMs: STALE });
    expect(out).not.toMatch(/^users_total/m);
    expect(out).not.toMatch(/^storage_pvc_total_bytes/m);
    expect(out).toMatch(/^app_metrics_global_stale 0$/m);
  });

  test("bus per-kind counters are emitted with both worker and kind labels", () => {
    const snap0 = mkSnapshot(0, {
      bus: {
        publishedByKind: { "message.created": 10, "notification.upserted": 4 },
        deliveredByKind: { "message.created": 8 },
        ipcSent: 14,
        ipcReceived: 6,
        activeSubscriptions: 3,
      },
    });
    const store = mkStore([{ workerId: 0, snapshot: snap0, receivedAt: NOW - 500 }]);
    const out = renderPrometheusText({ snapshots: store, nowMs: NOW, rendererStartedAt: NOW - 5_000, staleThresholdMs: STALE });
    expect(out).toMatch(/^bus_published_total\{worker="0",kind="message\.created"\} 10$/m);
    expect(out).toMatch(/^bus_published_total\{worker="0",kind="notification\.upserted"\} 4$/m);
    expect(out).toMatch(/^bus_delivered_total\{worker="0",kind="message\.created"\} 8$/m);
    expect(out).toMatch(/^bus_ipc_sent_total\{worker="0"\} 14$/m);
    expect(out).toMatch(/^bus_active_subscriptions\{worker="0"\} 3$/m);
  });

  test("emits help+type once per metric family even with many workers", () => {
    const store = mkStore([
      { workerId: 0, snapshot: mkSnapshot(0, { realtime: { activeConnections: 1, totalConnections: 1, replayMessageEvents: 0, replayNotificationEvents: 0 } }), receivedAt: NOW - 100 },
      { workerId: 1, snapshot: mkSnapshot(1, { realtime: { activeConnections: 2, totalConnections: 2, replayMessageEvents: 0, replayNotificationEvents: 0 } }), receivedAt: NOW - 100 },
      { workerId: 2, snapshot: mkSnapshot(2, { realtime: { activeConnections: 3, totalConnections: 3, replayMessageEvents: 0, replayNotificationEvents: 0 } }), receivedAt: NOW - 100 },
    ]);
    const out = renderPrometheusText({ snapshots: store, nowMs: NOW, rendererStartedAt: NOW - 5_000, staleThresholdMs: STALE });
    // Each "# HELP realtime_sse_active_connections" appears exactly once.
    const helpCount = (out.match(/^# HELP realtime_sse_active_connections /gm) ?? []).length;
    expect(helpCount).toBe(1);
    const typeCount = (out.match(/^# TYPE realtime_sse_active_connections /gm) ?? []).length;
    expect(typeCount).toBe(1);
  });

  test("trailing newline and valid renderer uptime", () => {
    const store = mkStore([{ workerId: 0, snapshot: mkSnapshot(0), receivedAt: NOW - 500 }]);
    const out = renderPrometheusText({ snapshots: store, nowMs: NOW, rendererStartedAt: NOW - 10_000, staleThresholdMs: STALE });
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toMatch(/^app_uptime_seconds 10$/m);
  });
});
