// Unit tests for the worker-count decision. The pure function lives in
// cluster.ts; supervision/spawn behavior is not tested here since Bun.spawn
// is well-covered upstream and would need a real subprocess to exercise.

import { describe, test, expect } from "bun:test";
import {
  computeWorkerCount,
  readCgroupLimits,
  pipeLinesWithPrefix,
  type CgroupLimits,
  type LineSink,
} from "./cluster";

const unlimited: CgroupLimits = { cores: null, memoryBytes: null };
const MiB = 1024 * 1024;

describe("computeWorkerCount", () => {
  test("default (no WORKERS env) -> 1, single-process mode", () => {
    const d = computeWorkerCount({ setting: undefined, limits: unlimited });
    expect(d.count).toBe(1);
    expect(d.reason).toContain("single-process");
  });

  test("WORKERS=1 -> 1, single-process mode (back-compat)", () => {
    const d = computeWorkerCount({ setting: "1", limits: unlimited });
    expect(d.count).toBe(1);
    expect(d.reason).toContain("single-process");
  });

  test("manual integer is honored", () => {
    const d = computeWorkerCount({ setting: "4", limits: unlimited });
    expect(d.count).toBe(4);
    expect(d.reason).toContain("manual override");
  });

  test("manual integer is capped at HARD_CAP=8", () => {
    const d = computeWorkerCount({ setting: "20", limits: unlimited });
    expect(d.count).toBe(8);
    expect(d.reason).toContain("capped");
  });

  test("invalid WORKERS value falls back to 1", () => {
    const d = computeWorkerCount({ setting: "abc", limits: unlimited });
    expect(d.count).toBe(1);
    expect(d.reason).toContain("not a positive integer");
  });

  test("WORKERS=0 falls back to 1", () => {
    const d = computeWorkerCount({ setting: "0", limits: unlimited });
    expect(d.count).toBe(1);
  });

  test("auto with no cgroup info -> 1 (safe default outside containers)", () => {
    const d = computeWorkerCount({ setting: "auto", limits: unlimited });
    expect(d.count).toBe(1);
    expect(d.reason).toContain("no cgroup limits");
  });

  test("auto with 500m CPU + 512MiB memory -> 1 (CPU-bound)", () => {
    const d = computeWorkerCount({
      setting: "auto",
      limits: { cores: 0.5, memoryBytes: 512 * MiB },
    });
    // round(0.5) = 1 worker by CPU; 512/192 = 2 by mem; min = 1
    expect(d.count).toBe(1);
  });

  test("auto with 2000m CPU + 1GiB memory -> 2 workers", () => {
    const d = computeWorkerCount({
      setting: "auto",
      limits: { cores: 2, memoryBytes: 1024 * MiB },
    });
    // round(2) = 2 by CPU; floor(1024/192) = 5 by mem; min = 2
    expect(d.count).toBe(2);
  });

  test("auto with 4000m CPU + 1GiB memory -> 4 workers", () => {
    const d = computeWorkerCount({
      setting: "auto",
      limits: { cores: 4, memoryBytes: 1024 * MiB },
    });
    // round(4) = 4 by CPU; floor(1024/192) = 5 by mem; min = 4
    expect(d.count).toBe(4);
  });

  test("auto with 4000m CPU + 512MiB memory -> 2 (memory-bound)", () => {
    const d = computeWorkerCount({
      setting: "auto",
      limits: { cores: 4, memoryBytes: 512 * MiB },
    });
    // round(4) = 4 by CPU; floor(512/192) = 2 by mem; min = 2
    expect(d.count).toBe(2);
    expect(d.reason).toContain("mem=512MiB");
  });

  test("auto with 1500m CPU + 1GiB memory -> 2 (rounds up)", () => {
    const d = computeWorkerCount({
      setting: "auto",
      limits: { cores: 1.5, memoryBytes: 1024 * MiB },
    });
    // round(1.5) = 2 by CPU; floor(1024/192) = 5 by mem; min = 2
    expect(d.count).toBe(2);
  });

  test("auto with massive resources is capped at HARD_CAP=8", () => {
    const d = computeWorkerCount({
      setting: "auto",
      limits: { cores: 32, memoryBytes: 32 * 1024 * MiB },
    });
    expect(d.count).toBe(8);
    expect(d.reason).toContain("cap=8");
  });

  test("auto with unlimited CPU + bounded memory falls back to memory budget", () => {
    const d = computeWorkerCount({
      setting: "auto",
      limits: { cores: null, memoryBytes: 384 * MiB },
    });
    // No CPU info -> byCpu = HARD_CAP; mem 384/192 = 2; min = 2
    expect(d.count).toBe(2);
  });

  test("auto with bounded CPU + unlimited memory uses CPU budget", () => {
    const d = computeWorkerCount({
      setting: "auto",
      limits: { cores: 3, memoryBytes: null },
    });
    // round(3) = 3 by CPU; no mem info -> HARD_CAP; min = 3
    expect(d.count).toBe(3);
  });
});

