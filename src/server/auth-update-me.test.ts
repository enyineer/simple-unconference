// Tests for `auth.updateMe` — self-service display-name update for the
// global account. Pins the "" → null clearing rule, the omitted-key-leaves-
// alone rule, the 80-char cap, and the authed-only gate.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestApp, Client, ORPCError, type TestApp } from "./test-helpers";

describe("auth.updateMe", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("sets, omits (no-op), and clears the global display name", async () => {
    const c = new Client(ctx.app);
    const signedUp = await c.rpc.auth.signup({
      email: "rename-me@example.com", password: "secret123",
    });
    expect(signedUp.name).toBeNull();

    // Set.
    const named = await c.rpc.auth.updateMe({ name: "Nico E." });
    expect(named.name).toBe("Nico E.");
    expect((await c.rpc.auth.me()).name).toBe("Nico E.");

    // Omitted key leaves the stored name alone.
    await c.rpc.auth.updateMe({});
    expect((await c.rpc.auth.me()).name).toBe("Nico E.");

    // Explicit empty string clears to null (same rule as signup).
    const cleared = await c.rpc.auth.updateMe({ name: "" });
    expect(cleared.name).toBeNull();
    expect((await c.rpc.auth.me()).name).toBeNull();
  });

  test("name is scoped to the caller's User row only", async () => {
    const a = new Client(ctx.app);
    const b = new Client(ctx.app);
    await a.rpc.auth.signup({ email: "rename-a@example.com", password: "secret123" });
    await b.rpc.auth.signup({ email: "rename-b@example.com", password: "secret123" });

    await a.rpc.auth.updateMe({ name: "Only A" });

    expect((await a.rpc.auth.me()).name).toBe("Only A");
    expect((await b.rpc.auth.me()).name).toBeNull();
  });

  test("over the 80-char cap is rejected by validation", async () => {
    const c = new Client(ctx.app);
    await c.rpc.auth.signup({ email: "rename-cap@example.com", password: "secret123" });
    await expect(
      c.rpc.auth.updateMe({ name: "x".repeat(81) }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("unauthenticated callers are rejected", async () => {
    const anon = new Client(ctx.app);
    await expect(anon.rpc.auth.updateMe({ name: "Sneaky" })).rejects.toBeInstanceOf(ORPCError);
  });
});
