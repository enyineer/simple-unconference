// End-to-end tests for /api/metrics. Covers the auth gate and the basic
// shape of the Prometheus exposition. We don't try to assert on real
// storage numbers — those depend on the host's FS — only that the lines
// are present and parse correctly.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestApp, type TestApp } from "../test-helpers";

async function scrape(app: TestApp["app"], headers: HeadersInit = {}): Promise<Response> {
  return app.fetch(new Request("http://test.local/api/metrics", { headers }));
}

describe("metrics endpoint", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await ctx.cleanup();
  });

  test("open endpoint serves Prometheus text format when METRICS_TOKEN is unset", async () => {
    delete process.env.METRICS_TOKEN;
    const res = await scrape(ctx.app);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/plain");
    const body = await res.text();
    // Header lines per metric family
    expect(body).toContain("# HELP app_uptime_seconds");
    expect(body).toContain("# TYPE app_uptime_seconds gauge");
    // A handful of expected counters
    expect(body).toMatch(/^conferences_total \d+$/m);
    expect(body).toMatch(/^submissions_total \d+$/m);
    expect(body).toMatch(/^conference_identities_total \d+$/m);
    expect(body).toMatch(/^stars_total \d+$/m);
    expect(body).toMatch(/^storage_db_file_bytes \d+$/m);
    // No trailing junk — last line should end with newline
    expect(body.endsWith("\n")).toBe(true);
  });

  test("returns 401 when METRICS_TOKEN is set and no Authorization header is provided", async () => {
    process.env.METRICS_TOKEN = "smoke-test-token";
    const res = await scrape(ctx.app);
    expect(res.status).toBe(401);
  });

  test("rejects a wrong Bearer token with 401", async () => {
    process.env.METRICS_TOKEN = "smoke-test-token";
    const res = await scrape(ctx.app, { authorization: "Bearer not-the-token" });
    expect(res.status).toBe(401);
  });

  test("accepts the configured token", async () => {
    process.env.METRICS_TOKEN = "smoke-test-token";
    const res = await scrape(ctx.app, { authorization: "Bearer smoke-test-token" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("conferences_total");
  });
});
