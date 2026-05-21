// Multi-worker launcher. Picked by the Dockerfile CMD; not used in `bun dev`.
//
// One pod runs N Bun processes that share the listening port via
// SO_REUSEPORT (set in `startServer()`). The kernel load-balances new
// connections across them. Each worker has its own Prisma client + libsql
// connection; SQLite WAL serializes writes across processes at the file
// layer, so this fans out reads + I/O-bound work without breaking
// correctness, but doesn't multiply write throughput.
//
// Modes (WORKERS env var):
//   ""/"1"  -> single in-process server (no fork, byte-identical to v0.3)
//   "auto"  -> derive count from container CPU + memory limits (cgroup v2/v1)
//   "<N>"   -> force exactly N (clamped to HARD_CAP)
//
// Migration safety: `prisma migrate deploy` MUST be done once before this
// runs. The Dockerfile chains it via `&& exec`, so the launcher never sees
// an un-migrated DB. Do not move migrations into the workers.

import { readFileSync } from "node:fs";

const HARD_CAP = 8;
const PER_WORKER_MIB = 192;
const RESTART_DELAY_MS = 1000;
// Crash-loop guard: if a single worker dies this many times within the
// window, the launcher exits so Kubernetes surfaces CrashLoopBackOff
// instead of us silently respawning forever.
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 30_000;
// How long to give workers after SIGTERM before SIGKILL. K8s default
// terminationGracePeriodSeconds is 30s, so 10s leaves comfortable margin.
const SHUTDOWN_GRACE_MS = 10_000;

export interface CgroupLimits {
  cores: number | null;        // null = no limit detected
  memoryBytes: number | null;  // null = no limit detected
}

// Reads cgroup-reported limits. Returns nulls when running outside a
// container or when the cgroupfs isn't mounted (mac/dev shell).
export function readCgroupLimits(
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): CgroupLimits {
  // cgroup v2 (modern default: K8s 1.25+, K3s on Ubuntu 22.04+/RHEL 9+).
  try {
    const cpuMax = read("/sys/fs/cgroup/cpu.max").trim();
    const memMax = read("/sys/fs/cgroup/memory.max").trim();
    const [quotaStr, periodStr] = cpuMax.split(/\s+/);
    const cores = quotaStr === "max" ? null : Number(quotaStr) / Number(periodStr);
    const memoryBytes = memMax === "max" ? null : Number(memMax);
    if (
      (cores === null || Number.isFinite(cores)) &&
      (memoryBytes === null || Number.isFinite(memoryBytes))
    ) {
      return { cores, memoryBytes };
    }
  } catch {
    // fall through to v1
  }

  // cgroup v1.
  try {
    const quota = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").trim());
    const period = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us").trim());
    const cores = quota === -1 || !Number.isFinite(quota) ? null : quota / period;
    const memRaw = Number(read("/sys/fs/cgroup/memory/memory.limit_in_bytes").trim());
    // v1 returns a giant sentinel (~9.22e18) when memory is unlimited.
    const memoryBytes =
      !Number.isFinite(memRaw) || memRaw > Number.MAX_SAFE_INTEGER / 2 ? null : memRaw;
    return { cores, memoryBytes };
  } catch {
    return { cores: null, memoryBytes: null };
  }
}

export interface WorkerCountInput {
  setting: string | undefined;  // raw WORKERS env value
  limits: CgroupLimits;
}

export interface WorkerCountDecision {
  count: number;
  reason: string;
}

// Decides how many workers to spawn. Pure — call from tests with synthetic
// limits to verify the rule.
export function computeWorkerCount(input: WorkerCountInput): WorkerCountDecision {
  const raw = (input.setting ?? "").trim();
  if (raw === "" || raw === "1") {
    return { count: 1, reason: "single-process mode (WORKERS=1)" };
  }

  if (raw.toLowerCase() !== "auto") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      return { count: 1, reason: `WORKERS="${raw}" is not a positive integer; using 1` };
    }
    const capped = Math.min(n, HARD_CAP);
    const note = capped < n ? ` (capped from ${n} to HARD_CAP=${HARD_CAP})` : "";
    return { count: capped, reason: `manual override (WORKERS=${n})${note}` };
  }

  // auto
  const { cores, memoryBytes } = input.limits;
  if (cores === null && memoryBytes === null) {
    return { count: 1, reason: "WORKERS=auto but no cgroup limits detected; using 1" };
  }
  const byCpu = cores === null ? HARD_CAP : Math.max(1, Math.round(cores));
  const memMiB = memoryBytes === null ? null : memoryBytes / (1024 * 1024);
  const byMem = memMiB === null ? HARD_CAP : Math.max(1, Math.floor(memMiB / PER_WORKER_MIB));
  const count = Math.min(byCpu, byMem, HARD_CAP);
  const cpuStr = cores === null ? "unlimited" : `${cores.toFixed(2)} core(s)`;
  const memStr = memMiB === null ? "unlimited" : `${Math.round(memMiB)}MiB`;
  return {
    count,
    reason: `auto: cpu=${cpuStr} (->${byCpu}) mem=${memStr} (->${byMem}@${PER_WORKER_MIB}MiB/w) cap=${HARD_CAP}`,
  };
}

