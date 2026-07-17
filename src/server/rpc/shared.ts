// oRPC server router: every API procedure declared in `src/shared/contract.ts`
// is implemented here. The shape returned by each handler is checked at
// compile time against the contract via the `implement(contract)` pattern,
// so client/server drift surfaces as a TypeScript error.
//
// One exception: GET /api/calendar/<token>.ics is served directly by Hono
// (see `src/server/routes/calendar.ts`) because it produces text/calendar
// for third-party calendar clients to subscribe to.

import { implement, ORPCError } from "@orpc/server";
import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { contract } from "../../shared/contract";
import { principalFromRequest } from "../auth";
import {
  hasRoleAtLeast,
  resolveConferencePrincipal,
  type ResolvedPrincipal,
  type Role,
} from "../lib/permissions";
import { emailConfigured } from "../lib/email";

// ----- shared types ---------------------------------------------------------

export interface RpcContext {
  prisma: PrismaClient;
  // Raw fetch request — used to read session cookies + set Set-Cookie.
  req: Request;
  // Filled by handle() to forward Set-Cookie headers from the procedure
  // back into the final HTTP response.
  responseHeaders: Headers;
}

export function toUserOut(
  u: { id: number; email: string; name: string | null; emailVerifiedAt: Date | null },
) {
  return { id: u.id, email: u.email, name: u.name, email_verified: u.emailVerifiedAt !== null };
}

// Best-effort client IP for per-IP rate limiting. Behind our reverse proxy /
// ingress the real client is in `x-forwarded-for` (first hop) or `x-real-ip`;
// falls back to null when neither is present (e.g. tests), which the limiter
// treats as "skip the per-IP axis".
export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || null;
}

// Returns the acting identity's id for any conference-scoped handler. For
// owners this is the auto-minted ConferenceIdentity row; for identity-kind
// principals it is the identity itself.
export function actorIdentityId(ctx: { principal: ResolvedPrincipal }): number {
  return ctx.principal.identity.id;
}

// ----- implementer + middlewares -------------------------------------------

export const base = implement(contract).$context<RpcContext>();

// Owner-only auth gate. Reads the global cookie; raises UNAUTHORIZED otherwise.
export const authed = base.use(async ({ context, next }) => {
  const principal = await principalFromRequest(context.prisma, context.req, { type: "owner" });
  if (!principal || principal.kind !== "owner") {
    throw new ORPCError("UNAUTHORIZED", { message: "not_authenticated" });
  }
  return next({ context: { ...context, user: principal.user } });
});

// Like `authed`, but also requires the owner's email to be verified. No-op when
// no email transport is configured (nobody can verify, so we don't wall anyone
// out on a self-hosted box). Gates sensitive owner actions: conference creation
// and account linking.
export const verified = authed.use(async ({ context, next }) => {
  if (emailConfigured() && context.user.emailVerifiedAt === null) {
    throw new ORPCError("FORBIDDEN", { message: "email_unverified" });
  }
  return next();
});

// Conference-scoped gate. Resolves the principal for this conference (owner
// via global cookie OR per-conference identity cookie) and enforces minRole.
// Sets `conferenceId` and `principal` on context for downstream handlers.
export function requireConf(minRole: Role) {
  return base.use(async ({ context, next }, input) => {
    const slug = (input as { slug?: string }).slug;
    if (typeof slug !== "string") throw new ORPCError("BAD_REQUEST");
    const conf = await context.prisma.conference.findUnique({
      where: { slug }, select: { id: true },
    });
    if (!conf) throw new ORPCError("NOT_FOUND", { message: "conference_not_found" });
    const principal = await resolveConferencePrincipal(context.prisma, context.req, conf.id);
    if (!principal) {
      throw new ORPCError("UNAUTHORIZED", { message: "not_authenticated" });
    }
    if (!hasRoleAtLeast(principal.role, minRole)) {
      throw new ORPCError("FORBIDDEN");
    }
    return next({ context: { ...context, conferenceId: conf.id, principal } });
  });
}

// ----- small helpers reused across handlers --------------------------------

export function slugify(name: string): string {
  return (
    name.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "conf"
  );
}

// Slugify `name` and append `-2`, `-3`, … until the slug is free across all
// conferences. Shared by `conferences.create` and `conferences.duplicate`.
export async function generateUniqueSlug(
  prisma: PrismaClient,
  name: string,
): Promise<string> {
  const baseSlug = slugify(name);
  let slug = baseSlug;
  let n = 1;
  while (await prisma.conference.findUnique({ where: { slug }, select: { id: true } })) {
    n++;
    slug = `${baseSlug}-${n}`;
  }
  return slug;
}

