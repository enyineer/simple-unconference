// Phase 3 avatar pipeline smoke tests. Covers the upload happy path, MIME
// whitelist, SVG fallback (including the existence-leak guard for
// unpublished profiles), ETag/304, and the deleteAvatar RPC's filesystem
// cleanup. Each describe block uses an isolated AVATAR_DIR via mkdtempSync
// so tests can't see each other's files.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import {
  setupTestApp, Client, type TestApp,
  inviteAndClaim,
} from "./test-helpers";

// Minimal helper: POST multipart/form-data to a non-RPC route, carrying the
// Client's cookies so the principal resolves. We bypass Client.req() because
// it JSON-stringifies non-string bodies.
async function postMultipart(
  client: Client,
  app: TestApp["app"],
  path: string,
  form: FormData,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (client.cookies.size > 0) {
    headers["cookie"] = [...client.cookies.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  // We deliberately don't set content-type -- fetch derives the multipart
  // boundary from the FormData body. Setting it manually would break parsing.
  return await app.request(`http://test.local${path}`, {
    method: "POST",
    headers,
    body: form,
  });
}

async function getRaw(
  client: Client,
  app: TestApp["app"],
  path: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...extra };
  if (client.cookies.size > 0) {
    headers["cookie"] = [...client.cookies.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  return await app.request(`http://test.local${path}`, { method: "GET", headers });
}

// 1x1 red PNG generated once and reused across tests. Sharp under Bun is
// already verified at module load; failure here would surface immediately.
let tinyPng: Buffer;

describe("avatars HTTP pipeline", () => {
  let ctx: TestApp;
  let avatarDir: string;
  let prevDir: string | undefined;

  beforeAll(async () => {
    avatarDir = mkdtempSync(join(tmpdir(), "uncon-avatars-"));
    prevDir = process.env.AVATAR_DIR;
    process.env.AVATAR_DIR = avatarDir;
    ctx = setupTestApp();
    tinyPng = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 20, b: 20 } },
    }).png().toBuffer();
  });
  afterAll(async () => {
    await ctx.cleanup();
    if (existsSync(avatarDir)) rmSync(avatarDir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.AVATAR_DIR;
    else process.env.AVATAR_DIR = prevDir;
  });

  test("upload happy path writes a webp under AVATAR_DIR", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao1@example.com", password: "secret123", name: "Owner" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 1" });
    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice1@example.com", "secret123", "Alice");

    const form = new FormData();
    form.append("file", new File([new Uint8Array(tinyPng)], "tiny.png", { type: "image/png" }));
    const res = await postMultipart(alice, ctx.app, `/api/avatars/${conf.slug}/upload`, form);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; hash: string };
    expect(body.ok).toBe(true);

    // The conference id is internal, but the path layout is conf/identity.webp;
    // glob the AVATAR_DIR for any *.webp belonging to this identity.
    const expected = join(avatarDir, "1", `${aliceId}.webp`);
    // Conferences in this fresh test DB always start at id=1.
    expect(existsSync(expected)).toBe(true);
    const onDisk = readFileSync(expected);
    expect(onDisk.length).toBeGreaterThan(0);
    // Sharp re-encodes to webp; first 4 bytes are "RIFF".
    expect(onDisk.subarray(0, 4).toString("ascii")).toBe("RIFF");

    // Upload response carries the new content hash so the client can compose
    // the cacheable URL immediately.
    expect(typeof body.hash).toBe("string");
    expect(body.hash).toMatch(/^[0-9a-f]{16}$/);

    // profiles.get returns the same hash.
    const profile = await alice.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(profile.avatar_hash).toBe(body.hash);
  });

  test("upload rejects MIME outside whitelist", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao2@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 2" });
    const { client: alice } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice2@example.com", "secret123", "Alice");

    const form = new FormData();
    form.append("file", new File([new Uint8Array([0, 1, 2, 3])], "junk.bin", {
      type: "application/octet-stream",
    }));
    const res = await postMultipart(alice, ctx.app, `/api/avatars/${conf.slug}/upload`, form);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_mime");
  });

  test("GET returns SVG fallback when no avatar file is set", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao3@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 3" });
    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice3@example.com", "secret123", "Alice");

    // Publish so the visibility check passes for a fresh GET as alice herself.
    await alice.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });

    const res = await getRaw(alice, ctx.app, `/api/avatars/${conf.slug}/${aliceId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("image/svg+xml");
    const body = await res.text();
    expect(body).toContain("<svg");
    // SVG includes the initials derived from the name "Alice".
    expect(body).toContain(">A<");
  });

  test("hashed URL with matching hash returns immutable Cache-Control", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao4@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 4" });
    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice4@example.com", "secret123", "Alice");
    // Publish so the avatar bytes are public-cacheable.
    await alice.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });

    const form = new FormData();
    form.append("file", new File([new Uint8Array(tinyPng)], "tiny.png", { type: "image/png" }));
    const up = await postMultipart(alice, ctx.app, `/api/avatars/${conf.slug}/upload`, form);
    expect(up.status).toBe(200);
    const { hash } = await up.json() as { hash: string };

    // Anonymous fetch -- no cookies. Published avatars don't need auth, which
    // is what makes them CDN-cacheable.
    const res = await ctx.app.request(`http://test.local/api/avatars/${conf.slug}/${aliceId}/${hash}`, {
      method: "GET",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("public");
    expect(cc).toContain("immutable");
    expect(cc).toContain("max-age=31536000");
  });

  test("hashed URL with stale hash returns no-store (still serves current bytes)", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao4b@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 4b" });
    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice4b@example.com", "secret123", "Alice");
    await alice.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });

    const form = new FormData();
    form.append("file", new File([new Uint8Array(tinyPng)], "tiny.png", { type: "image/png" }));
    const up = await postMultipart(alice, ctx.app, `/api/avatars/${conf.slug}/upload`, form);
    expect(up.status).toBe(200);

    // Fetch with a bogus hash that won't match. The endpoint must still serve
    // bytes (no 404 churn) but tell every cache layer to drop the response.
    const res = await ctx.app.request(
      `http://test.local/api/avatars/${conf.slug}/${aliceId}/badbadbadbadbad0`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("unpublished avatar hashed URL forces principal lookup and uses private cache", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao4c@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 4c" });
    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice4c@example.com", "secret123", "Alice");

    // Alice uploads an avatar but stays unpublished.
    const form = new FormData();
    form.append("file", new File([new Uint8Array(tinyPng)], "tiny.png", { type: "image/png" }));
    const up = await postMultipart(alice, ctx.app, `/api/avatars/${conf.slug}/upload`, form);
    expect(up.status).toBe(200);
    const { hash } = await up.json() as { hash: string };

    // Self can see it -- private cache only.
    const selfRes = await getRaw(alice, ctx.app, `/api/avatars/${conf.slug}/${aliceId}/${hash}`);
    expect(selfRes.status).toBe(200);
    expect(selfRes.headers.get("content-type")).toBe("image/webp");
    const cc = selfRes.headers.get("cache-control") ?? "";
    expect(cc).toContain("private");
    expect(cc).not.toContain("public");
  });

  test("unpublished profile viewed by non-mod returns SVG (existence leak guard)", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao5@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 5" });
    const { identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice5@example.com", "secret123", "Alice");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "bob5@example.com", "secret123", "Bob");

    // Alice stays unpublished (default). Bob (non-mod) tries to fetch Alice's avatar.
    const res = await getRaw(bob, ctx.app, `/api/avatars/${conf.slug}/${aliceId}`);
    // 200 with an SVG -- NOT 404. The status code can't distinguish "unpublished"
    // from "published but no file".
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("image/svg+xml");
    const body = await res.text();
    // Name must not leak -- the generic SVG renders "?" when name is null.
    expect(body).toContain(">?<");
    expect(body).not.toContain(">A<");
  });

  test("upload rejects files over 5MB", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao7@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 7" });
    const { client: alice } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice7@example.com", "secret123", "Alice");

    // 5MB + 1 byte payload with a valid PNG mime so we hit the size guard
    // (not the mime whitelist). Content doesn't have to be a real PNG —
    // sharp would normally reject it, but the size check fires first.
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const form = new FormData();
    form.append("file", new File([big], "big.png", { type: "image/png" }));
    const res = await postMultipart(alice, ctx.app, `/api/avatars/${conf.slug}/upload`, form);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("too_large");
  });

  test("mod can upload to another identity via identity_id form field", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao8@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 8" });
    const { identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice8@example.com", "secret123", "Alice");

    // Owner (mod-level) uploads on Alice's behalf by passing identity_id.
    const form = new FormData();
    form.append("file", new File([new Uint8Array(tinyPng)], "tiny.png", { type: "image/png" }));
    form.append("identity_id", String(aliceId));
    const res = await postMultipart(owner, ctx.app, `/api/avatars/${conf.slug}/upload`, form);
    expect(res.status).toBe(200);

    // Alice now has an avatar hash even though she never uploaded one.
    const alice = await owner.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(alice.avatar_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("participant cannot upload to another identity", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao9@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 9" });
    const { identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice9@example.com", "secret123", "Alice");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "bob9@example.com", "secret123", "Bob");

    // Bob (participant) tries to overwrite Alice's avatar. Forbidden.
    const form = new FormData();
    form.append("file", new File([new Uint8Array(tinyPng)], "tiny.png", { type: "image/png" }));
    form.append("identity_id", String(aliceId));
    const res = await postMultipart(bob, ctx.app, `/api/avatars/${conf.slug}/upload`, form);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("deleteAvatar removes file + nulls avatarPath/avatarHash", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "ao6@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatars 6" });
    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice6@example.com", "secret123", "Alice");

    const form = new FormData();
    form.append("file", new File([new Uint8Array(tinyPng)], "tiny.png", { type: "image/png" }));
    const up = await postMultipart(alice, ctx.app, `/api/avatars/${conf.slug}/upload`, form);
    expect(up.status).toBe(200);

    // Find the on-disk file via the documented layout.
    const dirEntries = await ctx.prisma.conference.findUnique({
      where: { slug: conf.slug }, select: { id: true },
    });
    const confId = dirEntries!.id;
    const filePath = join(avatarDir, String(confId), `${aliceId}.webp`);
    expect(existsSync(filePath)).toBe(true);

    const before = await alice.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(before.avatar_hash).toMatch(/^[0-9a-f]{16}$/);

    await alice.rpc.profiles.deleteAvatar({ slug: conf.slug });

    expect(existsSync(filePath)).toBe(false);
    const after = await alice.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(after.avatar_hash).toBeNull();
  });
});
