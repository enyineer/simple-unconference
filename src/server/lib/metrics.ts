// Prometheus text-format metrics endpoint for operational visibility.
//
// Renders at `GET /api/metrics`. When METRICS_TOKEN is set, the request must
// carry `Authorization: Bearer <token>`; when unset, the endpoint is open
// (appropriate for in-cluster scraping where the Service is not exposed via
// Ingress). Metrics are computed on demand — cheap counts against indexed
// tables plus a single statfs call for the data directory — so there's no
// background goroutine or polling overhead.

import type { PrismaClient } from "@prisma/client";
import { statSync, statfsSync } from "node:fs";

const METRICS_PATH = "/api/metrics";

// Process start time so we can emit `app_uptime_seconds`. Captured at module
// load — close enough to the actual server start for operational use, and
// matches the lifetime of the Bun process (which is what /metrics describes).
const PROCESS_STARTED_AT = Date.now();

// Resolved at access time so test environments setting/unsetting the var
// after import behave correctly (same pattern as turnstile.ts).
function metricsToken(): string | null {
  return process.env.METRICS_TOKEN?.trim() || null;
}

// Path the metrics endpoint inspects for the PVC / DB-file sizes. Order:
//   1. DATA_DIR env var if set (lets ops override regardless of layout).
//   2. /app/data when it exists (production container mount, chart default).
//   3. ./data relative to CWD (dev convention — `bun run dev` puts the
//      dev SQLite file there).
//   4. CWD as a last resort so the gauges still report *something* about
//      a real filesystem instead of silently emitting 0.
// Resolved once at module load; ops change DATA_DIR via restart, not at runtime.
function resolveDataDir(): { dir: string; source: string } {
  const fromEnv = process.env.DATA_DIR?.trim();
  if (fromEnv) return { dir: fromEnv, source: "DATA_DIR env" };
  try {
    const st = statSync("/app/data");
    if (st.isDirectory()) return { dir: "/app/data", source: "/app/data" };
  } catch { /* not in a container */ }
  try {
    const st = statSync("./data");
    if (st.isDirectory()) return { dir: "./data", source: "./data" };
  } catch { /* no dev data dir yet */ }
  return { dir: process.cwd(), source: "cwd" };
}

const RESOLVED_DATA = resolveDataDir();
const DATA_DIR = RESOLVED_DATA.dir;
if (RESOLVED_DATA.source !== "/app/data" && RESOLVED_DATA.source !== "DATA_DIR env") {
  console.warn(
    `[metrics] data dir resolved to "${DATA_DIR}" (source: ${RESOLVED_DATA.source}); ` +
      `storage_pvc_* metrics will reflect this volume, not /app/data. ` +
      `Set DATA_DIR to override.`,
  );
}

export interface MetricsRequest {
  headers: Headers;
  url: URL;
}

// True when the request is the metrics endpoint AND the auth (if configured)
// passes. Callers route based on this; the handler below produces the body.
export function isMetricsRequest(req: { url: string }): boolean {
  return new URL(req.url).pathname === METRICS_PATH;
}

export function metricsAuthorized(req: Request): boolean {
  const token = metricsToken();
  if (token === null) return true; // open endpoint
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}

interface MetricLine {
  name: string;
  help: string;
  type: "gauge" | "counter";
  value: number;
  labels?: Record<string, string>;
}