export function normalizeLabels(input: string[] | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const v = raw.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Filters a normalized requirement list to values that actually exist as a
// `RoomTag.value` on any room in the given conference. The UI picker only
// offers existing tags, but we re-enforce server-side: a tag that no room
// carries would silently make the session unplaceable, so dropping it here
// gives the participant a clearer "your selection didn't stick" signal
// when the input goes through unverified channels.
export async function filterToExistingRoomTags(
  prisma: PrismaClient,
  conferenceId: number,
  values: string[],
): Promise<string[]> {
  if (values.length === 0) return [];
  const rows = await prisma.roomTag.findMany({
    where: { value: { in: values }, room: { conferenceId } },
    select: { value: true },
    distinct: ["value"],
  });
  const valid = new Set(rows.map((r) => r.value));
  return values.filter((v) => valid.has(v));
}

// ----- pagination helpers --------------------------------------------------

import type { Page } from "../../shared/contract";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Parse the shared `{ q?, cursor?, limit? }` page input into normalized
 * `offset` / `limit` / `q` values. `cursor` is treated as an opaque
 * offset token (decimal string) — anything else collapses to 0.
 */
export function parsePageInput(input: {
  q?: string;
  cursor?: string;
  limit?: number;
}): { offset: number; limit: number; q: string } {
  const rawOffset = input.cursor ? parseInt(input.cursor, 10) : 0;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, input.limit ?? DEFAULT_PAGE_SIZE),
  );
  const q = (input.q ?? "").trim();
  return { offset, limit, q };
}

/** Build a `Page<T>` envelope. `next_cursor` is `null` on the last page. */
export function pageOf<T>(
  items: T[],
  offset: number,
  limit: number,
  total: number,
): Page<T> {
  const nextOffset = offset + items.length;
  const next_cursor = nextOffset < total && items.length === limit
    ? String(nextOffset)
    : null;
  return { items, total, next_cursor };
}

// ----- invite + join-link + calendar helpers -------------------------------

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function newOpaqueToken(): string {
  // 64 hex characters. The calendar feed validator expects 16-128 hex, so
  // the same shape works for invite / join-link / calendar tokens alike.
  return randomBytes(32).toString("hex");
}

export function joinUrl(slug: string, token: string): string {
  return `/c/${slug}/join?t=${token}`;
}

// Relative path to the public read-only Live Board. Hashless, exactly like
// `joinUrl` above: the web client turns it absolute with `absoluteUrl`, which
// prepends `${origin}/#`. Returning the `/#` here too would double it
// (`${origin}/#/#/board/...`) and break the hash-route match. The token is the
// secret — anyone with this URL can view the board.
export function boardUrl(slug: string, token: string): string {
  return `/board/${slug}?t=${token}`;
}

export function calendarFeedPath(token: string): string {
  return `/api/calendar/${token}.ics`;
}

type InviteRow = {
  id: number;
  email: string;
  token: string;
  role: "moderator" | "participant";
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  conference: { slug: string };
};

export function toInviteOut(invite: InviteRow): {
  id: number; email: string; token: string; url: string;
  role: "moderator" | "participant";
  created_at: number; expires_at: number; claimed_at: number | null;
} {
  return {
    id: invite.id,
    email: invite.email,
    token: invite.token,
    url: joinUrl(invite.conference.slug, invite.token),
    role: invite.role,
    created_at: invite.createdAt.getTime(),
    expires_at: invite.expiresAt.getTime(),
    claimed_at: invite.claimedAt?.getTime() ?? null,
  };
}

// Resolves a submission's "finished" state against the conference default.
// A submission is finished when the moderator manually flagged it, or when
// the placement count meets/exceeds the effective cap (per-submission override
// falls back to Conference.submissionMaxPlacementsDefault).
//
// `placement_count` here is the sum of static TrackAssignments and
// UnconferencePlacements pointing at this submission. Both count because
// either kind of placement means the talk has been "given" in the schedule.
export function resolveFinished(
  sub: { maxPlacements: number | null; manuallyFinished: boolean },
  confDefault: number | null,
  placementCount: number,
): { effective_cap: number | null; is_finished: boolean } {
  const cap = sub.maxPlacements ?? confDefault;
  if (sub.manuallyFinished) return { effective_cap: cap, is_finished: true };
  if (cap === null) return { effective_cap: null, is_finished: false };
  return { effective_cap: cap, is_finished: placementCount >= cap };
}

// Conference-scoped identity payload returned by login / claim / signup / me.
// `profilePublished` / `profileCompletionDismissed` carry the first-login
// nudge state so the web shell can decide whether to render the banner
// without an extra `profiles.get` round-trip.
export function toConfMeOut(identity: {
  id: number; email: string; name: string | null; role: "moderator" | "participant";
  colorMode: string; ownerUserId: number | null;
  profilePublished: boolean;
  profileCompletionDismissed: boolean;
}): {
  id: number; email: string; name: string | null;
  role: "owner" | "moderator" | "participant";
  color_mode: "auto" | "light" | "dark";
  profile_published: boolean;
  profile_completion_dismissed: boolean;
} {
  const cm = (identity.colorMode === "light" || identity.colorMode === "dark"
    ? identity.colorMode
    : "auto") as "auto" | "light" | "dark";
  const role = identity.ownerUserId !== null ? "owner" as const : identity.role;
  return {
    id: identity.id,
    email: identity.email,
    name: identity.name,
    role,
    color_mode: cm,
    profile_published: identity.profilePublished,
    profile_completion_dismissed: identity.profileCompletionDismissed,
  };
}
