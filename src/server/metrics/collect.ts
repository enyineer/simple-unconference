// Per-process metrics collection. Reads in-memory counters from the realtime
// bus + SSE module, and (optionally) hits Prisma + statfs for instance-wide
// counts. Worker 0 owns the global query; other workers skip it.
//
// Called by push.ts on a 5s interval in cluster mode, and by server.ts on
// each scrape in single-worker mode.

import type { PrismaClient } from "@prisma/client";
import { statSync, statfsSync } from "node:fs";
import { getBusMetricsSnapshot } from "../realtime/bus";
import { getRealtimeMetricsSnapshot } from "../realtime/metrics";
import type { GlobalCounts, MetricsSnapshot } from "./types";

// Captured at module load — matches Bun process lifetime, which is what
// per-worker uptime is supposed to represent.
const PROCESS_STARTED_AT = Date.now();

// Resolve the data volume once. Order matches the old metrics.ts behavior so
// chart deployments and dev runs see the same gauge values they used to.
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

let warnedStatfs = false;
function readStorage(): GlobalCounts["storage"] {
  let dbFileBytes = 0;
  try {
    dbFileBytes = statSync(`${DATA_DIR}/prod.sqlite`).size;
  } catch {
    try { dbFileBytes = statSync(`${DATA_DIR}/dev.sqlite`).size; } catch { /* nothing on disk */ }
  }
  let totalBytes = 0;
  let freeBytes = 0;
  let usedBytes = 0;
  try {
    const fs = statfsSync(DATA_DIR);
    totalBytes = Number(fs.blocks) * Number(fs.bsize);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
    usedBytes = totalBytes - freeBytes;
  } catch (e) {
    if (!warnedStatfs) {
      warnedStatfs = true;
      console.warn(
        `[metrics] statfsSync("${DATA_DIR}") failed: ${e instanceof Error ? e.message : String(e)} — storage_pvc_* will report 0.`,
      );
    }
  }
  return { totalBytes, freeBytes, usedBytes, dbFileBytes };
}

async function collectGlobalCounts(prisma: PrismaClient): Promise<GlobalCounts> {
  const [
    users,
    conferences,
    identities,
    submissions,
    submissionsByStatusRaw,
    stars,
    notifications,
    rooms,
    invites,
    invitesUnclaimed,
    experts,
    expertBookings,
    chatConversations,
    chatConversationsAccepted,
    chatMessages,
    chatMessagesDeleted,
    chatReports,
    chatReportsOpen,
    chatBlocks,
    chatBannedIdentities,
    chatDisabledIdentities,
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
    prisma.conversation.count(),
    prisma.conversation.count({ where: { accepted: true } }),
    prisma.message.count(),
    prisma.message.count({ where: { deletedAt: { not: null } } }),
    prisma.messageReport.count(),
    prisma.messageReport.count({ where: { resolvedAt: null } }),
    prisma.chatBlock.count(),
    prisma.conferenceIdentity.count({ where: { chatBannedAt: { not: null } } }),
    prisma.conferenceIdentity.count({ where: { chatEnabled: false } }),
  ]);

  const submissionsByStatus: Record<string, number> = {};
  for (const row of submissionsByStatusRaw) {
    submissionsByStatus[String(row.status)] = row._count._all;
  }

  return {
    users,
    conferences,
    identities,
    submissions,
    submissionsByStatus,
    stars,
    notifications,
    rooms,
    invites,
    invitesUnclaimed,
    experts,
    expertBookings,
    chatConversations,
    chatConversationsAccepted,
    chatMessages,
    chatMessagesDeleted,
    chatReports,
    chatReportsOpen,
    chatBlocks,
    chatBannedIdentities,
    chatDisabledIdentities,
    storage: readStorage(),
  };
}

export interface CollectOptions {
  workerId: number;
  // Whether this process should also collect Prisma + storage counts.
  // True for worker 0 (or the single worker in non-cluster mode); false for
  // every other worker so we don't run N copies of the same SELECTs.
  includeGlobal: boolean;
}

export async function collectLocalSnapshot(
  prisma: PrismaClient,
  opts: CollectOptions,
): Promise<MetricsSnapshot> {
  const bus = getBusMetricsSnapshot();
  const realtime = getRealtimeMetricsSnapshot();
  const global = opts.includeGlobal ? await collectGlobalCounts(prisma) : null;
  return {
    workerId: opts.workerId,
    startedAt: PROCESS_STARTED_AT,
    bus,
    realtime,
    global,
  };
}

// Exported so tests can assert against the resolved path without re-importing
// the resolution logic.
export const __DATA_DIR_FOR_TESTS = DATA_DIR;
