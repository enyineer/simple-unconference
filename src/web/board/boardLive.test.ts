// Unit tests for the board stream monitor's poll-first SSE promotion
// (boardLive.ts). Runs against a stubbed EventSource with REAL timers at
// millisecond scale — the timings are injectable exactly so this doesn't
// need fake clocks.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { startBoardLive, type BoardConn, type BoardLiveHandle } from "./boardLive";

class FakeEventSource {
  // Every instance ever constructed, in order — the probe cycle creates new
  // ones and the tests assert on that.
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, (() => void)[]>();

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(kind: string, handler: () => void): void {
    const list = this.listeners.get(kind) ?? [];
    list.push(handler);
    this.listeners.set(kind, list);
  }

  close(): void {
    this.closed = true;
  }

  // Test-side triggers for whatever the server would deliver.
  open(): void {
    this.onopen?.();
  }
  error(): void {
    this.onerror?.();
  }
  emit(kind: string): void {
    for (const h of this.listeners.get(kind) ?? []) h();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Real-timers wait: poll a condition instead of guessing a total sleep, since
// a stale unopened probe re-probes on its own stall clock (by design) and
// instance counts keep moving underneath a fixed sleep.
async function waitFor(cond: () => boolean, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!cond() && Date.now() < deadline) await sleep(10);
}

// Millisecond-scale stand-ins for 45s/5s/30s. Margins below stay ≥1.5× the
// relevant constant so the real-timer tests don't flake.
const TIMINGS = { stallMs: 100, pollMs: 25, retryMs: 60 };

// Monitors from a failed test must not leak timers into later tests
// (an assertion throw skips an inline close()).
const handles: BoardLiveHandle[] = [];

// globalThis.EventSource doesn't exist in bun (or may in newer Bun) — the
// save/restore guard handles both; restoring with the literal string
// "undefined" would poison later suites (see CLAUDE.md gotcha).
let prevES: unknown;

beforeEach(() => {
  prevES = (globalThis as unknown as Record<string, unknown>).EventSource;
  (globalThis as unknown as Record<string, unknown>).EventSource = FakeEventSource;
  FakeEventSource.instances = [];
});

afterEach(() => {
  for (const h of handles) h.close();
  handles.length = 0;
  if (prevES === undefined) delete (globalThis as unknown as Record<string, unknown>).EventSource;
  else (globalThis as unknown as Record<string, unknown>).EventSource = prevES;
});

function start(onEvent: () => void, onConn: (c: BoardConn) => void): BoardLiveHandle {
  const handle = startBoardLive({
    streamUrl: "https://board.example/api/board/x/stream?t=t",
    onEvent,
    onConn,
    timings: TIMINGS,
  });
  handles.push(handle);
  return handle;
}

test("polls immediately, without any SSE activity", async () => {
  let fetches = 0;
  const handle = start(() => { fetches++; }, () => {});
  // No open, no ping, no error — pure black hole. Polling still runs.
  await sleep(TIMINGS.pollMs * 3);
  expect(fetches).toBeGreaterThanOrEqual(2);
  handle.close();
});

test("heartbeat over the stream promotes to live and stops polling", async () => {
  const events: BoardConn[] = [];
  let fetches = 0;
  const handle = start(() => { fetches++; }, (c) => events.push(c));
  const es = FakeEventSource.instances[0]!;

  es.open();
  // Headers arrived — but that's exactly what a black-holing proxy delivers.
  // The catch-up refetch still runs, promotion does not.
  expect(events).toEqual([]);
  const afterOpen = fetches;
  expect(afterOpen).toBeGreaterThanOrEqual(1); // catch-up refetch

  es.emit("ping");
  expect(events).toEqual(["live"]); // body proven, promotion fires once
  es.emit("ping");
  es.emit("agenda.changed");
  es.emit("board.spotlight");
  expect(events).toEqual(["live"]); // promote() is one-shot

  const afterLive = fetches;
  await sleep(TIMINGS.pollMs * 4);
  expect(fetches).toBe(afterLive); // polling stopped, nothing else refetches

  handle.close();
});

test("a silent stream never disturbs polling; the watchdog recycles it and probes", async () => {
  const events: BoardConn[] = [];
  let fetches = 0;
  start(() => { fetches++; }, (c) => events.push(c));
  // Stream 1 never opens/pings — the black-holed probe. Polling continues.
  await sleep(TIMINGS.stallMs + 80);
  expect(events).toEqual([]); // never live, never "connecting"
  expect(FakeEventSource.instances[0]!.closed).toBe(true); // watchdog recycled
  const count1 = fetches;

  await waitFor(() => FakeEventSource.instances.length >= 2, 1_000);
  const probe = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  probe.open(); // headers only — the proxy scenario
  expect(events).toEqual([]);
  await sleep(TIMINGS.pollMs * 3);
  expect(fetches).toBeGreaterThan(count1); // still serving from polls

  const before = fetches;
  probe.emit("ping"); // finally, proof
  expect(events).toEqual(["live"]);
  await sleep(TIMINGS.pollMs * 4);
  expect(fetches).toBe(before); // polling stopped
});

test("onerror keeps polling and the probe cadence continues", async () => {
  const events: BoardConn[] = [];
  let fetches = 0;
  start(() => { fetches++; }, (c) => events.push(c));
  FakeEventSource.instances[0]!.error();

  expect(events).toEqual([]); // stays in the default polling state
  const atError = fetches;
  await sleep(TIMINGS.pollMs * 3);
  expect(fetches).toBeGreaterThan(atError);

  await waitFor(() => FakeEventSource.instances.length >= 2, 1_000);
  FakeEventSource.instances[FakeEventSource.instances.length - 1]!.emit("ping");
  expect(events).toEqual(["live"]);
});

test("close() detaches everything: no fetches, no probes, stream closed", async () => {
  let fetches = 0;
  const handle = start(() => { fetches++; }, () => {});
  const es = FakeEventSource.instances[0]!;
  es.error(); // schedules a probe + (re)starts polling
  handle.close(); // synchronous: stops polling, cancels the probe

  es.emit("agenda.changed");
  es.open();
  await sleep(TIMINGS.pollMs * 4 + TIMINGS.retryMs);
  expect(fetches).toBe(0); // closed before the first tick was due
  expect(FakeEventSource.instances.length).toBe(1); // probe cancelled
});
