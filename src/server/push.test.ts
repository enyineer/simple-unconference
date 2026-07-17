// Web Push: subscription RPC (per-identity uniqueness + unsubscribe), the
// best-effort send fan-out with stale-row cleanup, and env-gated config.
// Each describe block gets its own temp DB via setupTestApp().

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  setupTestApp, Client, type TestApp,
  inviteAndClaim,
} from "./test-helpers";
import {
  webPushConfigured, vapidPublicKey, sendPushForNotification,
  deepLinkForNotification, type SendOutcome, type PushPayload,
} from "./lib/webpush";
import type { PushSubscription } from "web-push";

let ctx: TestApp;

async function makeOwnerConf(prefix: string) {
  const owner = new Client(ctx.app);
  await owner.rpc.auth.signup({ email: `${prefix}-owner@example.com`, password: "secret123", name: "Owner" });
  const conf = await owner.rpc.conferences.create({ name: `Conf ${prefix}` });
  return { owner, conf };
}

describe("push.subscribe / unsubscribe", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("upserts on (identity, endpoint) and unsubscribe removes the row", async () => {
    const { owner, conf } = await makeOwnerConf("push-rpc");
    const { client: part, identity_id } = await inviteAndClaim(
      ctx.app, owner, conf.slug, "push-part@example.com", "secret123", "Ada",
    );

    const endpoint = "https://push.example.com/sub-a";
    await part.rpc.push.subscribe({
      slug: conf.slug, endpoint, keys: { p256dh: "key-1", auth: "auth-1" },
    });
    // Re-subscribing the SAME endpoint upserts (keys refresh) — no duplicate.
    await part.rpc.push.subscribe({
      slug: conf.slug, endpoint, keys: { p256dh: "key-2", auth: "auth-2" },
      user_agent: "TestBrowser/1.0",
    });

    let rows = await ctx.prisma.pushSubscription.findMany({ where: { identityId: identity_id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe("key-2");
    expect(rows[0]!.auth).toBe("auth-2");
    expect(rows[0]!.userAgent).toBe("TestBrowser/1.0");

    // A second device (different endpoint) is a distinct row.
    await part.rpc.push.subscribe({
      slug: conf.slug, endpoint: "https://push.example.com/sub-b",
      keys: { p256dh: "key-3", auth: "auth-3" },
    });
    rows = await ctx.prisma.pushSubscription.findMany({ where: { identityId: identity_id } });
    expect(rows).toHaveLength(2);

    // Unsubscribe drops just that endpoint.
    await part.rpc.push.unsubscribe({ slug: conf.slug, endpoint });
    rows = await ctx.prisma.pushSubscription.findMany({ where: { identityId: identity_id } });
    expect(rows.map((r) => r.endpoint)).toEqual(["https://push.example.com/sub-b"]);

    // Unsubscribing an unknown endpoint is a silent no-op.
    await part.rpc.push.unsubscribe({ slug: conf.slug, endpoint: "https://nope" });
    rows = await ctx.prisma.pushSubscription.findMany({ where: { identityId: identity_id } });
    expect(rows).toHaveLength(1);
  });

  test("the same endpoint string for two identities is two distinct rows", async () => {
    const { owner, conf } = await makeOwnerConf("push-two");
    const a = await inviteAndClaim(ctx.app, owner, conf.slug, "a@example.com", "secret123", "A");
    const b = await inviteAndClaim(ctx.app, owner, conf.slug, "b@example.com", "secret123", "B");
    const endpoint = "https://push.example.com/shared";
    await a.client.rpc.push.subscribe({ slug: conf.slug, endpoint, keys: { p256dh: "p", auth: "x" } });
    await b.client.rpc.push.subscribe({ slug: conf.slug, endpoint, keys: { p256dh: "p", auth: "y" } });
    expect(await ctx.prisma.pushSubscription.count({ where: { endpoint } })).toBe(2);
  });
});

describe("sendPushForNotification (best-effort + stale cleanup)", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  // Configure VAPID just for this block so webPushConfigured() is true; restore
  // afterwards so other suites see the inert default.
  const prev = {
    pub: process.env.VAPID_PUBLIC_KEY,
    priv: process.env.VAPID_PRIVATE_KEY,
  };
  beforeAll(() => {
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
  });
  afterAll(() => {
    process.env.VAPID_PUBLIC_KEY = prev.pub;
    process.env.VAPID_PRIVATE_KEY = prev.priv;
  });

  test("sends to every device and deletes only rows the push service reports gone", async () => {
    const { owner, conf } = await makeOwnerConf("push-send");
    const { identity_id } = await inviteAndClaim(
      ctx.app, owner, conf.slug, "send-part@example.com", "secret123", "Ada",
    );
    const goodEndpoint = "https://push.example.com/good";
    const deadEndpoint = "https://push.example.com/dead";
    await ctx.prisma.pushSubscription.createMany({
      data: [
        { identityId: identity_id, endpoint: goodEndpoint, p256dh: "p1", auth: "a1" },
        { identityId: identity_id, endpoint: deadEndpoint, p256dh: "p2", auth: "a2" },
      ],
    });

    const sent: { sub: PushSubscription; payload: PushPayload }[] = [];
    const fakeSender = async (sub: PushSubscription, payload: PushPayload): Promise<SendOutcome> => {
      sent.push({ sub, payload });
      return sub.endpoint === deadEndpoint
        ? { ok: false, gone: true }
        : { ok: true };
    };

    await sendPushForNotification(
      ctx.prisma, identity_id,
      { title: "Scheduled", body: "You're on the agenda", ctaHref: "tab:agenda" },
      fakeSender,
    );

    // Both devices were attempted; payload is the privacy-safe deep link.
    expect(sent).toHaveLength(2);
    expect(sent[0]!.payload.url).toBe(`/conferences/${conf.slug}/agenda`);
    expect(sent[0]!.payload.title).toBe("Scheduled");

    // Only the "gone" row was pruned.
    const remaining = await ctx.prisma.pushSubscription.findMany({ where: { identityId: identity_id } });
    expect(remaining.map((r) => r.endpoint)).toEqual([goodEndpoint]);
  });

  test("no subscriptions → no sends, no throw", async () => {
    const { owner, conf } = await makeOwnerConf("push-empty");
    const { identity_id } = await inviteAndClaim(
      ctx.app, owner, conf.slug, "empty-part@example.com", "secret123", "Bo",
    );
    let called = 0;
    await sendPushForNotification(
      ctx.prisma, identity_id, { title: "Hi" },
      async () => { called++; return { ok: true }; },
    );
    expect(called).toBe(0);
  });
});

describe("webPushConfigured / vapidPublicKey (env gating)", () => {
  const prev = {
    pub: process.env.VAPID_PUBLIC_KEY,
    priv: process.env.VAPID_PRIVATE_KEY,
  };
  afterEach(() => {
    process.env.VAPID_PUBLIC_KEY = prev.pub;
    process.env.VAPID_PRIVATE_KEY = prev.priv;
  });

  test("inert when either key is missing", () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    expect(webPushConfigured()).toBe(false);
    expect(vapidPublicKey()).toBeNull();

    // Only one key set is still not configured.
    process.env.VAPID_PUBLIC_KEY = "pub-only";
    expect(webPushConfigured()).toBe(false);
  });

  test("configured when both keys are present; exposes the public key", () => {
    process.env.VAPID_PUBLIC_KEY = "the-public-key";
    process.env.VAPID_PRIVATE_KEY = "the-private-key";
    expect(webPushConfigured()).toBe(true);
    expect(vapidPublicKey()).toBe("the-public-key");
  });
});

describe("deepLinkForNotification", () => {
  test("maps tab / path / null ctaHref forms", () => {
    expect(deepLinkForNotification("acme", "tab:agenda")).toBe("/conferences/acme/agenda");
    expect(deepLinkForNotification("acme", "/conferences/acme/chat/7")).toBe("/conferences/acme/chat/7");
    expect(deepLinkForNotification("acme", null)).toBe("/conferences/acme/");
    expect(deepLinkForNotification("acme", undefined)).toBe("/conferences/acme/");
  });
});
