// Pure aggregation: turn a set of per-worker snapshots into Prometheus text.
//
// No I/O, no Prisma, no Date.now — every input is passed in. Easy to unit
// test, and lets the launcher serve a deterministic response for a given
// snapshot store.
//
// Output convention:
//   - Per-worker metrics carry a `worker="N"` label. Dashboards aggregate
//     with PromQL (`sum(metric)`); we don't pre-sum here, otherwise stale
//     worker contributions get baked into the no-label series.
//   - Global counts (users, conferences, storage, etc.) have NO worker
//     label — they describe the cluster, not the individual process.
//   - `app_uptime_seconds` is the launcher's lifetime (cluster mode) or the
//     single worker's lifetime — whichever this server is sitting on.
//   - `app_workers_total` reports how many workers have sent a fresh
//     snapshot within the stale threshold. Operators can alert on dips.

import type { MetricsSnapshot } from "./types";

export interface StoredSnapshot {
  snapshot: MetricsSnapshot;
  receivedAt: number;
}

export interface AggregateInput {
  // worker id -> stored snapshot
  snapshots: Map<number, StoredSnapshot>;
  // Wall-clock time of the render. Used to mark snapshots stale.
  nowMs: number;
  // Process-start time of the server that's rendering (launcher in cluster
  // mode, single worker otherwise).
  rendererStartedAt: number;
  // How old (ms) a snapshot can be before we treat its gauges as 0.
  staleThresholdMs: number;
}

