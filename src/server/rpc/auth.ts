import { ORPCError } from "@orpc/server";
import { base, authed, toUserOut } from "./shared";
import {
  hashPassword, verifyPassword,
  createOwnerSession, destroySession,
  setOwnerCookie, clearOwnerCookie,
  readCookie, ownerCookieName,
} from "../auth";
import {
  assertLoginAllowed, recordLoginFailure, recordLoginSuccess,
} from "../lib/limits";
import { assertTurnstile } from "../lib/turnstile";
import { isSignupDisabled } from "./config";

export const authRouter = {
  signup: base.auth.signup.handler(async ({ input, context }) => {
    if (isSignupDisabled()) {
      throw new ORPCError("FORBIDDEN", { message: "signup_disabled" });
    }
    await assertTurnstile(input.turnstile_token);
    const existing = await context.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ORPCError("CONFLICT", { message: "email_taken" });
    const passwordHash = await hashPassword(input.password);
    const user = await context.prisma.user.create({
      data: { email: input.email, name: input.name?.trim() || null, passwordHash },
    });
    const token = await createOwnerSession(context.prisma, user.id);
    setOwnerCookie(context.responseHeaders, token);
    return toUserOut(user);
  }),

  login: base.auth.login.handler(async ({ input, context }) => {
    // Per-email lockout runs BEFORE Turnstile so we don't burn challenge
    // resources on already-locked accounts.
    assertLoginAllowed(input.email);
    await assertTurnstile(input.turnstile_token);
    const user = await context.prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      recordLoginFailure(input.email);
      throw new ORPCError("UNAUTHORIZED", { message: "invalid_credentials" });
    }
    recordLoginSuccess(input.email);
    const token = await createOwnerSession(context.prisma, user.id);
    setOwnerCookie(context.responseHeaders, token);
    return toUserOut(user);
  }),

  logout: base.auth.logout.handler(async ({ context }) => {
    const token = readCookie(context.req, ownerCookieName());
    if (token) await destroySession(context.prisma, token);
    clearOwnerCookie(context.responseHeaders);
    return { ok: true as const };
  }),

  me: authed.auth.me.handler(async ({ context }) => {
    return toUserOut(context.user);
  }),

  // Self-service deletion of the calling owner's User row. Sessions cascade
  // (FK onDelete: Cascade), so all the user's other devices are signed out.
  //
  // Refuses when the caller still owns conferences — those carry other
  // people's data (submissions, stars, bookings) and shouldn't be silently
  // orphaned. Caller must first delete each conference via
  // `conferences.delete` or transfer it via `conferences.transferOwnership`.
  // The error data carries the owned slugs so the UI can list them.
  deleteSelf: authed.auth.deleteSelf.handler(async ({ context }) => {
    const owned = await context.prisma.conference.findMany({
      where: { ownerId: context.user.id },
      select: { slug: true },
    });
    if (owned.length > 0) {
      throw new ORPCError("FORBIDDEN", {
        message: "owned_conferences_present",
        data: { owned: owned.map((c) => c.slug) },
      });
    }
    await context.prisma.user.delete({ where: { id: context.user.id } });
    clearOwnerCookie(context.responseHeaders);
    return { ok: true as const };
  }),
};