describe("computeWorkerCount warnings (manual oversubscription)", () => {
  test("no warnings when WORKERS=1 regardless of resources", () => {
    const d = computeWorkerCount({ setting: "1", limits: { cores: 0.1, memoryBytes: 64 * MiB } });
    expect(d.warnings).toEqual([]);
  });

  test("no warnings on auto (auto already respects budgets)", () => {
    const d = computeWorkerCount({
      setting: "auto",
      limits: { cores: 0.5, memoryBytes: 256 * MiB },
    });
    expect(d.warnings).toEqual([]);
  });

  test("no warnings when no cgroup info is available (can't second-guess)", () => {
    const d = computeWorkerCount({ setting: "4", limits: unlimited });
    expect(d.count).toBe(4);
    expect(d.warnings).toEqual([]);
  });

  test("warns when manual count exceeds CPU budget", () => {
    // 1 core detected; user asked for 4 workers.
    const d = computeWorkerCount({
      setting: "4",
      limits: { cores: 1, memoryBytes: 4 * 1024 * MiB }, // plenty of mem
    });
    expect(d.count).toBe(4);
    expect(d.warnings.length).toBe(1);
    expect(d.warnings[0]).toContain("exceeds CPU budget");
    expect(d.warnings[0]).toContain("WORKERS=4");
  });

  test("warns when manual count exceeds memory budget", () => {
    // Plenty of CPU; only 384MiB memory => 2 worker baseline; user asked 4.
    const d = computeWorkerCount({
      setting: "4",
      limits: { cores: 16, memoryBytes: 384 * MiB },
    });
    expect(d.count).toBe(4);
    expect(d.warnings.length).toBe(1);
    expect(d.warnings[0]).toContain("exceeds memory budget");
    expect(d.warnings[0]).toContain("384MiB");
  });

  test("emits both warnings when both budgets are exceeded", () => {
    const d = computeWorkerCount({
      setting: "8",
      limits: { cores: 1, memoryBytes: 512 * MiB },
    });
    expect(d.count).toBe(8);
    expect(d.warnings.length).toBe(2);
    expect(d.warnings.some((w) => w.includes("CPU budget"))).toBe(true);
    expect(d.warnings.some((w) => w.includes("memory budget"))).toBe(true);
  });

  test("no warning when manual count matches the auto budget exactly", () => {
    // round(2) = 2 by CPU; 2GiB/192 = 10 by mem; user picks 2 = no oversub.
    const d = computeWorkerCount({
      setting: "2",
      limits: { cores: 2, memoryBytes: 2 * 1024 * MiB },
    });
    expect(d.count).toBe(2);
    expect(d.warnings).toEqual([]);
  });
});

