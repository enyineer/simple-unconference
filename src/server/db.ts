// Prisma 7 client singleton.
// `bun add @prisma/adapter-better-sqlite3` does not work under Bun yet
// (https://github.com/oven-sh/bun/issues/4290), so we use the libSQL adapter,
// which is pure-JS and runs both in Bun and Node.

import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

let _client: PrismaClient | null = null;

function urlFromEnv(): string {
  return process.env.DATABASE_URL ?? "file:./data/dev.sqlite";
}

export function getPrisma(): PrismaClient {
  if (!_client) {
    const adapter = new PrismaLibSql({ url: urlFromEnv() });
    _client = new PrismaClient({ adapter });
  }
  return _client;
}

// Test helper: returns a client backed by a specific DB URL. Caller owns it.
export function newPrisma(databaseUrl?: string): PrismaClient {
  const adapter = new PrismaLibSql({ url: databaseUrl ?? urlFromEnv() });
  return new PrismaClient({ adapter });
}

// Puts the DB into WAL journal mode. idempotent — the mode is stored in the
// DB file header, so it persists for every future connection in every
// process (the multi-worker launcher relies on this; see cluster.ts).
//
// Without WAL (libsql's default is `delete`), ANY writer blocks ALL readers
// cluster-wide while its transaction is in the pending/exclusive phase — one
// stalled commit (e.g. a slow fsync) 500s every request until the process
// restarts. Under WAL readers never block on a writer.
// Returns the resulting journal mode ("wal").
export async function enableWalMode(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>(
    "PRAGMA journal_mode=WAL",
  );
  return rows[0]?.journal_mode ?? "";
}
