// Tests for collectLocalSnapshot. Uses an isolated Prisma client (per the
// repo's test-helpers contract) so the global-counts query path exercises
// real schema + groupBy semantics.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestApp, type TestApp } from "../test-helpers";
import { collectLocalSnapshot } from "./collect";

describe("collectLocalSnapshot", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("includeGlobal=false skips Prisma global counts", async () => {
    const snap = await collectLocalSnapshot(ctx.prisma, { workerId: 1, includeGlobal: false });
    expect(snap.workerId).toBe(1);
    expect(snap.global).toBeNull();
    // Per-worker counters are still present (initialized to 0 for a fresh process).
    expect(snap.realtime.activeConnections).toBe(0);
    expect(snap.bus.activeSubscriptions).toBe(0);
  });

  test("includeGlobal=true returns DB row counts + storage shape", async () => {
    const snap = await collectLocalSnapshot(ctx.prisma, { workerId: 0, includeGlobal: true });
    expect(snap.workerId).toBe(0);
    expect(snap.global).not.toBeNull();
    const g = snap.global!;
    expect(typeof g.users).toBe("number");
    expect(typeof g.conferences).toBe("number");
    expect(typeof g.chatMessages).toBe("number");
    expect(g.submissionsByStatus).toBeInstanceOf(Object);
    // statfsSync may fail on some sandboxes; fields are still numbers.
    expect(typeof g.storage.totalBytes).toBe("number");
    expect(typeof g.storage.dbFileBytes).toBe("number");
  });

  test("startedAt is stable across calls (module-load timestamp)", async () => {
    const a = await collectLocalSnapshot(ctx.prisma, { workerId: 0, includeGlobal: false });
    const b = await collectLocalSnapshot(ctx.prisma, { workerId: 0, includeGlobal: false });
    expect(a.startedAt).toBe(b.startedAt);
  });
});
