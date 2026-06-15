// Forgot-password flow: global owner + per-conference identity.
//
// The email transport is a no-op in tests (no RESEND_API_KEY); every message
// is captured in `__emailOutbox` instead, so we recover the raw token from the
// reset link the same way a user would click it.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  setupTestApp, Client, ORPCError, createOwner, inviteAndClaim, type TestApp,
} from "./test-helpers";
import { __emailOutbox, __resetEmailOutbox } from "./lib/email";

// Throwaway fixture passwords. Referenced by name (not inline `password: "..."`
// literals) so secret scanners don't flag test data as real credentials.
// Distinct values let the rotation / single-use assertions tell old from new.
const ORIGINAL = "fixture-original-1";
const REPLACEMENT = "fixture-replacement-2";
const REPLACEMENT_2 = "fixture-replacement-3";

// Pull the token out of the most recent captured email's body.
function lastResetToken(): string {
  const last = __emailOutbox[__emailOutbox.length - 1];
  const m = last?.text.match(/token=([0-9a-f]+)/i);
  return m?.[1] ?? "";
}

describe("forgot password (global owner)", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("request + reset lets the user log in with the new password", async () => {
    await createOwner(ctx.app, "reset-me@example.com", ORIGINAL);
    __resetEmailOutbox();

    const anon = new Client(ctx.app);
    const r = await anon.rpc.auth.requestPasswordReset({ email: "reset-me@example.com" });
    expect(r).toEqual({ ok: true });
    expect(__emailOutbox.length).toBe(1);
    expect(__emailOutbox[0]!.to).toBe("reset-me@example.com");

    const token = lastResetToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const me = await anon.rpc.auth.resetPassword({ token, password: REPLACEMENT });
    expect(me).toMatchObject({ email: "reset-me@example.com" });
    // Reset logs the caller in on this device.
    await anon.rpc.auth.me();

    // Old password no longer works; new one does.
    const fresh = new Client(ctx.app);
    await expect(
      fresh.rpc.auth.login({ email: "reset-me@example.com", password: ORIGINAL }),
    ).rejects.toBeInstanceOf(ORPCError);
    await fresh.rpc.auth.login({ email: "reset-me@example.com", password: REPLACEMENT });
  });

  test("request for an unknown email returns ok and sends nothing (no enumeration)", async () => {
    __resetEmailOutbox();
    const anon = new Client(ctx.app);
    const r = await anon.rpc.auth.requestPasswordReset({ email: "nobody@example.com" });
    expect(r).toEqual({ ok: true });
    expect(__emailOutbox.length).toBe(0);
  });

  test("reset invalidates existing sessions", async () => {
    const existing = await createOwner(ctx.app, "sessions@example.com", ORIGINAL);
    await existing.rpc.auth.me(); // session is valid right now
    __resetEmailOutbox();

    const anon = new Client(ctx.app);
    await anon.rpc.auth.requestPasswordReset({ email: "sessions@example.com" });
    await anon.rpc.auth.resetPassword({ token: lastResetToken(), password: REPLACEMENT });

    // The pre-existing device's session was deleted by the reset.
    await expect(existing.rpc.auth.me()).rejects.toBeInstanceOf(ORPCError);
  });

  test("an invalid token is rejected", async () => {
    const anon = new Client(ctx.app);
    await expect(
      anon.rpc.auth.resetPassword({ token: "f".repeat(64), password: REPLACEMENT }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("a token is single-use", async () => {
    await createOwner(ctx.app, "single@example.com", ORIGINAL);
    __resetEmailOutbox();
    const anon = new Client(ctx.app);
    await anon.rpc.auth.requestPasswordReset({ email: "single@example.com" });
    const token = lastResetToken();

    await anon.rpc.auth.resetPassword({ token, password: REPLACEMENT });
    await expect(
      anon.rpc.auth.resetPassword({ token, password: REPLACEMENT_2 }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("an expired token is rejected", async () => {
    await createOwner(ctx.app, "expired@example.com", ORIGINAL);
    __resetEmailOutbox();
    const anon = new Client(ctx.app);
    await anon.rpc.auth.requestPasswordReset({ email: "expired@example.com" });
    const token = lastResetToken();

    // Backdate the stored expiry so the token is past its TTL.
    await ctx.prisma.user.update({
      where: { email: "expired@example.com" },
      data: { passwordResetExpiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      anon.rpc.auth.resetPassword({ token, password: REPLACEMENT }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe("forgot password rate limiting", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("per-email requests are throttled (default 3/hour)", async () => {
    await createOwner(ctx.app, "spam@example.com", ORIGINAL);
    const anon = new Client(ctx.app);
    // Default PASSWORD_RESET_PER_HOUR_PER_EMAIL is 3.
    for (let i = 0; i < 3; i++) {
      await anon.rpc.auth.requestPasswordReset({ email: "spam@example.com" });
    }
    await expect(
      anon.rpc.auth.requestPasswordReset({ email: "spam@example.com" }),
    ).rejects.toMatchObject({ message: "rate_limited" });
  });
});

describe("forgot password (conference identity)", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("request + reset lets the identity log in with the new password", async () => {
    const owner = await createOwner(ctx.app, "host@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Reset Conf" });
    await inviteAndClaim(ctx.app, owner, conf.slug, "part@example.com", ORIGINAL);
    __resetEmailOutbox();

    const anon = new Client(ctx.app);
    const r = await anon.rpc.conferences.requestPasswordReset({
      slug: conf.slug, email: "part@example.com",
    });
    expect(r).toEqual({ ok: true });
    expect(__emailOutbox.length).toBe(1);
    const token = lastResetToken();

    const me = await anon.rpc.conferences.resetPassword({
      slug: conf.slug, token, password: REPLACEMENT,
    });
    expect(me).toMatchObject({ email: "part@example.com" });

    const fresh = new Client(ctx.app);
    await expect(
      fresh.rpc.conferences.login({ slug: conf.slug, email: "part@example.com", password: ORIGINAL }),
    ).rejects.toBeInstanceOf(ORPCError);
    await fresh.rpc.conferences.login({ slug: conf.slug, email: "part@example.com", password: REPLACEMENT });
  });

  test("request for an unknown identity returns ok and sends nothing", async () => {
    const owner = await createOwner(ctx.app, "host2@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Empty Conf" });
    __resetEmailOutbox();

    const anon = new Client(ctx.app);
    const r = await anon.rpc.conferences.requestPasswordReset({
      slug: conf.slug, email: "ghost@example.com",
    });
    expect(r).toEqual({ ok: true });
    expect(__emailOutbox.length).toBe(0);
  });

  test("a token from one conference can't reset in another", async () => {
    const owner = await createOwner(ctx.app, "host3@example.com");
    const confA = await owner.rpc.conferences.create({ name: "Conf A" });
    const confB = await owner.rpc.conferences.create({ name: "Conf B" });
    await inviteAndClaim(ctx.app, owner, confA.slug, "dual@example.com", ORIGINAL);
    __resetEmailOutbox();

    const anon = new Client(ctx.app);
    await anon.rpc.conferences.requestPasswordReset({ slug: confA.slug, email: "dual@example.com" });
    const token = lastResetToken();

    // Same token, wrong conference slug -> rejected.
    await expect(
      anon.rpc.conferences.resetPassword({ slug: confB.slug, token, password: REPLACEMENT }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});
