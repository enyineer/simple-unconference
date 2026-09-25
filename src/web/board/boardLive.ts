// Liveness watchdog + poll-first SSE promotion for the board.
//
// Corporate proxies sometimes accept the SSE connection (headers arrive, the
// client's `onopen` fires) but then black-hole the body — no heartbeats, no
// events, no error. The EventSource just sits there looking healthy while
// the wall goes stale. So POLLING IS THE STARTING STATE, not a fallback: the
// snapshot refetches on a fixed cadence from t=0 and the wall is never
// blank. The SSE stream opens in parallel as a PROBE, and the monitor only
// promotes it to live when it has PROOF the response body streams — the
// first `ping` heartbeat or data event, never `onopen` (headers alone arrive
// fine through a black-holing proxy). Promotion stops the polling. A
// promoted stream that then goes silent beyond `stallMs` (or errors) drops
// back into the polling state, and a background probe keeps retrying SSE on
// a slow cadence; the watchdog also recycles probes that open but never
// heartbeat so black-holed connections don't pile up.
//
// The server sends the named `ping` event immediately at stream start and
// every 20s (SSE comments are invisible to the EventSource API, so the
// heartbeat must be a real event) — on a healthy network promotion lands
// one RTT after open, before the first poll tick is even due.
//
// Framework-free on purpose (like buildBoardPages): the React wrapper lives
// in useBoardLive.ts. Timings are injectable so tests can run with real
// timers at millisecond scale.

export type BoardConn = "connecting" | "live" | "polling";

export interface BoardLiveTimings {
  /** Stream silence longer than this (e.g. 2+ missed 20s pings) = stalled. */
  stallMs: number;
  /** Snapshot refetch cadence while polling. */
  pollMs: number;
  /** Background SSE re-probe cadence while polling. */
  retryMs: number;
}

export const DEFAULT_BOARD_LIVE_TIMINGS: BoardLiveTimings = {
  stallMs: 45_000,
  pollMs: 5_000,
  retryMs: 30_000,
};

export interface BoardLiveHandle {
  close(): void;
}

export function startBoardLive(opts: {
  streamUrl: string;
  /** Real stream data arrived (event) or a poll tick is due. Debouncing and
   *  the actual fetch stay with the caller. */
  onEvent: () => void;
  onConn: (conn: BoardConn) => void;
  timings?: Partial<BoardLiveTimings>;
}): BoardLiveHandle {
  const t = { ...DEFAULT_BOARD_LIVE_TIMINGS, ...opts.timings };
  let source: EventSource | null = null;
  let lastActivity = 0;
  let closed = false;
  // Polling IS the initial mode (see header comment) — no callback fires for
  // it; callers initialize their UI to "polling".
  let conn: BoardConn = "polling";
  // True once the CURRENT stream has proven its body streams (first heartbeat
  // / data event). Reset per attempt; guards the one-shot promotion.
  let promoted = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;

  function setConn(next: BoardConn): void {
    if (conn === next) return;
    conn = next;
    opts.onConn(next);
  }
  function markActivity(): void {
    lastActivity = Date.now();
  }
  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  function startPolling(): void {
    stopPolling();
    pollTimer = setInterval(opts.onEvent, t.pollMs);
  }
  function clearProbe(): void {
    if (probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  }
  function scheduleProbe(): void {
    clearProbe();
    probeTimer = setTimeout(openStream, t.retryMs);
  }
  function closeStream(): void {
    if (source !== null) {
      try { source.close(); } catch { /* already closed */ }
      source = null;
    }
  }

  // Events from a stale (closed, replaced) source are ignored via the
  // `source !== es` guard — the probe cycle can overlap delivery of old ones.
  function openStream(): void {
    if (closed) return;
    clearProbe();
    closeStream();
    markActivity();
    promoted = false;
    let es: EventSource;
    try {
      es = new EventSource(opts.streamUrl, { withCredentials: true });
    } catch {
      // Constructor failure (bad URL etc.): serve from polls, keep probing.
      startPolling();
      setConn("polling");
      scheduleProbe();
      return;
    }
    source = es;
    // Fresh stream gets a full stall window; check at 1/3 granularity so the
    // worst-case detection latency is stallMs + stallMs/3.
    if (watchdog !== null) clearInterval(watchdog);
    watchdog = setInterval(checkStalled, Math.max(1, t.stallMs / 3));

    // Promotion = first PROOF that the response body streams. `onopen` fires
    // on headers alone — exactly what a black-holing proxy delivers — so it
    // must not stop the polling. The server pings immediately at stream
    // start, so on a healthy network promote() lands one RTT after open.
    function promote(): void {
      if (promoted) return;
      promoted = true;
      stopPolling();
      setConn("live");
    }
    es.onopen = () => {
      if (closed || source !== es) return;
      markActivity();
      // Catch-up refetch: events may have been missed while the stream was
      // down (the board SSE does no replay).
      opts.onEvent();
    };
    es.addEventListener("ping", () => {
      if (closed || source !== es) return;
      markActivity();
      promote();
    });
    for (const kind of ["agenda.changed", "board.spotlight"] as const) {
      es.addEventListener(kind, () => {
        if (closed || source !== es) return;
        markActivity();
        promote();
        opts.onEvent();
      });
    }
    es.onerror = () => {
      if (closed || source !== es) return;
      // Reconnection is OURS, not the native auto-retry: a network that
      // blocks SSE would otherwise be hammered with retries forever. Poll
      // immediately and re-probe on the slow cadence.
      closeStream();
      startPolling();
      setConn("polling");
      scheduleProbe();
    };
  }

  function checkStalled(): void {
    if (closed || source === null) return;
    if (Date.now() - lastActivity <= t.stallMs) return;
    // Stream accepted but silent — the corporate-proxy black hole. Keep the
    // wall updating via polls and probe for a healthy stream in the background.
    closeStream();
    startPolling();
    setConn("polling");
    scheduleProbe();
  }

  // Poll-first: serve the wall immediately, probe SSE in parallel. The
  // heartbeat (not `onopen`) decides when SSE takes over — see promote().
  startPolling();
  openStream();

  return {
    close(): void {
      closed = true;
      stopPolling();
      clearProbe();
      if (watchdog !== null) {
        clearInterval(watchdog);
        watchdog = null;
      }
      closeStream();
    },
  };
}
