// Sweep the load test across multiple container configurations. For each
// (workers, cpu, memory) tuple in the matrix, spins up a fresh Docker
// container of the project's image, waits for /api/health, runs the same
// load logic that scripts/loadtest.ts uses, then tears the container down
// and moves on. Prints a comparison table at the end so operators can pick
// the cheapest config that meets their target attendee count.
//
// Requires: docker (or a `docker`-aliased podman) on PATH, and the project
// builds cleanly with `docker build .`. No teardown of leftover state —
// each iteration starts from a fresh container with an ephemeral DB.
//
// Usage:
//   bun run loadtest:sweep                                       # default matrix
//   bun run loadtest:sweep -- --users 200 --duration 30s
//   bun run loadtest:sweep -- --configs "1@0.5/512m 4@2/2g"
//   bun run loadtest:sweep -- --image simple-unconference:dev --no-build

import {
  bootstrap, runVU, summarize, fmtMs,
  CONF_SLUG, type Sample, type Summary,
} from "./loadtest";

interface SweepConfig {
  workers: string;   // "auto" | "<N>"
  cpus: number;      // docker --cpus
  memoryMB: number;  // docker --memory in megabytes
}

interface SweepArgs {
  image: string;
  build: boolean;
  port: number;
  users: number;
  durationMs: number;
  thinkMs: number;
  configs: SweepConfig[];
}

const DEFAULT_CONFIGS: SweepConfig[] = [
  { workers: "1", cpus: 0.5, memoryMB: 512 },   // chart default
  { workers: "1", cpus: 1.0, memoryMB: 512 },
  { workers: "2", cpus: 1.0, memoryMB: 1024 },
  { workers: "2", cpus: 2.0, memoryMB: 1024 },
  { workers: "4", cpus: 2.0, memoryMB: 1024 },
  { workers: "4", cpus: 4.0, memoryMB: 2048 },
];

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m)?$/);
  if (!m) return Number(s) * 1000;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return unit === "ms" ? n : unit === "m" ? n * 60_000 : n * 1000;
}

