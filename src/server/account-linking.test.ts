// Phase 4 (account-linking): linking model + principal resolution.
//
// EMAIL_TRANSPORT=memory so the verified path is exercised realistically
// (verification enforced, no network). A verified global account links the
// per-conference identity that shares its email by proving that identity's
// password, then resolves into the conference via its global cookie alone.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestApp, Client, ORPCError, inviteAndClaim, type TestApp } from "./test-helpers";
import { __emailOutbox, __resetEmailOutbox } from "./lib/email";

function lastCode(): string {
  const last = __emailOutbox[__emailOutbox.length - 1];
  return last?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
}

describe("account linking", () => {
  let ctx: TestApp;
  beforeAll(() => {
    process.env.EMAIL_TRANSPORT = "memory";
    ctx = setupTestApp();
  });
  afterAll(async () => {
    delete process.env.EMAIL_TRANSPORT;
    await ctx.cleanup();
  });

  // Signs up a global account and verifies it via the emailed code.
  async function signupVerified(email: string, password = "secret123"): Promise<Client> {
    const c = new Client(ctx.app);
    __resetEmailOutbox();
    await c.rpc.auth.signup({ email, password });
    await c.rpc.auth.verifyEmail({ code: lastCode() });
    return c;
  }

  test("discover, link (password-gated), resolve via global cookie, unlink", async () => {
    const owner = await signupVerified("host@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Linkable Conf" });

    // A participant claims an invite under member@example.com with a password.
    const { identity_id } = await inviteAndClaim(
      ctx.app, owner, conf.slug, "member@example.com", "memberpass1",
    );

    // A *global* account with the same email.
    const g = await signupVerified("member@example.com", "globalpass1");

    // Discovery surfaces the conference (auto-suggest).
    const discover = await g.rpc.account.discoverLinkable();
    expect(discover).toEqual([{ slug: conf.slug, name: "Linkable Conf", role: "participant" }]);

    // Wrong conference password is refused.
    await expect(g.rpc.account.linkConferenceIdentity({ slug: conf.slug, password: "nope" }))
      .rejects.toMatchObject({ message: "invalid_credentials" });

    // Correct password links it.
    const linked = await g.rpc.account.linkConferenceIdentity({ slug: conf.slug, password: "memberpass1" });
    expect(linked).toEqual({ slug: conf.slug, name: "Linkable Conf", role: "participant" });

    // It now appears under listLinked and no longer under discovery.
    expect(await g.rpc.account.listLinked()).toEqual([
      { slug: conf.slug, name: "Linkable Conf", role: "participant" },
    ]);
    expect(await g.rpc.account.discoverLinkable()).toEqual([]);

    // Resolution: the global cookie alone now steps into the conference AS the
    // member identity (no per-conference login happened on this client).
    const me = await g.rpc.conferences.me({ slug: conf.slug });
    expect(me.id).toBe(identity_id);
    expect(me.email).toBe("member@example.com");
    expect(me.role).toBe("participant");

    // Unlink revokes that access.
    await g.rpc.account.unlinkConferenceIdentity({ slug: conf.slug });
    await expect(g.rpc.conferences.me({ slug: conf.slug })).rejects.toBeInstanceOf(ORPCError);
  });

  test("cannot link an identity whose email differs from the account", async () => {
    const owner = await signupVerified("host2@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Other Conf" });
    await inviteAndClaim(ctx.app, owner, conf.slug, "someone@example.com", "pass12345");

    const g = await signupVerified("different@example.com");
    expect(await g.rpc.account.discoverLinkable()).toEqual([]);
    // Even knowing the password, the email must match (lookup is by own email).
    await expect(g.rpc.account.linkConferenceIdentity({ slug: conf.slug, password: "pass12345" }))
      .rejects.toMatchObject({ message: "invalid_credentials" });
  });

  test("linkedUserId is never exposed in participant listings", async () => {
    const owner = await signupVerified("host3@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Privacy Conf" });
    await inviteAndClaim(ctx.app, owner, conf.slug, "linkme@example.com", "pw12345678");
    const g = await signupVerified("linkme@example.com");
    await g.rpc.account.linkConferenceIdentity({ slug: conf.slug, password: "pw12345678" });

    const participants = await owner.rpc.conferences.listParticipants({ slug: conf.slug });
    const blob = JSON.stringify(participants.items);
    expect(blob).not.toContain("linked_user_id");
    expect(blob).not.toContain("linkedUserId");
  });

  test("account.* requires a verified account", async () => {
    // Sign up but do NOT verify.
    const c = new Client(ctx.app);
    __resetEmailOutbox();
    await c.rpc.auth.signup({ email: "unverified@example.com", password: "secret123" });
    await expect(c.rpc.account.discoverLinkable())
      .rejects.toMatchObject({ message: "email_unverified" });
  });
});
