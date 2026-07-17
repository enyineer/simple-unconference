// Per-conference PWA install: web app manifest route + owner-uploaded custom
// app icon + the `icon_hash` DTO on conferences.get. Mirrors avatars.test.ts:
// an isolated CONFERENCE_ICON_DIR via mkdtempSync keeps uploads out of the repo
// and out of other describe blocks, and multipart POSTs go through a helper
// (the oRPC Client can't model binary bodies).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import {
  setupTestApp, Client, type TestApp,
  inviteAndClaim,
} from "./test-helpers";

// POST multipart/form-data to a non-RPC route, carrying the Client's cookies so
// the principal resolves. We deliberately don't set content-type — fetch
// derives the multipart boundary from the FormData body.
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
  return await app.request(`http://test.local${path}`, {
    method: "POST",
    headers,
    body: form,
  });
}

async function getRaw(app: TestApp["app"], path: string): Promise<Response> {
  return await app.request(`http://test.local${path}`, { method: "GET" });
}

// A real, decodable raster generated once and reused. Non-square on purpose so
// the `contain` fit + background flatten are exercised end to end.
let srcRaster: Buffer;

describe("conference PWA manifest + custom icon", () => {
  let ctx: TestApp;
  let iconDir: string;
  let prevDir: string | undefined;

  beforeAll(async () => {
    iconDir = mkdtempSync(join(tmpdir(), "uncon-conf-icons-"));
    prevDir = process.env.CONFERENCE_ICON_DIR;
    process.env.CONFERENCE_ICON_DIR = iconDir;
    ctx = setupTestApp();
    srcRaster = await sharp({
      create: { width: 40, height: 24, channels: 3, background: { r: 12, g: 180, b: 90 } },
    }).png().toBuffer();
  });
  afterAll(async () => {
    await ctx.cleanup();
    if (existsSync(iconDir)) rmSync(iconDir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.CONFERENCE_ICON_DIR;
    else process.env.CONFERENCE_ICON_DIR = prevDir;
  });

  // ---- manifest route -----------------------------------------------------

  test("manifest exposes conference name, absolute start_url, distinct id, colors", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw1@example.com", password: "secret123", name: "Owner" });
    const conf = await owner.rpc.conferences.create({ name: "Manifest Fest" });

    const res = await getRaw(ctx.app, `/api/manifest/${conf.slug}.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/manifest+json");

    const m = await res.json() as {
      name: string; short_name: string; start_url: string; scope: string;
      id: string; display: string; theme_color: string; background_color: string;
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(m.name).toBe("Manifest Fest");
    expect(m.short_name).toBe("Manifest Fest");
    expect(m.start_url).toBe(`/#/conferences/${conf.slug}`);
    expect(m.scope).toBe("/");
    expect(m.id).toBe(`/?app=${conf.slug}`);
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe("#0a0d12");
    expect(m.background_color).toBe("#0a0d12");
  });

  test("manifest id differs per conference (distinct installable apps)", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw2@example.com", password: "secret123" });
    const a = await owner.rpc.conferences.create({ name: "Conf A" });
    const b = await owner.rpc.conferences.create({ name: "Conf B" });

    const ma = await (await getRaw(ctx.app, `/api/manifest/${a.slug}.webmanifest`)).json() as { id: string };
    const mb = await (await getRaw(ctx.app, `/api/manifest/${b.slug}.webmanifest`)).json() as { id: string };
    expect(ma.id).not.toBe(mb.id);
  });

  test("manifest icons default when no custom icon is set", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw3@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Defaults" });

    const m = await (await getRaw(ctx.app, `/api/manifest/${conf.slug}.webmanifest`)).json() as {
      icons: { src: string; sizes: string; type: string }[];
    };
    const srcs = m.icons.map((i) => i.src);
    expect(srcs).toContain("/icon-192.png");
    expect(srcs).toContain("/icon-512.png");
    expect(srcs).toContain("/icon.svg");
  });

  test("manifest icons become hash-cache-busted conference-icon URLs after upload", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw4@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Custom Icon" });

    const form = new FormData();
    form.append("file", new File([new Uint8Array(srcRaster)], "logo.png", { type: "image/png" }));
    const up = await postMultipart(owner, ctx.app, `/api/conference-icons/${conf.slug}/upload`, form);
    expect(up.status).toBe(200);
    const { hash } = await up.json() as { hash: string };

    const m = await (await getRaw(ctx.app, `/api/manifest/${conf.slug}.webmanifest`)).json() as {
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    const srcs = m.icons.map((i) => i.src);
    expect(srcs).toContain(`/api/conference-icons/${conf.slug}/192/${hash}`);
    expect(srcs).toContain(`/api/conference-icons/${conf.slug}/512/${hash}`);
    // Custom icons are declared maskable-safe.
    expect(m.icons.every((i) => i.purpose === "any maskable")).toBe(true);
  });

  test("manifest 404s on an unknown slug", async () => {
    const res = await getRaw(ctx.app, `/api/manifest/no-such-conf.webmanifest`);
    expect(res.status).toBe(404);
  });

  // ---- icon upload / serve ------------------------------------------------

  test("owner upload stores 192 + 512 PNGs; served bytes decode at each size", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw5@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Sizes" });

    const form = new FormData();
    form.append("file", new File([new Uint8Array(srcRaster)], "logo.png", { type: "image/png" }));
    const up = await postMultipart(owner, ctx.app, `/api/conference-icons/${conf.slug}/upload`, form);
    expect(up.status).toBe(200);
    const { hash } = await up.json() as { hash: string };
    expect(hash).toMatch(/^[0-9a-f]{16}$/);

    for (const size of [192, 512] as const) {
      const res = await getRaw(ctx.app, `/api/conference-icons/${conf.slug}/${size}/${hash}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBe(size);
      expect(meta.height).toBe(size);
    }
  });

  test("hashed GET with matching hash is immutable-cacheable", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw6@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Cache" });

    const form = new FormData();
    form.append("file", new File([new Uint8Array(srcRaster)], "logo.png", { type: "image/png" }));
    const up = await postMultipart(owner, ctx.app, `/api/conference-icons/${conf.slug}/upload`, form);
    const { hash } = await up.json() as { hash: string };

    const res = await getRaw(ctx.app, `/api/conference-icons/${conf.slug}/192/${hash}`);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("immutable");
    expect(cc).toContain("max-age=31536000");
  });

  test("re-upload changes iconHash", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw7@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Rehash" });

    const first = new FormData();
    first.append("file", new File([new Uint8Array(srcRaster)], "a.png", { type: "image/png" }));
    const h1 = (await (await postMultipart(owner, ctx.app, `/api/conference-icons/${conf.slug}/upload`, first)).json() as { hash: string }).hash;

    const other = await sharp({
      create: { width: 30, height: 30, channels: 3, background: { r: 200, g: 10, b: 10 } },
    }).png().toBuffer();
    const second = new FormData();
    second.append("file", new File([new Uint8Array(other)], "b.png", { type: "image/png" }));
    const h2 = (await (await postMultipart(owner, ctx.app, `/api/conference-icons/${conf.slug}/upload`, second)).json() as { hash: string }).hash;

    expect(h2).not.toBe(h1);
  });

  test("non-owner upload is rejected", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw8@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Owner Only" });
    const { client: alice } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice8@example.com", "secret123", "Alice");

    const form = new FormData();
    form.append("file", new File([new Uint8Array(srcRaster)], "logo.png", { type: "image/png" }));
    const res = await postMultipart(alice, ctx.app, `/api/conference-icons/${conf.slug}/upload`, form);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("hashless / no-icon GET serves the default PNG (never 404)", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw9@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "No Icon" });

    // No custom icon uploaded: still 200 with real default PNG bytes.
    const res = await getRaw(ctx.app, `/api/conference-icons/${conf.slug}/192`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe("png");
  });

  test("clear reverts to default and nulls icon_hash", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw10@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Clearable" });

    const form = new FormData();
    form.append("file", new File([new Uint8Array(srcRaster)], "logo.png", { type: "image/png" }));
    await postMultipart(owner, ctx.app, `/api/conference-icons/${conf.slug}/upload`, form);

    const withIcon = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(withIcon.icon_hash).toMatch(/^[0-9a-f]{16}$/);

    await owner.rpc.conferences.clearIcon({ slug: conf.slug });

    const cleared = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(cleared.icon_hash).toBeNull();

    // Manifest falls back to the defaults again.
    const m = await (await getRaw(ctx.app, `/api/manifest/${conf.slug}.webmanifest`)).json() as {
      icons: { src: string }[];
    };
    expect(m.icons.map((i) => i.src)).toContain("/icon-192.png");
  });

  // ---- DTO ---------------------------------------------------------------

  test("conferences.get exposes icon_hash (null default, set after upload)", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "pw11@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "DTO" });

    const before = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(before.icon_hash).toBeNull();

    const form = new FormData();
    form.append("file", new File([new Uint8Array(srcRaster)], "logo.png", { type: "image/png" }));
    const up = await postMultipart(owner, ctx.app, `/api/conference-icons/${conf.slug}/upload`, form);
    const { hash } = await up.json() as { hash: string };

    const after = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(after.icon_hash).toBe(hash);
  });
});
