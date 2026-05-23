// Tests for the metrics HTTP handler. Exercises createMetricsHandler with
// fake render() functions so we don't bind a real port; the renderLocal
// path is covered via collect.test.ts + aggregate.test.ts.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestApp, type TestApp } from "../test-helpers";
import { createMetricsHandler, renderLocal } from "./server";

const RENDERED = "# HELP example_metric A test metric\n# TYPE example_metric gauge\nexample_metric 1\n";

function makeHandler(render = async () => RENDERED) {
  return createMetricsHandler({ render });
}

async function call(handler: ReturnType<typeof makeHandler>, path: string, headers: HeadersInit = {}): Promise<Response> {
  return handler(new Request(`http://test.local${path}`, { headers }));
}

describe("metrics HTTP handler", () => {
  test("open endpoint serves Prometheus text when METRICS_TOKEN unset", async () => {
    delete process.env.METRICS_TOKEN;
    const res = await call(makeHandler(), "/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/plain");
    expect(await res.text()).toBe(RENDERED);
  });

  test("returns 401 when METRICS_TOKEN is set and no Authorization header is provided", async () => {
    process.env.METRICS_TOKEN = "smoke-test-token";
    try {
      const res = await call(makeHandler(), "/metrics");
      expect(res.status).toBe(401);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });

  test("rejects a wrong Bearer token with 401", async () => {
    process.env.METRICS_TOKEN = "smoke-test-token";
    try {
      const res = await call(makeHandler(), "/metrics", { authorization: "Bearer not-the-token" });
      expect(res.status).toBe(401);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });

  test("accepts the configured token and renders body", async () => {
    process.env.METRICS_TOKEN = "smoke-test-token";
    try {
      const res = await call(makeHandler(), "/metrics", { authorization: "Bearer smoke-test-token" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(RENDERED);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });

  test("returns 404 for any path other than /metrics", async () => {
    delete process.env.METRICS_TOKEN;
    const res = await call(makeHandler(), "/health");
    expect(res.status).toBe(404);
    const res2 = await call(makeHandler(), "/api/metrics");
    expect(res2.status).toBe(404);
  });
});

describe("renderLocal end-to-end", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("emits the expected metric families for a single-worker render", async () => {
    const body = await renderLocal(ctx.prisma, Date.now() - 1000);
    // Cluster-state metrics
    expect(body).toMatch(/^# HELP app_uptime_seconds /m);
    expect(body).toMatch(/^# TYPE app_uptime_seconds gauge$/m);
    expect(body).toMatch(/^app_workers_total 1$/m);
    expect(body).toMatch(/^app_workers_stale_total 0$/m);
    // Global counts (single worker always carries them)
    expect(body).toMatch(/^conferences_total \d+$/m);
    expect(body).toMatch(/^submissions_total \d+$/m);
    expect(body).toMatch(/^chat_messages_total \d+$/m);
    expect(body).toMatch(/^storage_db_file_bytes \d+$/m);
    // Per-worker series carries worker="0"
    expect(body).toMatch(/^realtime_sse_active_connections\{worker="0"\} 0$/m);
    expect(body.endsWith("\n")).toBe(true);
  });
});
