// Self-contained load-test runner for a simple-unconference instance.
//
// Bootstraps a minimal scenario (one owner, one conference, a few published
// sessions) and hammers read paths with `--users` concurrent virtual users
// for `--duration` seconds. Prints per-endpoint latency stats plus a
// capacity recommendation derived from the observed throughput/latency.
//
// Idempotent: re-runs reuse the same owner + conference + sessions if they
// already exist. No teardown — leftover data is harmless and lets you
// compare runs against the same baseline.
//
// Usage:
//   bun run loadtest                                    # defaults
//   bun run loadtest -- --base https://unconf.you.dev   # remote target
//   bun run loadtest -- --users 200 --duration 60s
//
// Defaults: 50 users, 30s, http://localhost:3000.

import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../src/server/rpc";

export const OWNER_EMAIL = "loadtest-owner@simple-unconference.invalid";
export const OWNER_PASSWORD = "loadtest-secret-do-not-reuse";
export const CONF_NAME = "Loadtest Conference";
export const CONF_SLUG = "loadtest-conference";
export const TARGET_SESSIONS = 8;

interface Args {
  base: string;
  users: number;
  durationMs: number;
  thinkMs: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { base: "http://localhost:3000", users: 50, durationMs: 30_000, thinkMs: 0 };
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = need(++i, a);
    else if (a === "--users" || a === "-u") out.users = Number(need(++i, a));
    else if (a === "--duration" || a === "-d") out.durationMs = parseDuration(need(++i, a));
    else if (a === "--think-ms") out.thinkMs = Number(need(++i, a));
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!Number.isFinite(out.users) || out.users < 1) throw new Error("--users must be >= 1");
  if (!Number.isFinite(out.durationMs) || out.durationMs < 1000) throw new Error("--duration must be >= 1s");
  return out;
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m)?$/);
  if (!m) return Number(s) * 1000;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return unit === "ms" ? n : unit === "m" ? n * 60_000 : n * 1000;
}

function printHelp() {
  console.log(`Usage: bun run loadtest -- [options]

  --base <url>          Target instance (default: http://localhost:3000)
  --users <n>, -u       Concurrent virtual users (default: 50)
  --duration <t>, -d    Run duration, e.g. 30s, 2m (default: 30s)
  --think-ms <n>        Per-VU pause between requests (default: 0)
  --help, -h            Show this help
`);
}

// A simple cookie jar that wraps fetch so a session can persist auth
// across multiple oRPC calls. One jar = one logged-in identity.
function createSession(baseUrl: string) {
  const cookies = new Map<string, string>();
  const link = new RPCLink({
    url: `${baseUrl}/api`,
    fetch: async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (cookies.size > 0) {
        const header = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
        req.headers.set("Cookie", header);
      }
      const res = await fetch(req);
      const setCookies = res.headers.getSetCookie?.() ?? [];
      for (const c of setCookies) {
        const semi = c.indexOf(";");
        const pair = semi === -1 ? c : c.slice(0, semi);
        const eq = pair.indexOf("=");
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      return res;
    },
  });
  const rpc: RouterClient<AppRouter> = createORPCClient(link);
  return { rpc, cookies };
}

// ---------- bootstrap (idempotent) ----------

