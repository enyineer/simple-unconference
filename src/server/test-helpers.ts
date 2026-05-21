// Test helpers: build an isolated app + Prisma client backed by a fresh SQLite file,
// and provide a small `request` helper that propagates cookies across calls.

import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { buildApp } from "./index";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "./rpc";
import { __resetLimitsState } from "./lib/limits";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface TestApp {
  app: ReturnType<typeof buildApp>;
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}

export function setupTestApp(): TestApp {
  // Reset in-memory anti-abuse stores so per-describe tests don't leak state
  // (login lockouts and write-rate counters live at module scope).
  __resetLimitsState();

  const dir = mkdtempSync(join(tmpdir(), "uncon-test-"));
  const dbPath = join(dir, "test.sqlite");
  const url = `file:${dbPath}`;

  // Apply schema via `prisma db push` to a temp DB. Prisma 7 reads the URL
  // from prisma.config.ts unless we override with --url.
  const result = spawnSync(
    "bunx",
    ["prisma", "db", "push", "--url", url],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`prisma db push failed: ${result.stderr || result.stdout}`);
  }

  const adapter = new PrismaLibSql({ url });
  const prisma = new PrismaClient({ adapter });
  const app = buildApp(prisma);

  const cleanup = async () => {
    await prisma.$disconnect();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  };

  return { app, prisma, cleanup };
}

/**
 * Tiny test client. Stores cookies between calls so authenticated flows are easy to write.
 */
export class Client {
  cookies = new Map<string, string>();
  /** Fully-typed oRPC client backed by the test app's fetch handler.
   *  Use this for all API calls: `await c.rpc.auth.signup({ ... })`. */
  readonly rpc: RouterClient<AppRouter>;

  constructor(private app: ReturnType<typeof buildApp>) {
    const link = new RPCLink({
      url: "http://test.local/api",
      fetch: async (input, init) => {
        // Normalize the call style (RPCLink can pass either a Request or a
        // (url, init) pair) into a single Request we can mutate.
        const req = input instanceof Request
          ? new Request(input, init)
          : new Request(input as string, init);
        if (this.cookies.size > 0) {
          req.headers.set("cookie",
            [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
        }
        const res = await this.app.request(req);
        for (const h of res.headers.getSetCookie?.() ?? []) {
          const first = h.split(";")[0]!;
          const eq = first.indexOf("=");
          if (eq > 0) this.cookies.set(first.slice(0, eq), first.slice(eq + 1));
        }
        return res;
      },
    });
    this.rpc = createORPCClient(link);
  }

  // Raw HTTP request — kept for non-RPC routes (currently just the
  // text/calendar feed at /api/calendar/<token>.ics).
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      if (typeof body === "string") {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)["content-type"] = "application/json";
      }
    }
    if (this.cookies.size > 0) {
      (init.headers as Record<string, string>)["cookie"] = [...this.cookies.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }
    const res = await this.app.request(`http://test.local${path}`, init);
    const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
    for (const h of setCookieHeaders) {
      const first = h.split(";")[0]!;
      const eq = first.indexOf("=");
      if (eq > 0) this.cookies.set(first.slice(0, eq), first.slice(eq + 1));
    }
    return res;
  }
  get(p: string)             { return this.req("GET", p); }
  post(p: string, b?: any)   { return this.req("POST", p, b); }
  patch(p: string, b?: any)  { return this.req("PATCH", p, b); }
  put(p: string, b?: any)    { return this.req("PUT", p, b); }
  delete(p: string)          { return this.req("DELETE", p); }
}

// Re-export so test files can `instanceof` on RPC errors.
export { ORPCError };

// ---------------------------------------------------------------------------
// Per-conference identity helpers
//
// In the new model, signing up + logging in only authenticates an *owner*.
// To act as a participant inside a conference, you must claim an invite (or
// self-sign-up via the conference's join link). These helpers wrap the
// boilerplate so tests stay concise.

/** Sign up + log in a global owner. Returns a Client with the owner cookie set. */
export async function createOwner(
  app: ReturnType<typeof buildApp>,
  email: string,
  password = "secret123",
  name?: string,
): Promise<Client> {
  const c = new Client(app);
  await c.rpc.auth.signup({ email, password, name });
  return c;
}

/**
 * Invite an email as `inviter` (must be moderator+ in the conference), then
 * claim that invite as a brand-new Client. Returns the joined participant's
 * client + their ConferenceIdentity.id.
 */
export async function inviteAndClaim(
  app: ReturnType<typeof buildApp>,
  inviter: Client,
  slug: string,
  email: string,
  password = "secret123",
  name?: string,
): Promise<{ client: Client; identity_id: number }> {
  const invite = await inviter.rpc.conferences.createInvite({ slug, email });
  const c = new Client(app);
  const me = await c.rpc.conferences.claimInvite({
    slug, token: invite.token, password, name,
  });
  return { client: c, identity_id: me.id };
}

/**
 * Enable the conference's join link as `owner`, then self-sign-up a fresh
 * Client through it. Useful for tests that exercise the "secret URL"
 * onboarding path.
 */
export async function signupViaJoinLink(
  app: ReturnType<typeof buildApp>,
  owner: Client,
  slug: string,
  email: string,
  password = "secret123",
  name?: string,
): Promise<{ client: Client; identity_id: number }> {
  const link = await owner.rpc.conferences.setJoinLink({ slug, enabled: true });
  if (!link.token) throw new Error("join link token not minted");
  const c = new Client(app);
  const me = await c.rpc.conferences.signupViaLink({
    slug, token: link.token, email, password, name,
  });
  return { client: c, identity_id: me.id };
}