// Memory string parser: 512m / 1g / 1024 (bytes interpreted as MB).
function parseMemoryMB(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)([mg]i?)?$/i);
  if (!m) throw new Error(`invalid memory: ${s}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  return unit.startsWith("g") ? Math.round(n * 1024) : Math.round(n);
}

// Config string: "<workers>@<cpus>/<memory>"  e.g. "4@2/1g" or "auto@0.5/512m"
function parseConfigSpec(spec: string): SweepConfig {
  const m = spec.match(/^([^@]+)@([0-9.]+)\/(.+)$/);
  if (!m) throw new Error(`bad config "${spec}", expected <workers>@<cpus>/<memory>`);
  return {
    workers: m[1]!,
    cpus: Number(m[2]),
    memoryMB: parseMemoryMB(m[3]!),
  };
}

function parseArgs(argv: string[]): SweepArgs {
  const out: SweepArgs = {
    image: "simple-unconference:loadtest",
    build: true,
    port: 3001,
    users: 50,
    durationMs: 30_000,
    thinkMs: 0,
    configs: DEFAULT_CONFIGS,
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--image") out.image = need(++i, a);
    else if (a === "--no-build") out.build = false;
    else if (a === "--port") out.port = Number(need(++i, a));
    else if (a === "--users" || a === "-u") out.users = Number(need(++i, a));
    else if (a === "--duration" || a === "-d") out.durationMs = parseDuration(need(++i, a));
    else if (a === "--think-ms") out.thinkMs = Number(need(++i, a));
    else if (a === "--configs") out.configs = need(++i, a).split(/\s+/).filter(Boolean).map(parseConfigSpec);
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (out.configs.length === 0) throw new Error("no configs to sweep");
  return out;
}

function printHelp() {
  console.log(`Usage: bun run loadtest:sweep -- [options]

  --image <tag>         Docker image tag (default: simple-unconference:loadtest)
  --no-build            Skip 'docker build' (use an existing --image)
  --port <n>            Host port to bind the container (default: 3001)
  --users <n>, -u       Concurrent VUs per config (default: 50)
  --duration <t>, -d    Run per config (default: 30s)
  --think-ms <n>        Per-VU pause (default: 0)
  --configs "..."       Space-separated specs <workers>@<cpus>/<memory>.
                        Example: --configs "1@0.5/512m 4@2/2g"
  --help, -h            Show this help
`);
}

// ---------- docker glue ----------

async function buildImage(tag: string): Promise<void> {
  console.log(`[sweep] docker build -t ${tag} .`);
  const proc = Bun.spawn({
    cmd: ["docker", "build", "-t", tag, "."],
    stdio: ["inherit", "inherit", "inherit"],
  });
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`docker build failed (exit ${proc.exitCode})`);
}

async function dockerRun(args: { image: string; port: number; cfg: SweepConfig }): Promise<string> {
  const cmd = [
    "docker", "run", "-d", "--rm",
    "-p", `${args.port}:3000`,
    "--cpus", String(args.cfg.cpus),
    "--memory", `${args.cfg.memoryMB}m`,
    "-e", `WORKERS=${args.cfg.workers}`,
    args.image,
  ];
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`docker run failed: ${err.trim()}`);
  }
  return (await new Response(proc.stdout).text()).trim();
}

async function dockerStop(containerId: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["docker", "stop", "-t", "5", containerId],
    stdout: "ignore", stderr: "ignore",
  });
  await proc.exited;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`container never became healthy: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

// ---------- single iteration ----------

interface IterationResult {
  cfg: SweepConfig;
  summary: Summary | null;
  error?: string;
}

async function runOne(args: SweepArgs, cfg: SweepConfig): Promise<IterationResult> {
  const label = configLabel(cfg);
  console.log(`\n[sweep] === ${label} ===`);

  let containerId: string | null = null;
  try {
    containerId = await dockerRun({ image: args.image, port: args.port, cfg });
    currentContainerId = containerId;
    console.log(`[sweep] container ${containerId.slice(0, 12)} starting; polling /api/health`);
    const baseUrl = `http://localhost:${args.port}`;
    await waitForHealth(baseUrl, 60_000);
    console.log(`[sweep] healthy; bootstrapping`);

    const { rpc } = await bootstrap(baseUrl);
    console.log(`[sweep] running ${args.users} VU(s) for ${fmtMs(args.durationMs)}`);

    const samples: Sample[] = [];
    const deadline = Date.now() + args.durationMs;
    const start = performance.now();
    await Promise.all(
      Array.from({ length: args.users }, () => runVU(rpc, CONF_SLUG, deadline, args.thinkMs, samples)),
    );
    const elapsed = performance.now() - start;
    const summary = summarize(samples, elapsed);
    console.log(`[sweep] ${summary.throughputRps.toFixed(0)} req/s   P95 ${fmtMs(summary.p95)}   ${summary.verdict}`);
    return { cfg, summary };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[sweep] failed: ${msg}`);
    return { cfg, summary: null, error: msg };
  } finally {
    if (containerId) {
      try { await dockerStop(containerId); } catch { /* already gone */ }
      currentContainerId = null;
    }
  }
}

function configLabel(c: SweepConfig): string {
  const mem = c.memoryMB >= 1024 ? `${(c.memoryMB / 1024).toFixed(c.memoryMB % 1024 === 0 ? 0 : 1)}Gi` : `${c.memoryMB}Mi`;
  return `${c.workers}w / ${c.cpus}c / ${mem}`;
}

// ---------- comparison report ----------

function printComparison(results: IterationResult[]) {
  console.log("\n=== Sweep results ===");
  console.log("  config                  thrpt    P50      P95      P99     err   state        users");
  let bestIdx = -1;
  let bestThrpt = -1;
  results.forEach((r, i) => {
    if (r.summary && r.summary.verdict !== "OVERLOADED" && r.summary.throughputRps > bestThrpt) {
      bestThrpt = r.summary.throughputRps;
      bestIdx = i;
    }
  });

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const label = configLabel(r.cfg).padEnd(22);
    if (!r.summary) {
      console.log(`  ${label}  FAILED  (${r.error ?? "unknown"})`);
      continue;
    }
    const s = r.summary;
    const marker = i === bestIdx ? "*" : " ";
    console.log(
      `${marker} ${label}  ${s.throughputRps.toFixed(0).padStart(5)}r/s ` +
        `${fmtMs(s.p50).padStart(6)}  ${fmtMs(s.p95).padStart(7)}  ${fmtMs(s.p99).padStart(7)}  ` +
        `${(s.errorRate * 100).toFixed(1).padStart(4)}%  ${s.verdict.padEnd(11)}  ~${s.estimatedActiveUsers}`,
    );
  }

  if (bestIdx >= 0) {
    const best = results[bestIdx]!.summary!;
    console.log(
      `\nBest (non-overloaded): ${configLabel(results[bestIdx]!.cfg)} -> ` +
        `${best.throughputRps.toFixed(0)} req/s, ~${best.estimatedActiveUsers} active users`,
    );
  } else {
    console.log("\nNo healthy/stressed config in this matrix. Try bigger resources or fewer VUs.");
  }
  console.log(
    `\nNote: active-user estimates assume ~0.5 req/s per attendee (NotificationBell\n` +
      `polls + light interactive traffic). Adjust for your expected event pattern.`,
  );
}

// ---------- main with SIGINT cleanup ----------

let currentContainerId: string | null = null;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  process.on("SIGINT", async () => {
    console.error("\n[sweep] interrupted; stopping container...");
    if (currentContainerId) {
      try { await dockerStop(currentContainerId); } catch { /* ignore */ }
    }
    process.exit(130);
  });

  if (args.build) await buildImage(args.image);
  else console.log(`[sweep] reusing image ${args.image} (--no-build)`);

  console.log(`[sweep] sweeping ${args.configs.length} config(s); ${args.users} VU(s) x ${fmtMs(args.durationMs)} each`);
  const results: IterationResult[] = [];
  for (const cfg of args.configs) {
    results.push(await runOne(args, cfg));
  }

  printComparison(results);
}

main().catch((e) => {
  console.error("[sweep] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