function formatLines(lines: MetricLine[]): string {
  // Group by name so we emit `# HELP` / `# TYPE` once per metric family,
  // then all the values. Required by the Prometheus exposition format.
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

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// Snapshot of the data volume. `statfsSync` is the modern POSIX-correct way
// to read filesystem-level free space; falls back to a single-file stat if
// statfs is unavailable (older runtimes, mocked FS).
function readStorage(): { used: number; free: number; total: number; dbSize: number | null } {
  let dbSize: number | null = null;
  try {
    dbSize = statSync(`${DATA_DIR}/prod.sqlite`).size;
  } catch {
    try { dbSize = statSync(`${DATA_DIR}/dev.sqlite`).size; } catch { /* nothing on disk yet */ }
  }
  let used = 0;
  let free = 0;
  let total = 0;
  try {
    const fs = statfsSync(DATA_DIR);
    // Block sizes vary by FS; multiply to bytes.
    total = Number(fs.blocks) * Number(fs.bsize);
    free = Number(fs.bavail) * Number(fs.bsize);
    used = total - free;
  } catch (e) {
    // Warn once at startup-style verbosity so operators can find this when
    // they're staring at zeros in their dashboard. Per-request logging would
    // spam, so we accept that subsequent failures are silent.
    if (!warnedStatfs) {
      warnedStatfs = true;
      console.warn(
        `[metrics] statfsSync("${DATA_DIR}") failed: ${e instanceof Error ? e.message : String(e)} — storage_pvc_* will report 0.`,
      );
    }
  }
  return { used, free, total, dbSize };
}
let warnedStatfs = false;

export async function renderMetrics(prisma: PrismaClient): Promise<string> {
  const [
    userCount,
    conferenceCount,
    identityCount,
    submissionCount,
    submissionsByStatus,
    starCount,
    notificationCount,
    roomCount,
    inviteCount,
    inviteUnclaimedCount,
    expertCount,
    expertBookingCount,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.conference.count(),
    prisma.conferenceIdentity.count(),
    prisma.submission.count(),
    prisma.submission.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.star.count(),
    prisma.notification.count(),
    prisma.room.count(),
    prisma.conferenceInvite.count(),
    prisma.conferenceInvite.count({ where: { claimedAt: null } }),
    prisma.expert.count(),
    prisma.expertBooking.count(),
  ]);

  const storage = readStorage();
  const uptimeSeconds = Math.floor((Date.now() - PROCESS_STARTED_AT) / 1000);
  const workersHint = Number(process.env.WORKER_ID); // present in cluster workers

  const lines: MetricLine[] = [
    {
      name: "app_uptime_seconds",
      help: "Seconds since this process started.",
      type: "gauge",
      value: uptimeSeconds,
    },
    {
      name: "app_worker_id",
      help: "Index of this worker within the cluster (0 = first / single-process mode).",
      type: "gauge",
      value: Number.isFinite(workersHint) ? workersHint : 0,
    },

    // Row counts
    {
      name: "users_total",
      help: "Global owner accounts on this instance.",
      type: "gauge",
      value: userCount,
    },
    {
      name: "conferences_total",
      help: "Conferences on this instance.",
      type: "gauge",
      value: conferenceCount,
    },
    {
      name: "conference_identities_total",
      help: "Per-conference identities (participants + moderators + auto-minted owner identities).",
      type: "gauge",
      value: identityCount,
    },
    {
      name: "submissions_total",
      help: "All submissions across all conferences, regardless of status.",
      type: "gauge",
      value: submissionCount,
    },
    ...submissionsByStatus.map((row) => ({
      name: "submissions_by_status_total" as const,
      help: "Submissions split by current status.",
      type: "gauge" as const,
      value: row._count._all,
      labels: { status: String(row.status) },
    })),
    {
      name: "stars_total",
      help: "Stars (interest indications) across all sessions.",
      type: "gauge",
      value: starCount,
    },
    {
      name: "notifications_total",
      help: "Stored notifications across all identities.",
      type: "gauge",
      value: notificationCount,
    },
    {
      name: "rooms_total",
      help: "Rooms across all conferences.",
      type: "gauge",
      value: roomCount,
    },
    {
      name: "invites_total",
      help: "Conference invites issued, claimed or not.",
      type: "gauge",
      value: inviteCount,
    },
    {
      name: "invites_unclaimed_total",
      help: "Conference invites that haven't been claimed yet.",
      type: "gauge",
      value: inviteUnclaimedCount,
    },
    {
      name: "experts_total",
      help: "Experts promoted on this instance.",
      type: "gauge",
      value: expertCount,
    },
    {
      name: "expert_bookings_total",
      help: "Expert 1:1 bookings.",
      type: "gauge",
      value: expertBookingCount,
    },

    // Storage
    {
      name: "storage_pvc_total_bytes",
      help: "Total bytes available to the data volume (statfs blocks * bsize).",
      type: "gauge",
      value: storage.total,
    },
    {
      name: "storage_pvc_free_bytes",
      help: "Free bytes available on the data volume (statfs bavail * bsize).",
      type: "gauge",
      value: storage.free,
    },
    {
      name: "storage_pvc_used_bytes",
      help: "Bytes consumed on the data volume (total - free).",
      type: "gauge",
      value: storage.used,
    },
    {
      name: "storage_db_file_bytes",
      help: "Size of the SQLite database file on disk (WAL/SHM not included).",
      type: "gauge",
      value: storage.dbSize ?? 0,
    },
  ];

  return formatLines(lines);
}

// Build the full HTTP response. Returns a 401 when METRICS_TOKEN is set and
// the request didn't match; never returns 500 — failures from individual
// counters bubble up so the caller can hand the error to Hono's normal path.
export async function metricsResponse(req: Request, prisma: PrismaClient): Promise<Response> {
  if (!metricsAuthorized(req)) {
    return new Response("metrics endpoint requires Bearer token", { status: 401 });
  }
  const body = await renderMetrics(prisma);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
