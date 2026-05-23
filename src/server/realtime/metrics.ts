// Per-worker SSE connection metrics. The realtime route increments
// activeConnections on connect and decrements on cancel; metrics.ts reads
// the snapshot at /api/metrics render time.

interface RealtimeMetrics {
  activeConnections: number;
  totalConnections: number;   // monotonically increasing over process lifetime
  replayMessageEvents: number; // events emitted via Last-Event-ID replay
  replayNotificationEvents: number;
}

const m: RealtimeMetrics = {
  activeConnections: 0,
  totalConnections: 0,
  replayMessageEvents: 0,
  replayNotificationEvents: 0,
};

export function recordConnectionOpened(): void {
  m.activeConnections++;
  m.totalConnections++;
}

export function recordConnectionClosed(): void {
  m.activeConnections = Math.max(0, m.activeConnections - 1);
}

export function recordReplayMessageEvent(): void {
  m.replayMessageEvents++;
}

export function recordReplayNotificationEvent(): void {
  m.replayNotificationEvents++;
}

export interface RealtimeMetricsSnapshot {
  activeConnections: number;
  totalConnections: number;
  replayMessageEvents: number;
  replayNotificationEvents: number;
}

export function getRealtimeMetricsSnapshot(): RealtimeMetricsSnapshot {
  return { ...m };
}