export async function bootstrap(baseUrl: string): Promise<{ rpc: RouterClient<AppRouter> }> {
  const s = createSession(baseUrl);

  // Signup-or-login the owner. Existing accounts return CONFLICT email_taken.
  try {
    await s.rpc.auth.signup({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Loadtest Owner" });
    console.log("[bootstrap] created owner account");
  } catch (e) {
    if (e instanceof ORPCError && e.message === "email_taken") {
      await s.rpc.auth.login({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
      console.log("[bootstrap] reused existing owner account");
    } else if (e instanceof ORPCError && e.message === "signup_disabled") {
      // Server has DISABLE_SIGNUP set — try login anyway in case the owner
      // already exists from a prior run.
      await s.rpc.auth.login({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
      console.log("[bootstrap] DISABLE_SIGNUP is set; reused existing owner");
    } else throw e;
  }

  // Create-or-reuse the conference. The owner can list their conferences,
  // so we check first to avoid trying create() and parsing the conflict.
  const owned = await s.rpc.conferences.list();
  let slug: string;
  const existing = owned.find((c) => c.slug === CONF_SLUG);
  if (existing) {
    slug = existing.slug;
    console.log(`[bootstrap] reused existing conference "${slug}"`);
  } else {
    const created = await s.rpc.conferences.create({ name: CONF_NAME });
    slug = created.slug;
    console.log(`[bootstrap] created conference "${slug}"`);
  }

  // Top up sessions so the list endpoint isn't empty. Each session is
  // submitted by the owner and published.
  const subs = await s.rpc.submissions.list({ slug });
  const missing = Math.max(0, TARGET_SESSIONS - subs.length);
  for (let i = subs.length; i < TARGET_SESSIONS; i++) {
    const created = await s.rpc.submissions.create({
      slug,
      title: `Loadtest session #${i + 1}`,
      description: `Synthetic session for load testing. Round-trip body to exercise list payload.`,
      tags: ["loadtest", i % 2 === 0 ? "even" : "odd"],
      requirements: [],
    });
    await s.rpc.submissions.publish({ slug, id: created.id });
  }
  if (missing > 0) console.log(`[bootstrap] added ${missing} session(s) (target ${TARGET_SESSIONS})`);

  return { rpc: s.rpc };
}

// ---------- load runner ----------

export interface Sample { endpoint: string; ms: number; ok: boolean; }

// Read paths that mirror what a logged-in attendee actually hits while a
// conference is running. Weights roughly reflect frequency. Notifications
// are the highest because every client polls them every 30s.
function pickEndpoint(): "conferences.get" | "submissions.list" | "agenda.get" | "notifications.list" | "auth.me" {
  const r = Math.random();
  if (r < 0.36) return "notifications.list";
  if (r < 0.64) return "submissions.list";
  if (r < 0.82) return "conferences.get";
  if (r < 0.93) return "agenda.get";
  return "auth.me";
}

export async function runVU(
  rpc: RouterClient<AppRouter>,
  slug: string,
  deadline: number,
  thinkMs: number,
  samples: Sample[],
): Promise<void> {
  while (Date.now() < deadline) {
    const ep = pickEndpoint();
    const t0 = performance.now();
    let ok = true;
    try {
      if (ep === "conferences.get") await rpc.conferences.get({ slug });
      else if (ep === "submissions.list") await rpc.submissions.list({ slug });
      else if (ep === "agenda.get") await rpc.agenda.get({ slug });
      else if (ep === "notifications.list") await rpc.notifications.list({ slug });
      else if (ep === "auth.me") await rpc.auth.me();
    } catch {
      ok = false;
    }
    samples.push({ endpoint: ep, ms: performance.now() - t0, ok });
    if (thinkMs > 0) await new Promise((r) => setTimeout(r, thinkMs));
  }
}

// ---------- stats + report ----------

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

export interface Summary {
  totalRequests: number;
  errorCount: number;
  errorRate: number;
  throughputRps: number;
  elapsedMs: number;
  p50: number;
  p95: number;
  p99: number;
  perEndpoint: Array<{ endpoint: string; count: number; p50: number; p95: number; p99: number }>;
  verdict: "HEALTHY" | "STRESSED" | "OVERLOADED";
  estimatedActiveUsers: number;
}

const REQS_PER_ACTIVE_USER_PER_SEC = 0.5;

export function summarize(samples: Sample[], elapsedMs: number): Summary {
  const total = samples.length;
  const errors = samples.filter((s) => !s.ok).length;
  const errorRate = total === 0 ? 0 : errors / total;
  const throughput = total / (elapsedMs / 1000);
  const all = samples.map((s) => s.ms).sort((a, b) => a - b);

  const eps = [...new Set(samples.map((s) => s.endpoint))].sort();
  const perEndpoint = eps.map((ep) => {
    const lats = samples.filter((s) => s.endpoint === ep).map((s) => s.ms).sort((a, b) => a - b);
    return {
      endpoint: ep,
      count: lats.length,
      p50: percentile(lats, 50),
      p95: percentile(lats, 95),
      p99: percentile(lats, 99),
    };
  });

  const p95 = percentile(all, 95);
  const verdict: Summary["verdict"] =
    errorRate > 0.01 || p95 > 500 ? "OVERLOADED"
      : p95 > 100 ? "STRESSED"
      : "HEALTHY";

  return {
    totalRequests: total,
    errorCount: errors,
    errorRate,
    throughputRps: throughput,
    elapsedMs,
    p50: percentile(all, 50),
    p95,
    p99: percentile(all, 99),
    perEndpoint,
    verdict,
    estimatedActiveUsers: Math.round(throughput / REQS_PER_ACTIVE_USER_PER_SEC),
  };
}

const VERDICT_NOTES: Record<Summary["verdict"], string> = {
  OVERLOADED: "P95 high or errors above 1%. Reduce concurrency or scale up.",
  STRESSED: "Comfortable ceiling at this concurrency. Doubling load risks degraded latency.",
  HEALTHY: "Plenty of headroom. Try 2x concurrency to find the actual ceiling.",
};

function printReport(args: Args, samples: Sample[], elapsedMs: number) {
  const s = summarize(samples, elapsedMs);
  console.log("\n=== Results ===");
  console.log(`Target:      ${args.base}`);
  console.log(`Concurrency: ${args.users}  Duration: ${fmtMs(elapsedMs)}  Think: ${args.thinkMs}ms`);
  console.log(`Requests:    ${s.totalRequests}   Throughput: ${s.throughputRps.toFixed(1)} req/s`);
  console.log(`Errors:      ${s.errorCount} (${(s.errorRate * 100).toFixed(2)}%)`);
  console.log(`Latency:     P50 ${fmtMs(s.p50)}   P95 ${fmtMs(s.p95)}   P99 ${fmtMs(s.p99)}`);

  console.log("\nPer endpoint:");
  console.log("  endpoint              count   P50      P95      P99");
  for (const ep of s.perEndpoint) {
    console.log(
      `  ${ep.endpoint.padEnd(20)}  ${String(ep.count).padStart(5)}   ` +
        `${fmtMs(ep.p50).padStart(7)}  ` +
        `${fmtMs(ep.p95).padStart(7)}  ` +
        `${fmtMs(ep.p99).padStart(7)}`,
    );
  }

  console.log("\n=== Capacity ===");
  console.log(`State:                ${s.verdict}`);
  console.log(`Estimated capacity:   ~${s.estimatedActiveUsers} active users at this configuration`);
  console.log(`Note:                 ${VERDICT_NOTES[s.verdict]}`);
  console.log("");
  console.log("Active-user estimate assumes ~0.5 req/s per user (NotificationBell");
  console.log("polls every 30s + light interactive traffic). Adjust if your event's");
  console.log("usage pattern differs (e.g. heavy starring bursts).");
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[loadtest] target=${args.base} users=${args.users} duration=${fmtMs(args.durationMs)}`);
  const { rpc } = await bootstrap(args.base);

  console.log(`[loadtest] warming up ${args.users} VU(s)...`);
  const samples: Sample[] = [];
  const deadline = Date.now() + args.durationMs;
  const start = performance.now();
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < args.users; i++) {
    tasks.push(runVU(rpc, CONF_SLUG, deadline, args.thinkMs, samples));
  }
  await Promise.all(tasks);
  const elapsed = performance.now() - start;

  printReport(args, samples, elapsed);
}

main().catch((e) => {
  console.error("[loadtest] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
