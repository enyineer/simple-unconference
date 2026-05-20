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