describe("readCgroupLimits (parser, with injected reader)", () => {
  test("parses cgroup v2 cpu.max + memory.max", () => {
    const fake = (p: string) => {
      if (p === "/sys/fs/cgroup/cpu.max") return "200000 100000\n";
      if (p === "/sys/fs/cgroup/memory.max") return "1073741824\n";
      throw new Error("missing " + p);
    };
    const r = readCgroupLimits(fake);
    expect(r.cores).toBeCloseTo(2);
    expect(r.memoryBytes).toBe(1024 * MiB);
  });

  test("cgroup v2 with `max` quota yields null cores", () => {
    const fake = (p: string) => {
      if (p === "/sys/fs/cgroup/cpu.max") return "max 100000\n";
      if (p === "/sys/fs/cgroup/memory.max") return "max\n";
      throw new Error("missing " + p);
    };
    const r = readCgroupLimits(fake);
    expect(r.cores).toBeNull();
    expect(r.memoryBytes).toBeNull();
  });

  test("falls through to cgroup v1 when v2 unavailable", () => {
    const fake = (p: string) => {
      if (p.startsWith("/sys/fs/cgroup/cpu.max")) throw new Error("ENOENT");
      if (p.startsWith("/sys/fs/cgroup/memory.max")) throw new Error("ENOENT");
      if (p === "/sys/fs/cgroup/cpu/cpu.cfs_quota_us") return "400000\n";
      if (p === "/sys/fs/cgroup/cpu/cpu.cfs_period_us") return "100000\n";
      if (p === "/sys/fs/cgroup/memory/memory.limit_in_bytes") return String(2 * 1024 * MiB) + "\n";
      throw new Error("missing " + p);
    };
    const r = readCgroupLimits(fake);
    expect(r.cores).toBeCloseTo(4);
    expect(r.memoryBytes).toBe(2 * 1024 * MiB);
  });

  test("cgroup v1 unlimited cpu (-1) yields null cores", () => {
    const fake = (p: string) => {
      if (p.startsWith("/sys/fs/cgroup/cpu.max")) throw new Error("ENOENT");
      if (p.startsWith("/sys/fs/cgroup/memory.max")) throw new Error("ENOENT");
      if (p === "/sys/fs/cgroup/cpu/cpu.cfs_quota_us") return "-1\n";
      if (p === "/sys/fs/cgroup/cpu/cpu.cfs_period_us") return "100000\n";
      if (p === "/sys/fs/cgroup/memory/memory.limit_in_bytes") return "9223372036854771712\n";
      throw new Error("missing " + p);
    };
    const r = readCgroupLimits(fake);
    expect(r.cores).toBeNull();
    expect(r.memoryBytes).toBeNull();
  });

  test("returns nulls when neither cgroup version is accessible", () => {
    const fake = (_p: string) => { throw new Error("ENOENT"); };
    const r = readCgroupLimits(fake);
    expect(r.cores).toBeNull();
    expect(r.memoryBytes).toBeNull();
  });
});

// Helper for the stream tests below. Creates a ReadableStream that emits
// `chunks` in order, encoded as UTF-8 bytes.
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function makeSink(): LineSink & { captured: string[] } {
  const captured: string[] = [];
  return {
    captured,
    write(chunk: string) {
      captured.push(chunk);
      return true;
    },
  };
}

describe("pipeLinesWithPrefix", () => {
  test("prefixes each complete line and preserves order", async () => {
    const sink = makeSink();
    await pipeLinesWithPrefix(streamOf("alpha\nbeta\ngamma\n"), sink, "[w2] ");
    expect(sink.captured).toEqual([
      "[w2] alpha\n",
      "[w2] beta\n",
      "[w2] gamma\n",
    ]);
  });

  test("joins partial lines across chunk boundaries", async () => {
    const sink = makeSink();
    await pipeLinesWithPrefix(streamOf("hel", "lo wor", "ld\nnext\n"), sink, "[w0] ");
    expect(sink.captured).toEqual([
      "[w0] hello world\n",
      "[w0] next\n",
    ]);
  });

  test("flushes a trailing non-terminated chunk on stream close", async () => {
    const sink = makeSink();
    await pipeLinesWithPrefix(streamOf("done\nno-newline-here"), sink, "[w1] ");
    expect(sink.captured).toEqual([
      "[w1] done\n",
      "[w1] no-newline-here\n",
    ]);
  });

  test("emits nothing for an empty stream", async () => {
    const sink = makeSink();
    await pipeLinesWithPrefix(streamOf(), sink, "[w0] ");
    expect(sink.captured).toEqual([]);
  });

  test("handles a null stream as a no-op", async () => {
    const sink = makeSink();
    await pipeLinesWithPrefix(null, sink, "[w0] ");
    expect(sink.captured).toEqual([]);
  });

  test("preserves multi-byte UTF-8 across chunk splits", async () => {
    // The em-dash bytes (0xE2 0x80 0x94) are split across two chunks.
    const sink = makeSink();
    const enc = new TextEncoder();
    const bytes = enc.encode("a — b\n");
    const split = Math.floor(bytes.byteLength / 2);
    const left = new Uint8Array(bytes.buffer, 0, split);
    const right = new Uint8Array(bytes.buffer, split);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(left);
        controller.enqueue(right);
        controller.close();
      },
    });
    await pipeLinesWithPrefix(stream, sink, "[w0] ");
    expect(sink.captured).toEqual(["[w0] a — b\n"]);
  });
});
