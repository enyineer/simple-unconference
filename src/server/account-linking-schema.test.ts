// Phase 1 (account-linking): schema + backfill.
//
// Note on scope: the test harness builds its DB with `prisma db push` (current
// schema), NOT by running migrations, so the migration's backfill block does
// not execute here. The migration itself is applied + checked via
// `prisma migrate deploy` against the dev DB. The "backfill semantics" test
// below re-runs the SAME two UPDATE statements the migration contains, against
// seeded pre-state, so the grandfathering logic (which prevents locking out
// existing owners) has an automated guard even though the harness skips
// migrations.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestApp, type TestApp } from "./test-helpers";

describe("account-linking schema", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("new email-verification columns are usable + token hash is unique", async () => {
    const now = new Date();
    const u = await ctx.prisma.user.create({
      data: {
        email: "verify@example.com",
        passwordHash: "x",
        emailVerifiedAt: null,
        emailVerifyTokenHash: "tokenhash-1",
        emailVerifyCodeHash: "codehash-1",
        emailVerifyLinkExpiresAt: new Date(now.getTime() + 30 * 60_000),
        emailVerifyCodeExpiresAt: new Date(now.getTime() + 15 * 60_000),
        emailVerifyAttempts: 2,
      },
    });
    expect(u.emailVerifiedAt).toBeNull();
    expect(u.emailVerifyAttempts).toBe(2);

    // Unique constraint on the (hashed) magic-link token. (PrismaPromise is a
    // lazy thenable, not a native Promise, so bun's `.rejects` matcher rejects
    // it — assert via try/catch instead.)
    let threw = false;
    try {
      await ctx.prisma.user.create({
        data: { email: "verify2@example.com", passwordHash: "x", emailVerifyTokenHash: "tokenhash-1" },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("linkedUser relation resolves both directions", async () => {
    const user = await ctx.prisma.user.create({
      data: { email: "linker@example.com", passwordHash: "x" },
    });
    const conf = await ctx.prisma.conference.create({
      data: { name: "Linkable", slug: "linkable", ownerId: user.id },
    });
    const identity = await ctx.prisma.conferenceIdentity.create({
      data: { conferenceId: conf.id, email: "linker@example.com", linkedUserId: user.id },
      include: { linkedUser: true },
    });
    expect(identity.linkedUser?.id).toBe(user.id);

    const back = await ctx.prisma.user.findUnique({
      where: { id: user.id },
      include: { linkedIdentities: true },
    });
    expect(back?.linkedIdentities.map((i) => i.id)).toContain(identity.id);
  });

  test("backfill grandfathers existing owners (mirrors the migration)", async () => {
    const past = new Date("2026-01-01T00:00:00.000Z");
    const owner = await ctx.prisma.user.create({
      data: {
        email: "legacy@example.com",
        passwordHash: "x",
        createdAt: past,
        emailVerifiedAt: null, // pre-migration state
      },
    });
    const conf = await ctx.prisma.conference.create({
      data: { name: "Legacy", slug: "legacy", ownerId: owner.id },
    });
    // Owner-minted identity in pre-migration state: ownerUserId set, link null.
    const ownerIdentity = await ctx.prisma.conferenceIdentity.create({
      data: { conferenceId: conf.id, email: "legacy@example.com", ownerUserId: owner.id, linkedUserId: null },
    });
    // A plain participant (no owner link) must NOT get linked by the backfill.
    const participant = await ctx.prisma.conferenceIdentity.create({
      data: { conferenceId: conf.id, email: "attendee@example.com" },
    });

    // The exact two statements the migration appends after the table rebuild.
    await ctx.prisma.$executeRawUnsafe(
      `UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;`,
    );
    await ctx.prisma.$executeRawUnsafe(
      `UPDATE "conference_identities" SET "linked_user_id" = "owner_user_id" WHERE "owner_user_id" IS NOT NULL;`,
    );

    const u = await ctx.prisma.user.findUnique({ where: { id: owner.id } });
    expect(u?.emailVerifiedAt?.getTime()).toBe(past.getTime()); // verified = created_at

    const oi = await ctx.prisma.conferenceIdentity.findUnique({ where: { id: ownerIdentity.id } });
    expect(oi?.linkedUserId).toBe(owner.id); // owner identity now linked

    const p = await ctx.prisma.conferenceIdentity.findUnique({ where: { id: participant.id } });
    expect(p?.linkedUserId).toBeNull(); // participant untouched
  });
});
