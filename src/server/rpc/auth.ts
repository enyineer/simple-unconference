import { ORPCError } from "@orpc/server";
import { base, authed, toUserOut, clientIp } from "./shared";
import {
  hashPassword, verifyPassword,
  createOwnerSession, destroySession,
  setOwnerCookie, clearOwnerCookie,
  readCookie, ownerCookieName,
} from "../auth";
import {
  assertLoginAllowed, recordLoginFailure, recordLoginSuccess,
  assertPasswordResetAllowed, assertVerifyResendAllowed,
} from "../lib/limits";
import { assertTurnstile } from "../lib/turnstile";
import {
  generateResetToken, hashResetToken, resetTokenTtlMs, resetTokenTtlMinutes,
  ownerResetUrl,
} from "../lib/password-reset";
import {
  generateVerifyToken, generateVerifyCode, hashVerifyToken, hashVerifyCode,
  codeTtlMs, linkTtlMs, codeTtlMinutes, verifyUrl, MAX_CODE_ATTEMPTS,
} from "../lib/email-verify";
import { sendPasswordResetEmail, sendVerificationEmail, emailConfigured } from "../lib/email";
import { isSignupDisabled } from "./config";

// Clears every pending-verification column. Reused by both verify paths.
const VERIFY_CLEARED = {
  emailVerifyCodeHash: null,
  emailVerifyCodeExpiresAt: null,
  emailVerifyTokenHash: null,
  emailVerifyLinkExpiresAt: null,
  emailVerifyAttempts: 0,
} as const;

