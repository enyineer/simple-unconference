// Phase 3 (account-linking): global email verification.
//
// Runs with EMAIL_TRANSPORT=memory so email is "configured" (verification is
// enforced) but delivery only hits the in-memory outbox - no network. We read
// the 6-digit code + magic-link token back out of the outbox the same way a
// user reads them from their inbox. Bun isolates env per test file, so this
// doesn't affect the other suites (which run with no transport / auto-verify).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestApp, Client, type TestApp } from "./test-helpers";
import { __emailOutbox, __resetEmailOutbox } from "./lib/email";

function lastCode(): string {
  const last = __emailOutbox[__emailOutbox.length - 1];
  return last?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
}
function lastVerifyToken(): string {
  const last = __emailOutbox[__emailOutbox.length - 1];
  return last?.text.match(/token=([0-9a-f]+)/i)?.[1] ?? "";
}

describe("email verification (transport configured)", () => {
  let ctx: TestApp;
  beforeAll(() => {
    process.env.EMAIL_TRANSPORT = "memory";
    ctx = setupTestApp();
  });
  afterAll(async () => {
    delete process.env.EMAIL_TRANSPORT;
    await ctx.cleanup();
  });

  test("signup creates an unverified account and walls conference creation", async () => {
    const c = new Client(ctx.app);
    __resetEmailOutbox();
    const me = await c.rpc.auth.signup({ email: "owner@example.com", password: "secret123" });
    expect(me.email_verified).toBe(false);
    expect(__emailOutbox.length).toBe(1);
    await expect(c.rpc.conferences.create({ name: "Blocked" }))
      .rejects.toMatchObject({ message: "email_unverified" });
  });

  test("verifyEmail with the code unlocks the account", async () => {
    const c = new Client(ctx.app);
    __resetEmailOutbox();
    await c.rpc.auth.signup({ email: "code@example.com", password: "secret123" });
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);

    const me = await c.rpc.auth.verifyEmail({ code });
    expect(me.email_verified).toBe(true);

    const conf = await c.rpc.conferences.create({ name: "Allowed" });
    expect(conf.slug).toBeTruthy();
  });

  test("wrong code is rejected, then locks out after MAX attempts", async () => {
    const c = new Client(ctx.app);
    __resetEmailOutbox();
    await c.rpc.auth.signup({ email: "wrong@example.com", password: "secret123" });
    // 5 wrong tries each report invalid_code...
    for (let i = 0; i < 5; i++) {
      await expect(c.rpc.auth.verifyEmail({ code: "000000" }))
        .rejects.toMatchObject({ message: "invalid_code" });
    }
    // ...the 6th is refused outright until a resend.
    await expect(c.rpc.auth.verifyEmail({ code: "000000" }))
      .rejects.toMatchObject({ message: "code_attempts_exceeded" });
  });

  test("magic-link token verifies and logs the caller in (any browser)", async () => {
    const signupClient = new Client(ctx.app);
    __resetEmailOutbox();
    await signupClient.rpc.auth.signup({ email: "link@example.com", password: "secret123" });
    const token = lastVerifyToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const linkClient = new Client(ctx.app); // fresh "browser"
    const me = await linkClient.rpc.auth.verifyEmailByToken({ token });
    expect(me.email_verified).toBe(true);
    expect((await linkClient.rpc.auth.me()).email_verified).toBe(true);
  });

  test("resend is throttled by the 30s cooldown", async () => {
    const c = new Client(ctx.app);
    __resetEmailOutbox();
    await c.rpc.auth.signup({ email: "resend@example.com", password: "secret123" });
    await c.rpc.auth.resendVerification();
    await expect(c.rpc.auth.resendVerification())
      .rejects.toMatchObject({ message: "rate_limited" });
  });

  test("a pending unverified email is reclaimable; a verified one is not", async () => {
    const a = new Client(ctx.app);
    __resetEmailOutbox();
    await a.rpc.auth.signup({ email: "squat@example.com", password: "firstpass1" });

    // Second signup to the still-unverified email succeeds (reclaim, not 409).
    const b = new Client(ctx.app);
    await b.rpc.auth.signup({ email: "squat@example.com", password: "secondpass2" });
    const me = await b.rpc.auth.verifyEmail({ code: lastCode() });
    expect(me.email_verified).toBe(true);

    // Now verified: a third signup to the same email is rejected.
    const c = new Client(ctx.app);
    await expect(c.rpc.auth.signup({ email: "squat@example.com", password: "thirdpass3" }))
      .rejects.toMatchObject({ message: "email_taken" });

    // The reclaiming password is the one that works.
    const login = new Client(ctx.app);
    await login.rpc.auth.login({ email: "squat@example.com", password: "secondpass2" });
  });
});
