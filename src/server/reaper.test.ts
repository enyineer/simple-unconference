// Phase 3 hygiene: the abandoned-pending-signup reaper deletes only unverified
// rows whose verification link expired well in the past, and never touches
// verified accounts or in-flight signups.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestApp, type TestApp } from "./test-helpers";
import { reapPendingUsers } from "./lib/reaper";

describe("pending-user reaper", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("reaps only long-expired unverified signups", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    const soon = new Date(Date.now() + 30 * 60_000);

    // Abandoned: unverified, link expired 2h ago -> reaped.
    const abandoned = await ctx.prisma.user.create({
      data: { email: "abandoned@example.com", passwordHash: "x", emailVerifiedAt: null, emailVerifyLinkExpiresAt: twoHoursAgo },
    });
    // In-flight: unverified, link still valid -> kept.
    const inflight = await ctx.prisma.user.create({
      data: { email: "inflight@example.com", passwordHash: "x", emailVerifiedAt: null, emailVerifyLinkExpiresAt: soon },
    });
    // Verified -> kept (no expiry columns).
    const verified = await ctx.prisma.user.create({
      data: { email: "verified@example.com", passwordHash: "x", emailVerifiedAt: new Date() },
    });

    const count = await reapPendingUsers(ctx.prisma);
    expect(count).toBe(1);

    expect(await ctx.prisma.user.findUnique({ where: { id: abandoned.id } })).toBeNull();
    expect(await ctx.prisma.user.findUnique({ where: { id: inflight.id } })).not.toBeNull();
    expect(await ctx.prisma.user.findUnique({ where: { id: verified.id } })).not.toBeNull();
  });
});