interface SupervisedWorker {
  id: number;
  proc: ReturnType<typeof Bun.spawn>;
  restartTimestamps: number[];
}

// Sink that pipeLinesWithPrefix writes prefixed lines into. Matches the
// shape of `process.stdout` / `process.stderr` minimally for testability.
export interface LineSink {
  write(chunk: string): unknown;
}

// Reads a child stream chunk-by-chunk and writes complete lines to `sink`
// with `prefix` prepended. Buffers partial lines across chunks. Flushes
// any trailing non-terminated content when the stream closes so nothing
// is lost on worker exit. Exported for unit testing.
export async function pipeLinesWithPrefix(
  stream: ReadableStream<Uint8Array> | null | undefined,
  sink: LineSink,
  prefix: string,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) buffer += decoder.decode(value, { stream: true });
      if (done) {
        // Final decode flushes any incomplete multi-byte sequence.
        buffer += decoder.decode();
        if (buffer.length > 0) sink.write(`${prefix}${buffer}\n`);
        return;
      }
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        sink.write(`${prefix}${line}\n`);
        nl = buffer.indexOf("\n");
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

async function runCluster(count: number): Promise<void> {
  const workers = new Map<number, SupervisedWorker>();
  let shuttingDown = false;
  let bailout = false;

  function spawnWorker(id: number, prevRestarts: number[] = []): SupervisedWorker {
    const prefix = `[w${id}] `;
    const proc = Bun.spawn({
      cmd: ["bun", "src/server/index.ts"],
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, WORKER_ID: String(id) },
      onExit: (_proc, exitCode, signalCode) => {
        const w = workers.get(id);
        if (!w) return;
        workers.delete(id);
        if (shuttingDown) return;
        console.error(
          `[cluster] worker ${id} exited (code=${exitCode} signal=${signalCode}); restarting in ${RESTART_DELAY_MS}ms`,
        );

        const now = Date.now();
        const recent = w.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
        recent.push(now);
        if (recent.length >= MAX_RESTARTS) {
          console.error(
            `[cluster] worker ${id} crashed ${recent.length} times within ${RESTART_WINDOW_MS}ms; bailing out so Kubernetes can restart the pod`,
          );
          bailout = true;
          shutdown("SIGTERM");
          return;
        }
        setTimeout(() => {
          if (shuttingDown) return;
          workers.set(id, spawnWorker(id, recent));
        }, RESTART_DELAY_MS);
      },
    });
    void pipeLinesWithPrefix(
      proc.stdout as ReadableStream<Uint8Array> | null,
      process.stdout,
      prefix,
    );
    void pipeLinesWithPrefix(
      proc.stderr as ReadableStream<Uint8Array> | null,
      process.stderr,
      prefix,
    );
    return { id, proc, restartTimestamps: prevRestarts };
  }

  function shutdown(signal: "SIGTERM" | "SIGINT") {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[cluster] received ${signal}; stopping ${workers.size} worker(s)`);
    for (const { proc } of workers.values()) {
      try { proc.kill(signal); } catch { /* already dead */ }
    }
    setTimeout(() => {
      for (const { proc } of workers.values()) {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }
      process.exit(bailout ? 1 : 0);
    }, SHUTDOWN_GRACE_MS);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  for (let i = 0; i < count; i++) {
    workers.set(i, spawnWorker(i));
  }
  console.log(`[cluster] spawned ${count} worker(s)`);
}

async function main(): Promise<void> {
  const limits = readCgroupLimits();
  const decision = computeWorkerCount({ setting: process.env.WORKERS, limits });
  console.log(`[cluster] WORKERS=${process.env.WORKERS ?? "<unset>"} -> ${decision.count} (${decision.reason})`);

  if (decision.count === 1) {
    // Skip fork: import + call directly so there's no extra process.
    const { startServer } = await import("./index");
    startServer();
    return;
  }
  await runCluster(decision.count);
}

if (import.meta.main) {
  void main();
}
