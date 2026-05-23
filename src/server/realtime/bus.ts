// In-process and cross-worker event bus for realtime fan-out. Routes call
// `getBus().publish(...)`; the SSE handler in routes/realtime.ts subscribes
// per recipient identity and writes events to the connected client.
//
// The bus is best-effort. Source of truth is always Message / Notification
// rows in the DB. Lost or dropped events recover via the SSE client's
// Last-Event-ID reconnect path, which replays anything newer than the highest
// ID it has seen.
//
// Two impls:
//   - InProcessBus: single-process mode (WORKERS=1). Pure EventEmitter.
//   - ClusterBus: workers spawned by src/server/cluster.ts. Each worker holds
//     a local subscriber map; publish() dispatches locally AND sends the
//     event via process.send to the launcher, which mirrors it to every
//     other worker. Each worker filters incoming messages by what it has
//     subscribed locally.
//
// Picked at boot by makeBus() based on whether `process.send` is defined —
// Bun.spawn sets up an IPC channel automatically when the parent passes an
// `ipc` callback.

export type BusEvent =
  | { kind: "message.created"; recipientId: number; messageId: number; conversationId: number }
  | { kind: "message.edited"; recipientId: number; messageId: number; conversationId: number }
  | { kind: "message.deleted"; recipientId: number; messageId: number; conversationId: number }
  | { kind: "message.read"; recipientId: number; conversationId: number }
  | { kind: "notification.upserted"; recipientId: number; notificationId: number }
  | { kind: "notification.read"; recipientId: number; conversationId: number | null };

export type BusHandler = (event: BusEvent) => void;

export interface EventBus {
  publish(event: BusEvent): void;
  subscribe(recipientId: number, handler: BusHandler): () => void;
  // Sum of handlers across all recipient ids — surfaces SSE fan-out load
  // per worker on the /api/metrics endpoint. Cheap (Map traversal).
  subscriptionCount(): number;
}

// Per-worker counters surfaced via /api/metrics. The launcher's drop counter
// is logged separately (workers can't observe it directly via Bun.spawn IPC),
// so chronic launcher-side drops show up in pod logs and ipc_received_total
// will plateau relative to ipc_sent_total on other workers.
interface BusMetrics {
  publishedByKind: Map<string, number>;
  deliveredByKind: Map<string, number>;
  ipcSent: number;
  ipcReceived: number;
}
const metrics: BusMetrics = {
  publishedByKind: new Map(),
  deliveredByKind: new Map(),
  ipcSent: 0,
  ipcReceived: 0,
};
function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export interface BusMetricsSnapshot {
  publishedByKind: Record<string, number>;
  deliveredByKind: Record<string, number>;
  ipcSent: number;
  ipcReceived: number;
  activeSubscriptions: number;
}
export function getBusMetricsSnapshot(): BusMetricsSnapshot {
  return {
    publishedByKind: Object.fromEntries(metrics.publishedByKind),
    deliveredByKind: Object.fromEntries(metrics.deliveredByKind),
    ipcSent: metrics.ipcSent,
    ipcReceived: metrics.ipcReceived,
    activeSubscriptions: _bus ? _bus.subscriptionCount() : 0,
  };
}

class InProcessBus implements EventBus {
  private subs = new Map<number, Set<BusHandler>>();

  publish(event: BusEvent): void {
    inc(metrics.publishedByKind, event.kind);
    this.dispatch(event);
  }

  subscribe(recipientId: number, handler: BusHandler): () => void {
    let set = this.subs.get(recipientId);
    if (!set) {
      set = new Set();
      this.subs.set(recipientId, set);
    }
    set.add(handler);
    return () => {
      const s = this.subs.get(recipientId);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.subs.delete(recipientId);
    };
  }

  subscriptionCount(): number {
    let n = 0;
    for (const set of this.subs.values()) n += set.size;
    return n;
  }

  private dispatch(event: BusEvent): void {
    const set = this.subs.get(event.recipientId);
    if (!set) return;
    for (const h of set) {
      inc(metrics.deliveredByKind, event.kind);
      try {
        h(event);
      } catch (e) {
        console.error("[bus] handler threw", e);
      }
    }
  }
}

class ClusterBus implements EventBus {
  private subs = new Map<number, Set<BusHandler>>();

  constructor() {
    process.on("message", (msg: unknown) => {
      if (!isBusMessage(msg)) return;
      metrics.ipcReceived++;
      this.dispatch(msg.event);
    });
  }

  publish(event: BusEvent): void {
    inc(metrics.publishedByKind, event.kind);
    this.dispatch(event);
    try {
      const ok = process.send?.({ type: "bus", event });
      if (ok !== false) metrics.ipcSent++;
    } catch {
      // Parent gone (process exiting). Client replay covers it.
    }
  }

  subscribe(recipientId: number, handler: BusHandler): () => void {
    let set = this.subs.get(recipientId);
    if (!set) {
      set = new Set();
      this.subs.set(recipientId, set);
    }
    set.add(handler);
    return () => {
      const s = this.subs.get(recipientId);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.subs.delete(recipientId);
    };
  }

  subscriptionCount(): number {
    let n = 0;
    for (const set of this.subs.values()) n += set.size;
    return n;
  }

  private dispatch(event: BusEvent): void {
    const set = this.subs.get(event.recipientId);
    if (!set) return;
    for (const h of set) {
      inc(metrics.deliveredByKind, event.kind);
      try {
        h(event);
      } catch (e) {
        console.error("[bus] handler threw", e);
      }
    }
  }
}

export function isBusMessage(m: unknown): m is { type: "bus"; event: BusEvent } {
  if (typeof m !== "object" || m === null) return false;
  const obj = m as { type?: unknown; event?: unknown };
  if (obj.type !== "bus") return false;
  if (typeof obj.event !== "object" || obj.event === null) return false;
  const ev = obj.event as { kind?: unknown; recipientId?: unknown };
  return typeof ev.kind === "string" && typeof ev.recipientId === "number";
}

export function makeBus(): EventBus {
  return typeof process.send === "function" ? new ClusterBus() : new InProcessBus();
}

let _bus: EventBus | null = null;

export function getBus(): EventBus {
  if (!_bus) _bus = makeBus();
  return _bus;
}

// Test-only: reset the singleton so each test can start clean.
export function __resetBusForTests(): void {
  _bus = null;
}

// Test-only: replace the singleton with a custom impl (e.g. a recording bus).
export function __setBusForTests(bus: EventBus): void {
  _bus = bus;
}