export const authRouter = {
  signup: base.auth.signup.handler(async ({ input, context }) => {
    if (isSignupDisabled()) {
      throw new ORPCError("FORBIDDEN", { message: "signup_disabled" });
    }
    await assertTurnstile(input.turnstile_token, clientIp(context.req) ?? undefined);

    const passwordHash = await hashPassword(input.password);
    const name = input.name?.trim() || null;
    const verify = emailConfigured();

    // A *verified* account owns this email. A pending/unverified row (e.g. an
    // attacker who squatted the address but never received the email) is
    // reclaimable: we overwrite it below and re-send verification, so whoever
    // can actually complete verification wins. Ownership = the verification
    // link, never the signup row.
    //
    // Reclaim is intentionally NOT gated on link expiry (the plan's first cut
    // said "expired only"): only the mailbox owner can ever complete
    // verification, so a fresh in-flight pending row carries no ownership worth
    // protecting, and gating on expiry would instead block a legitimate user
    // who simply didn't receive the first email from re-signing-up for up to
    // the link TTL. Abandoned unverified rows are cleaned up by the reaper
    // (lib/reaper.ts) rather than left to accumulate.
    const existing = await context.prisma.user.findUnique({ where: { email: input.email } });
    if (existing && existing.emailVerifiedAt !== null) {
      throw new ORPCError("CONFLICT", { message: "email_taken" });
    }

    const baseData = { passwordHash, name };
    let user;
    if (verify) {
      const code = generateVerifyCode();
      const token = generateVerifyToken();
      const now = Date.now();
      const data = {
        ...baseData,
        emailVerifiedAt: null,
        emailVerifyCodeHash: hashVerifyCode(code),
        emailVerifyCodeExpiresAt: new Date(now + codeTtlMs()),
        emailVerifyTokenHash: hashVerifyToken(token),
        emailVerifyLinkExpiresAt: new Date(now + linkTtlMs()),
        emailVerifyAttempts: 0,
      };
      user = existing
        ? await context.prisma.user.update({ where: { id: existing.id }, data })
        : await context.prisma.user.create({ data: { email: input.email, ...data } });
      const sessionToken = await createOwnerSession(context.prisma, user.id);
      setOwnerCookie(context.responseHeaders, sessionToken);
      await sendVerificationEmail({
        to: user.email,
        verifyUrl: verifyUrl(token),
        code,
        codeTtlMinutes: codeTtlMinutes(),
      });
    } else {
      // No email transport: auto-verify so a self-hosted box never locks out
      // its first owner.
      const data = { ...baseData, emailVerifiedAt: new Date(), ...VERIFY_CLEARED };
      user = existing
        ? await context.prisma.user.update({ where: { id: existing.id }, data })
        : await context.prisma.user.create({ data: { email: input.email, ...data } });
      const sessionToken = await createOwnerSession(context.prisma, user.id);
      setOwnerCookie(context.responseHeaders, sessionToken);
    }
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

  // Request a reset link for the global owner account. Always returns Ok —
  // whether or not the email maps to a real account — so the response can't be
  // used to enumerate registered owners. Rate-limited per-email + per-IP and
  // Turnstile-protected (both run BEFORE the user lookup).
  requestPasswordReset: base.auth.requestPasswordReset.handler(async ({ input, context }) => {
    assertPasswordResetAllowed(input.email, clientIp(context.req));
    await assertTurnstile(input.turnstile_token, clientIp(context.req) ?? undefined);

    const user = await context.prisma.user.findUnique({ where: { email: input.email } });
    if (user) {
      const token = generateResetToken();
      await context.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetTokenHash: hashResetToken(token),
          passwordResetExpiresAt: new Date(Date.now() + resetTokenTtlMs()),
        },
      });
      await sendPasswordResetEmail({
        to: user.email,
        resetUrl: ownerResetUrl(token),
        ttlMinutes: resetTokenTtlMinutes(),
      });
    }
    return { ok: true as const };
  }),

  // Consume a reset token: set the new password, clear the token, sign out all
  // existing sessions (a thief who knew the old password is kicked out), and
  // log the caller in on this device. Turnstile-protected. Expired / unknown /
  // already-used tokens all collapse to the same generic error.
  resetPassword: base.auth.resetPassword.handler(async ({ input, context }) => {
    await assertTurnstile(input.turnstile_token, clientIp(context.req) ?? undefined);

    const tokenHash = hashResetToken(input.token);
    const user = await context.prisma.user.findUnique({
      where: { passwordResetTokenHash: tokenHash },
    });
    if (!user || !user.passwordResetExpiresAt
        || user.passwordResetExpiresAt.getTime() <= Date.now()) {
      throw new ORPCError("BAD_REQUEST", { message: "invalid_or_expired_token" });
    }

    const passwordHash = await hashPassword(input.password);
    await context.prisma.$transaction([
      context.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
        },
      }),
      // Invalidate every existing owner session for this user.
      context.prisma.session.deleteMany({ where: { userId: user.id } }),
    ]);

    const token = await createOwnerSession(context.prisma, user.id);
    setOwnerCookie(context.responseHeaders, token);
    return toUserOut(user);
  }),

  // Confirm email with the 6-digit code. Authed: the signup session is already
  // set, so we verify the *current* user. Idempotent if already verified.
  // Wrong codes increment a counter and are rejected; past MAX_CODE_ATTEMPTS
  // the code is dead and the user must resend.
  verifyEmail: authed.auth.verifyEmail.handler(async ({ input, context }) => {
    const user = context.user;
    if (user.emailVerifiedAt !== null) return toUserOut(user);
    if (!user.emailVerifyCodeHash || !user.emailVerifyCodeExpiresAt
        || user.emailVerifyCodeExpiresAt.getTime() <= Date.now()) {
      throw new ORPCError("BAD_REQUEST", { message: "code_expired" });
    }
    if (user.emailVerifyAttempts >= MAX_CODE_ATTEMPTS) {
      throw new ORPCError("TOO_MANY_REQUESTS", { message: "code_attempts_exceeded" });
    }
    if (hashVerifyCode(input.code) !== user.emailVerifyCodeHash) {
      await context.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifyAttempts: { increment: 1 } },
      });
      throw new ORPCError("BAD_REQUEST", { message: "invalid_code" });
    }
    const updated = await context.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), ...VERIFY_CLEARED },
    });
    return toUserOut(updated);
  }),

  // Confirm email via the magic-link token. Anonymous so the link works in any
  // browser; on success it logs the caller in. The token is single-use (cleared
  // on verify), so a second click after verifying returns invalid_or_expired.
  verifyEmailByToken: base.auth.verifyEmailByToken.handler(async ({ input, context }) => {
    const tokenHash = hashVerifyToken(input.token);
    const user = await context.prisma.user.findUnique({
      where: { emailVerifyTokenHash: tokenHash },
    });
    if (!user || !user.emailVerifyLinkExpiresAt
        || user.emailVerifyLinkExpiresAt.getTime() <= Date.now()) {
      throw new ORPCError("BAD_REQUEST", { message: "invalid_or_expired_token" });
    }
    const updated = await context.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), ...VERIFY_CLEARED },
    });
    const sessionToken = await createOwnerSession(context.prisma, updated.id);
    setOwnerCookie(context.responseHeaders, sessionToken);
    return toUserOut(updated);
  }),

  // Re-send a fresh code + link. Authed. No-op when already verified or when no
  // transport is configured. Throttled (30s cooldown + per-email/per-IP cap).
  resendVerification: authed.auth.resendVerification.handler(async ({ context }) => {
    const user = context.user;
    if (user.emailVerifiedAt !== null || !emailConfigured()) return { ok: true as const };
    assertVerifyResendAllowed(user.email, clientIp(context.req));
    const code = generateVerifyCode();
    const token = generateVerifyToken();
    const now = Date.now();
    await context.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifyCodeHash: hashVerifyCode(code),
        emailVerifyCodeExpiresAt: new Date(now + codeTtlMs()),
        emailVerifyTokenHash: hashVerifyToken(token),
        emailVerifyLinkExpiresAt: new Date(now + linkTtlMs()),
        emailVerifyAttempts: 0,
      },
    });
    await sendVerificationEmail({
      to: user.email,
      verifyUrl: verifyUrl(token),
      code,
      codeTtlMinutes: codeTtlMinutes(),
    });
    return { ok: true as const };
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
