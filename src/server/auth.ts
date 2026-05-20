// Auth helpers: password hashing (Bun.password), session creation, cookie I/O.
//
// Sessions hold exactly one principal:
//   - Owner: addressed by the global cookie `uncon_session`. Session row has
//     `userId` set, `conferenceIdentityId` null.
//   - Identity: addressed by a per-conference cookie `uncon_session_<confId>`.
//     Session row has `conferenceIdentityId` set, `userId` null. Browsers can
//     therefore hold many identity logins (one per conference) concurrently
//     without one clobbering another.
//
// `principalFromRequest` is the single entry point for "who is calling?". It
// takes an explicit scope so callers cannot accidentally read the wrong cookie.

import type { ConferenceIdentity, PrismaClient, User } from "@prisma/client";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OWNER_COOKIE_NAME = "uncon_session";

export function ownerCookieName(): string {
  return OWNER_COOKIE_NAME;
}

export function identityCookieName(conferenceId: number): string {
  return `${OWNER_COOKIE_NAME}_${conferenceId}`;
}

// ----- password ------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

// ----- session creation ----------------------------------------------------

function newSessionToken(): string {
  return crypto.randomUUID() + "-" + crypto.randomUUID();
}

export async function createOwnerSession(prisma: PrismaClient, userId: number): Promise<string> {
  const token = newSessionToken();
  const now = new Date();
  await prisma.session.create({
    data: {
      token,
      userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    },
  });
  return token;
}

export async function createIdentitySession(
  prisma: PrismaClient,
  conferenceIdentityId: number,
): Promise<string> {
  const token = newSessionToken();
  const now = new Date();
  await prisma.session.create({
    data: {
      token,
      conferenceIdentityId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    },
  });
  return token;
}

export async function destroySession(prisma: PrismaClient, token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { token } });
}

// ----- cookie I/O (raw fetch Request/Headers; no Hono dependency) ----------

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return undefined;
}

interface CookieOpts {
  maxAge?: number;
  clear?: boolean;
}

function appendCookie(
  headers: Headers,
  name: string,
  value: string,
  opts: CookieOpts = {},
): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.clear) parts.push("Max-Age=0");
  else if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  headers.append("set-cookie", parts.join("; "));
}

export function setOwnerCookie(headers: Headers, token: string): void {
  appendCookie(headers, ownerCookieName(), token, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearOwnerCookie(headers: Headers): void {
  appendCookie(headers, ownerCookieName(), "", { clear: true });
}

export function setIdentityCookie(headers: Headers, conferenceId: number, token: string): void {
  appendCookie(headers, identityCookieName(conferenceId), token, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearIdentityCookie(headers: Headers, conferenceId: number): void {
  appendCookie(headers, identityCookieName(conferenceId), "", { clear: true });
}

// ----- principal resolution -----------------------------------------------

export type PrincipalScope =
  | { type: "owner" }
  | { type: "conference"; conferenceId: number };

export type Principal =
  | { kind: "owner"; user: User; token: string }
  | { kind: "identity"; identity: ConferenceIdentity; token: string };

export async function principalFromRequest(
  prisma: PrismaClient,
  req: Request,
  scope: PrincipalScope,
): Promise<Principal | null> {
  if (scope.type === "owner") {
    const token = readCookie(req, ownerCookieName());
    if (!token) return null;
    const row = await prisma.session.findUnique({
      where: { token },
      include: { user: true },
    });
    if (!row || !row.user) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return { kind: "owner", user: row.user, token };
  }

  const token = readCookie(req, identityCookieName(scope.conferenceId));
  if (!token) return null;
  const row = await prisma.session.findUnique({
    where: { token },
    include: { identity: true },
  });
  if (!row || !row.identity) return null;
  // Defence in depth: refuse to honour a session whose identity belongs to a
  // different conference (would only happen if cookies were tampered with).
  if (row.identity.conferenceId !== scope.conferenceId) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return { kind: "identity", identity: row.identity, token };
}