interface MetricLine {
  name: string;
  help: string;
  type: "gauge" | "counter";
  value: number;
  labels?: Record<string, string>;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLines(lines: MetricLine[]): string {
  // Group by name so `# HELP` and `# TYPE` are emitted once per family,
  // followed by every labeled value. Required by the Prometheus exposition
  // format.
  const byName = new Map<string, MetricLine[]>();
  for (const l of lines) {
    const arr = byName.get(l.name);
    if (arr) arr.push(l);
    else byName.set(l.name, [l]);
  }
  const out: string[] = [];
  for (const [name, group] of byName) {
    out.push(`# HELP ${name} ${group[0]!.help}`);
    out.push(`# TYPE ${name} ${group[0]!.type}`);
    for (const m of group) {
      const labelStr = m.labels
        ? "{" + Object.entries(m.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",") + "}"
        : "";
      out.push(`${name}${labelStr} ${m.value}`);
    }
  }
  return out.join("\n") + "\n";
}

export function renderPrometheusText(input: AggregateInput): string {
  const { snapshots, nowMs, rendererStartedAt, staleThresholdMs } = input;

  const freshWorkers: { workerId: number; entry: StoredSnapshot }[] = [];
  const staleWorkers: { workerId: number; entry: StoredSnapshot }[] = [];
  for (const [workerId, entry] of snapshots) {
    if (nowMs - entry.receivedAt <= staleThresholdMs) {
      freshWorkers.push({ workerId, entry });
    } else {
      staleWorkers.push({ workerId, entry });
    }
  }
  // Stable ordering by worker id so the text output is deterministic.
  freshWorkers.sort((a, b) => a.workerId - b.workerId);
  staleWorkers.sort((a, b) => a.workerId - b.workerId);

  // Global counts come from the freshest snapshot with non-null `global`,
  // falling back to the freshest stale one. Returns null if no snapshot
  // ever carried global state — `app_metrics_global_stale` flags this so
  // dashboards can show "no DB data yet" instead of a flat 0.
  const globalEntries = [...snapshots.values()]
    .filter((e) => e.snapshot.global !== null)
    .sort((a, b) => b.receivedAt - a.receivedAt);
  const globalSource = globalEntries[0] ?? null;
  const globalIsStale =
    globalSource !== null && nowMs - globalSource.receivedAt > staleThresholdMs;
  const global = globalSource?.snapshot.global ?? null;

  const lines: MetricLine[] = [];

  // ---- Renderer-level state ---------------------------------------------
  lines.push({
    name: "app_uptime_seconds",
    help: "Seconds since this metrics server started (launcher in cluster mode, app process in single-worker mode).",
    type: "gauge",
    value: Math.floor((nowMs - rendererStartedAt) / 1000),
  });
  lines.push({
    name: "app_workers_total",
    help: "Number of workers that have reported a fresh snapshot within the stale threshold.",
    type: "gauge",
    value: freshWorkers.length,
  });
  lines.push({
    name: "app_workers_stale_total",
    help: "Workers that reported in the past but have not sent a snapshot recently. Sustained non-zero = the worker is wedged or has died.",
    type: "gauge",
    value: staleWorkers.length,
  });
  lines.push({
    name: "app_metrics_global_stale",
    help: "1 when the global (DB + storage) counts come from a stale worker snapshot, 0 otherwise. NaN-style 0 when no global data has ever been received.",
    type: "gauge",
    value: globalSource === null ? 0 : (globalIsStale ? 1 : 0),
  });

  // ---- Per-worker uptime ------------------------------------------------
  // Emit for every known worker (fresh OR stale) so a worker disappearing
  // doesn't cause Prometheus to forget its series mid-graph.
  for (const { workerId, entry } of [...freshWorkers, ...staleWorkers]) {
    lines.push({
      name: "worker_uptime_seconds",
      help: "Per-worker uptime as reported in its most recent snapshot.",
      type: "gauge",
      value: Math.floor((entry.receivedAt - entry.snapshot.startedAt) / 1000),
      labels: { worker: String(workerId) },
    });
  }

  // ---- Realtime SSE (per-worker) ---------------------------------------
  // Active gauges go to 0 for stale workers — the SSE connections they were
  // serving are functionally dead even if Prometheus still has the label.
  for (const { workerId, entry } of [...freshWorkers, ...staleWorkers]) {
    const rt = entry.snapshot.realtime;
    const isFresh = nowMs - entry.receivedAt <= staleThresholdMs;
    lines.push({
      name: "realtime_sse_active_connections",
      help: "Currently-open SSE connections served by this worker. Aggregate with sum() to get cluster total.",
      type: "gauge",
      value: isFresh ? rt.activeConnections : 0,
      labels: { worker: String(workerId) },
    });
    lines.push({
      name: "realtime_sse_total_connections",
      help: "Total SSE connections accepted by this worker over its lifetime.",
      type: "counter",
      value: rt.totalConnections,
      labels: { worker: String(workerId) },
    });
    lines.push({
      name: "realtime_sse_replay_message_events_total",
      help: "Message events emitted via Last-Event-ID replay on reconnect.",
      type: "counter",
      value: rt.replayMessageEvents,
      labels: { worker: String(workerId) },
    });
    lines.push({
      name: "realtime_sse_replay_notification_events_total",
      help: "Notification events emitted via Last-Event-ID replay on reconnect.",
      type: "counter",
      value: rt.replayNotificationEvents,
      labels: { worker: String(workerId) },
    });
  }

  // ---- Bus (per-worker) -------------------------------------------------
  for (const { workerId, entry } of [...freshWorkers, ...staleWorkers]) {
    const bus = entry.snapshot.bus;
    const isFresh = nowMs - entry.receivedAt <= staleThresholdMs;
    lines.push({
      name: "bus_active_subscriptions",
      help: "Active EventBus subscriptions on this worker (one per SSE connection per subscribed identity).",
      type: "gauge",
      value: isFresh ? bus.activeSubscriptions : 0,
      labels: { worker: String(workerId) },
    });
    lines.push({
      name: "bus_ipc_sent_total",
      help: "Outbound IPC bus messages from this worker to the launcher. Always 0 in single-worker mode.",
      type: "counter",
      value: bus.ipcSent,
      labels: { worker: String(workerId) },
    });
    lines.push({
      name: "bus_ipc_received_total",
      help: "Inbound IPC bus messages this worker received from the launcher.",
      type: "counter",
      value: bus.ipcReceived,
      labels: { worker: String(workerId) },
    });
    for (const [kind, value] of Object.entries(bus.publishedByKind)) {
      lines.push({
        name: "bus_published_total",
        help: "EventBus publish calls on this worker, split by event kind.",
        type: "counter",
        value,
        labels: { worker: String(workerId), kind },
      });
    }
    for (const [kind, value] of Object.entries(bus.deliveredByKind)) {
      lines.push({
        name: "bus_delivered_total",
        help: "EventBus handler invocations on this worker, split by event kind.",
        type: "counter",
        value,
        labels: { worker: String(workerId), kind },
      });
    }
  }

  // ---- Global (instance-wide) counts -----------------------------------
  // No worker label — these describe the underlying DB + volume.
  if (global !== null) {
    lines.push({ name: "users_total", help: "Global owner accounts on this instance.", type: "gauge", value: global.users });
    lines.push({ name: "conferences_total", help: "Conferences on this instance.", type: "gauge", value: global.conferences });
    lines.push({ name: "conference_identities_total", help: "Per-conference identities (participants + moderators + auto-minted owner identities).", type: "gauge", value: global.identities });
    lines.push({ name: "submissions_total", help: "All submissions across all conferences, regardless of status.", type: "gauge", value: global.submissions });
    for (const [status, value] of Object.entries(global.submissionsByStatus)) {
      lines.push({
        name: "submissions_by_status_total",
        help: "Submissions split by current status.",
        type: "gauge",
        value,
        labels: { status },
      });
    }
    lines.push({ name: "stars_total", help: "Stars (interest indications) across all sessions.", type: "gauge", value: global.stars });
    lines.push({ name: "notifications_total", help: "Stored notifications across all identities.", type: "gauge", value: global.notifications });
    lines.push({ name: "rooms_total", help: "Rooms across all conferences.", type: "gauge", value: global.rooms });
    lines.push({ name: "invites_total", help: "Conference invites issued, claimed or not.", type: "gauge", value: global.invites });
    lines.push({ name: "invites_unclaimed_total", help: "Conference invites that haven't been claimed yet.", type: "gauge", value: global.invitesUnclaimed });
    lines.push({ name: "experts_total", help: "Experts promoted on this instance.", type: "gauge", value: global.experts });
    lines.push({ name: "expert_bookings_total", help: "Expert 1:1 bookings.", type: "gauge", value: global.expertBookings });
    lines.push({ name: "chat_conversations_total", help: "All chat conversations, including unaccepted (in 'Requests').", type: "gauge", value: global.chatConversations });
    lines.push({ name: "chat_conversations_accepted_total", help: "Conversations past the request stage.", type: "gauge", value: global.chatConversationsAccepted });
    lines.push({ name: "chat_messages_total", help: "All chat messages, including soft-deleted.", type: "gauge", value: global.chatMessages });
    lines.push({ name: "chat_messages_deleted_total", help: "Chat messages with a non-null deleted_at.", type: "gauge", value: global.chatMessagesDeleted });
    lines.push({ name: "chat_reports_total", help: "Filed chat reports, regardless of resolution status.", type: "gauge", value: global.chatReports });
    lines.push({ name: "chat_reports_open_total", help: "Chat reports awaiting moderator action (resolved_at IS NULL).", type: "gauge", value: global.chatReportsOpen });
    lines.push({ name: "chat_blocks_total", help: "Per-user chat blocks (directional).", type: "gauge", value: global.chatBlocks });
    lines.push({ name: "chat_banned_identities_total", help: "Identities currently chat-banned by a moderator.", type: "gauge", value: global.chatBannedIdentities });
    lines.push({ name: "chat_disabled_identities_total", help: "Identities who disabled chat for themselves.", type: "gauge", value: global.chatDisabledIdentities });
    lines.push({ name: "storage_pvc_total_bytes", help: "Total bytes available to the data volume.", type: "gauge", value: global.storage.totalBytes });
    lines.push({ name: "storage_pvc_free_bytes", help: "Free bytes available on the data volume.", type: "gauge", value: global.storage.freeBytes });
    lines.push({ name: "storage_pvc_used_bytes", help: "Bytes consumed on the data volume.", type: "gauge", value: global.storage.usedBytes });
    lines.push({ name: "storage_db_file_bytes", help: "Size of the SQLite database file on disk (WAL/SHM not included).", type: "gauge", value: global.storage.dbFileBytes });
  }

  return formatLines(lines);
}
