// WAL journal mode: the multi-worker launcher's correctness + availability
// story depends on the DB running in WAL (see cluster.ts header notes).
// Regression guard for the 2026-09-24 prod incident: prod ran in default
// `delete` mode, so one stalled writer held the cluster-wide lock and every
// request 500'd until a pod restart.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newPrisma, enableWalMode } from "./db";

const dir = mkdtempSync(join(tmpdir(), "unconf-wal-"));
const created: ReturnType<typeof newPrisma>[] = [];

afterAll(async () => {
  for (const p of created) await p.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("enableWalMode", () => {
  test("switches a fresh DB to WAL and persists across new connections", async () => {
    const url = `file:${join(dir, "wal.sqlite")}`;
    const a = newPrisma(url);
    created.push(a);

    expect(await enableWalMode(a)).toBe("wal");
    expect(await enableWalMode(a)).toBe("wal"); // idempotent

    // A brand-new connection (what every worker / restart gets) must see it.
    const b = newPrisma(url);
    created.push(b);
    const rows = await b.$queryRawUnsafe<Array<{ journal_mode: string }>>(
      "PRAGMA journal_mode",
    );
    expect(rows[0]?.journal_mode).toBe("wal");
  });
});
