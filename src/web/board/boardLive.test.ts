// Unit tests for the board stream monitor's polling fallback (boardLive.ts).
// Runs against a stubbed EventSource with REAL timers at millisecond scale —
// the timings are injectable exactly so this doesn't need fake clocks.

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

// Millisecond-scale stand-ins for 45s/10s/30s. Margins below stay ≥1.5× the
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

test("open alone doesn't promote; the first heartbeat does", async () => {
  const events: BoardConn[] = [];
  let fetches = 0;
  const handle = start(() => { fetches++; }, (c) => events.push(c));
  const es = FakeEventSource.instances[0]!;

  es.open();
  // Headers arrived — but that's exactly what a black-holing proxy delivers.
  // The catch-up refetch still runs.
  expect(events).toEqual([]);
  expect(fetches).toBe(1);

  es.emit("ping");
  expect(events).toEqual(["live"]); // body proven, promotion fires once
  expect(fetches).toBe(1); // heartbeat ≠ data

  es.emit("agenda.changed");
  es.emit("board.spotlight");
  es.emit("ping");
  expect(fetches).toBe(3);
  expect(events).toEqual(["live"]);

  handle.close();
});

test("silent stream falls back to polling, then a healthy probe restores SSE", async () => {
  const events: BoardConn[] = [];
  let fetches = 0;
  start(() => { fetches++; }, (c) => events.push(c));
  // Never open the first stream — pure stall (no error, no pings). Fall-back
  // lands somewhere in [stallMs, stallMs + stallMs/3 + slack].
  await sleep(TIMINGS.stallMs + 80);

  expect(events).toContain("polling");
  expect(FakeEventSource.instances[0]!.closed).toBe(true);
  const atFallback = fetches;
  expect(atFallback).toBeGreaterThanOrEqual(1);

  // Poll cadence: more ticks arrive while still polling.
  await sleep(TIMINGS.pollMs * 3);
  expect(fetches).toBeGreaterThan(atFallback);

  // The background probe re-opens; promotion needs its heartbeat, then
  // polling stops. (A stale unopened probe re-probes on its own stall clock,
  // so grab whichever instance is newest at that moment.)
  await waitFor(() => FakeEventSource.instances.length >= 2, 1_000);
  FakeEventSource.instances[FakeEventSource.instances.length - 1]!.open();
  FakeEventSource.instances[FakeEventSource.instances.length - 1]!.emit("ping");
  expect(events).toContain("live");

  const afterLive = fetches;
  await sleep(TIMINGS.pollMs * 4);
  expect(fetches).toBe(afterLive); // polling stopped
});

test("onerror demotes to polling; an opened-but-silent probe keeps polling; heartbeat heals", async () => {
  const events: BoardConn[] = [];
  let fetches = 0;
  start(() => { fetches++; }, (c) => events.push(c));
  FakeEventSource.instances[0]!.error();

  expect(events).toContain("polling");
  await waitFor(() => FakeEventSource.instances.length >= 2, 1_000);
  // The probe "connects" (headers arrive — the proxy scenario)…
  FakeEventSource.instances[FakeEventSource.instances.length - 1]!.open();
  expect(events).not.toContain("live");
  // …and polling keeps the wall fresh while no heartbeat shows up.
  await sleep(TIMINGS.pollMs * 3);
  expect(fetches).toBeGreaterThanOrEqual(1);
  const beforeHeal = fetches;

  // First heartbeat over that stream = proof → live, polling stops.
  FakeEventSource.instances[FakeEventSource.instances.length - 1]!.emit("ping");
  expect(events[events.length - 1]).toBe("live");
  await sleep(TIMINGS.pollMs * 4);
  expect(fetches).toBe(beforeHeal);
});

test("close() detaches everything: no fetches, no probes, stream closed", async () => {
  let fetches = 0;
  const handle = start(() => { fetches++; }, () => {});
  const es = FakeEventSource.instances[0]!;
  es.error(); // schedules a probe + polling
  handle.close();

  es.emit("agenda.changed");
  es.open();
  await sleep(TIMINGS.retryMs + TIMINGS.pollMs * 4);
  expect(fetches).toBe(0);
  expect(FakeEventSource.instances.length).toBe(1); // probe cancelled
});
