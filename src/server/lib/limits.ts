// Public-instance abuse defenses. Three layers, all configurable via env vars
// (Docker-friendly) and wired through the Helm chart's `limits:` block:
//
//   1. Per-account quotas — hard caps on rows owned by a single user/conference.
//   2. Per-email login lockout — credential-stuffing protection.
//   3. Per-account write rate — sliding window on expensive mutations.
//
// All limits accept `0` to mean "unlimited" so private deployments can opt out
// of any single defense individually. Stores are in-memory (single-pod
// architecture); on restart, counters reset — acceptable for anti-abuse since
// the worst case is the attacker gets a fresh budget after we restart.

import { ORPCError } from "@orpc/server";

// Read once at module load. Re-reading on each request would let env changes
// take effect without restart, but Bun process lifecycle is the same as the
// pod lifecycle in our chart, so this is wasted work.
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[limits] ${name}="${raw}" is not a non-negative number; using default ${fallback}`);
    return fallback;
  }
  return n;
}

export interface Limits {
  // Quotas (0 = unlimited)
  maxConferencesPerUser: number;
  maxSessionsPerUserPerConference: number;
  maxParticipantsPerConference: number;
  maxPendingInvitesPerConference: number;
  maxRoomsPerConference: number;

  // Per-email login lockout
  loginFailLimit: number;        // 0 disables lockout entirely
  loginFailWindowMs: number;
  loginLockoutMs: number;

  // Per-account write rate (0 disables)
  writesPerHourPerUser: number;

  // Forgot-password request throttle (0 disables each axis)
  passwordResetPerHourPerEmail: number;
  passwordResetPerHourPerIp: number;

  // Email-verification resend throttle (0 disables each axis)
  verifyResendPerHourPerEmail: number;
  verifyResendPerHourPerIp: number;

  // Chat-specific (per-identity, 0 disables)
  chatNewConversationsPerHour: number;
  chatMessagesPerMinute: number;
  chatMessageMaxBytes: number;
}

// Defaults are public-instance friendly and assume events up to ~2000
// attendees with ~5 sessions per user. Private deployments can override
// any value via env or leave them alone — they're not destructive.
export const LIMITS: Limits = Object.freeze({
  maxConferencesPerUser: num("MAX_CONFERENCES_PER_USER", 3),
  maxSessionsPerUserPerConference: num("MAX_SESSIONS_PER_USER_PER_CONFERENCE", 5),
  maxParticipantsPerConference: num("MAX_PARTICIPANTS_PER_CONFERENCE", 2500),
  maxPendingInvitesPerConference: num("MAX_PENDING_INVITES_PER_CONFERENCE", 2500),
  maxRoomsPerConference: num("MAX_ROOMS_PER_CONFERENCE", 100),

  loginFailLimit: num("LOGIN_FAIL_LIMIT", 5),
  loginFailWindowMs: num("LOGIN_FAIL_WINDOW_MIN", 15) * 60_000,
  loginLockoutMs: num("LOGIN_LOCKOUT_MIN", 15) * 60_000,

  writesPerHourPerUser: num("WRITES_PER_HOUR_PER_USER", 600),

  passwordResetPerHourPerEmail: num("PASSWORD_RESET_PER_HOUR_PER_EMAIL", 3),
  // Default OFF: participants (per-conference accounts) reset passwords too, and
  // at a venue they share one NAT'd public IP, so a per-IP cap here would lock
  // out a crowd the way the per-email cap never does. Per-email + Turnstile are
  // the real spray defenses; operators who know they're not behind shared NAT
  // can set this to re-enable the coarse backstop. Mirrors the NAT-blind login
  // lockout design.
  passwordResetPerHourPerIp: num("PASSWORD_RESET_PER_HOUR_PER_IP", 0),

  // Verification resend: looser per-email than reset (a fumbling new user may
  // retry a few times) but still capped, plus a 30s cooldown enforced in code.
  verifyResendPerHourPerEmail: num("VERIFY_RESEND_PER_HOUR_PER_EMAIL", 5),
  verifyResendPerHourPerIp: num("VERIFY_RESEND_PER_HOUR_PER_IP", 20),

  chatNewConversationsPerHour: num("CHAT_NEW_CONVERSATIONS_PER_HOUR", 10),
  chatMessagesPerMinute: num("CHAT_MESSAGES_PER_MINUTE", 30),
  chatMessageMaxBytes: num("CHAT_MESSAGE_MAX_BYTES", 4096),
});

// Throw `quota_exceeded` if `current` is at/over `limit`. limit=0 means
// unlimited (skip). The error data carries the resource label so the UI
// can render a specific message ("you've created the maximum 3 conferences").
export function assertQuota(
  resource: string,
  limit: number,
  current: number,
): void {
  if (limit === 0) return;
  if (current >= limit) {
    throw new ORPCError("FORBIDDEN", {
      message: "quota_exceeded",
      data: { resource, limit, current },
    });
  }
}

// ----- per-email login lockout ----------------------------------------------

interface LoginFailState {
  fails: number;
  firstFailAt: number;
  lockedUntil: number | null;
}
const loginFails = new Map<string, LoginFailState>();

// Periodic cleanup so the map can't grow unboundedly from one-off failed
// attempts. Runs in-process; cheap.
const CLEANUP_INTERVAL_MS = 5 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [email, state] of loginFails) {
    if (state.lockedUntil !== null && state.lockedUntil > now) continue;
    if (now - state.firstFailAt < LIMITS.loginFailWindowMs) continue;
    loginFails.delete(email);
  }
  for (const [userId, ts] of writeAttempts) {
    const cutoff = now - 60 * 60_000;
    const recent = ts.filter((t) => t >= cutoff);
    if (recent.length === 0) writeAttempts.delete(userId);
    else if (recent.length < ts.length) writeAttempts.set(userId, recent);
  }
  for (const store of [pwResetByKey, pwResetByIp, verifyResendByEmail, verifyResendByIp]) {
    const cutoff = now - 60 * 60_000;
    for (const [key, ts] of store) {
      const recent = ts.filter((t) => t >= cutoff);
      if (recent.length === 0) store.delete(key);
      else if (recent.length < ts.length) store.set(key, recent);
    }
  }
  for (const [email, ts] of verifyLastSendByEmail) {
    if (now - ts > 60 * 60_000) verifyLastSendByEmail.delete(email);
  }
}, CLEANUP_INTERVAL_MS).unref?.();

// Non-throwing lock probe. True when `email` is currently locked out. For
// callers that must consult the SAME login budget as `assertLoginAllowed` but
// must NOT surface `account_locked` (e.g. the organizer-password probe in
// conferences.login, where throwing would leak that a global account exists).
export function isLoginLocked(email: string): boolean {
  if (LIMITS.loginFailLimit === 0) return false;
  const s = loginFails.get(email);
  return s !== undefined && s.lockedUntil !== null && s.lockedUntil > Date.now();
}

// Check before validating the password. Throws when the email is locked.
export function assertLoginAllowed(email: string): void {
  if (LIMITS.loginFailLimit === 0) return;
  const s = loginFails.get(email);
  if (!s) return;
  const now = Date.now();
  if (s.lockedUntil !== null && s.lockedUntil > now) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "account_locked",
      data: { unlock_at: s.lockedUntil },
    });
  }
}

// Call after a failed password check. Returns the new fails count so the
// caller can include it in the response if desired.
export function recordLoginFailure(email: string): number {
  if (LIMITS.loginFailLimit === 0) return 0;
  const now = Date.now();
  const existing = loginFails.get(email);
  if (!existing || now - existing.firstFailAt > LIMITS.loginFailWindowMs) {
    loginFails.set(email, { fails: 1, firstFailAt: now, lockedUntil: null });
    return 1;
  }
  existing.fails += 1;
  if (existing.fails >= LIMITS.loginFailLimit) {
    existing.lockedUntil = now + LIMITS.loginLockoutMs;
  }
  return existing.fails;
}

// Call on successful login to clear the counter.
export function recordLoginSuccess(email: string): void {
  loginFails.delete(email);
}

// ----- forgot-password request throttle (sliding 1-hour windows) -----------
//
// Two independent axes so neither a single mailbox nor a single host can be
// used to spam reset emails: per-email (or per `conf:<slug>:<email>` key) and
// per-IP. Checked together and recorded only when BOTH pass, so a rejected
// request doesn't burn the budget it was rejected against. Keyed on the
// *submitted* address, never on whether the account exists — so the throttle
// can't be used to probe for valid emails.

const RESET_WINDOW_MS = 60 * 60_000;
const pwResetByKey = new Map<string, number[]>();
const pwResetByIp = new Map<string, number[]>();

function recentResets(
  store: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number = RESET_WINDOW_MS,
): number[] {
  return (store.get(key) ?? []).filter((t) => t >= now - windowMs);
}

export function assertPasswordResetAllowed(key: string, ip: string | null): void {
  const now = Date.now();
  const perEmail = LIMITS.passwordResetPerHourPerEmail;
  const perIp = LIMITS.passwordResetPerHourPerIp;

  const keyRecent = perEmail === 0 ? null : recentResets(pwResetByKey, key, now);
  const ipRecent = ip && perIp !== 0 ? recentResets(pwResetByIp, ip, now) : null;

  if (keyRecent && keyRecent.length >= perEmail) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "rate_limited",
      data: { resource: "password_reset", retry_at: keyRecent[0]! + RESET_WINDOW_MS },
    });
  }
  if (ipRecent && ipRecent.length >= perIp) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "rate_limited",
      data: { resource: "password_reset_ip", retry_at: ipRecent[0]! + RESET_WINDOW_MS },
    });
  }

  if (keyRecent) {
    keyRecent.push(now);
    pwResetByKey.set(key, keyRecent);
  }
  if (ipRecent && ip) {
    ipRecent.push(now);
    pwResetByIp.set(ip, ipRecent);
  }
}

// ----- email-verification resend throttle ----------------------------------
//
// Looser per-email cap than reset (fumbling new users retry), plus a hard 30s
// cooldown so the Resend button can't flood a mailbox, and a per-IP backstop.
// Keyed on the submitted email, so it never reveals account existence.

const VERIFY_WINDOW_MS = 60 * 60_000;
const VERIFY_COOLDOWN_MS = 30_000;
const verifyResendByEmail = new Map<string, number[]>();
const verifyResendByIp = new Map<string, number[]>();
const verifyLastSendByEmail = new Map<string, number>();

export function assertVerifyResendAllowed(email: string, ip: string | null): void {
  const now = Date.now();

  const last = verifyLastSendByEmail.get(email);
  if (last !== undefined && now - last < VERIFY_COOLDOWN_MS) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "rate_limited",
      data: { resource: "email_verify_cooldown", retry_at: last + VERIFY_COOLDOWN_MS },
    });
  }

  const perEmail = LIMITS.verifyResendPerHourPerEmail;
  const perIp = LIMITS.verifyResendPerHourPerIp;
  const emailRecent = perEmail === 0 ? null : recentResets(verifyResendByEmail, email, now, VERIFY_WINDOW_MS);
  const ipRecent = ip && perIp !== 0 ? recentResets(verifyResendByIp, ip, now, VERIFY_WINDOW_MS) : null;

  if (emailRecent && emailRecent.length >= perEmail) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "rate_limited",
      data: { resource: "email_verify", retry_at: emailRecent[0]! + VERIFY_WINDOW_MS },
    });
  }
  if (ipRecent && ipRecent.length >= perIp) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "rate_limited",
      data: { resource: "email_verify_ip", retry_at: ipRecent[0]! + VERIFY_WINDOW_MS },
    });
  }

  if (emailRecent) {
    emailRecent.push(now);
    verifyResendByEmail.set(email, emailRecent);
  }
  if (ipRecent && ip) {
    ipRecent.push(now);
    verifyResendByIp.set(ip, ipRecent);
  }
  verifyLastSendByEmail.set(email, now);
}

// Test-only escape hatch — flushes every store. Called from setupTestApp().
export function __resetLimitsState(): void {
  loginFails.clear();
  writeAttempts.clear();
  pwResetByKey.clear();
  pwResetByIp.clear();
  verifyResendByEmail.clear();
  verifyResendByIp.clear();
  verifyLastSendByEmail.clear();
  chatNewConvAttempts.clear();
  chatMessageAttempts.clear();
}

// ----- per-account write rate (sliding 1-hour window) ----------------------

const writeAttempts = new Map<number, number[]>();

// Throws `rate_limited` when the user has exceeded their hourly write budget.
// Called from create/update handlers; skipped for cheap idempotent ops (stars,
// notification marks) where bursts are legitimate.
export function recordWrite(userId: number): void {
  if (LIMITS.writesPerHourPerUser === 0) return;
  const now = Date.now();
  const cutoff = now - 60 * 60_000;
  const existing = writeAttempts.get(userId) ?? [];
  const recent = existing.filter((t) => t >= cutoff);
  if (recent.length >= LIMITS.writesPerHourPerUser) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "rate_limited",
      data: {
        resource: "writes",
        limit: LIMITS.writesPerHourPerUser,
        window_ms: 60 * 60_000,
        retry_at: recent[0]! + 60 * 60_000,
      },
    });
  }
  recent.push(now);
  writeAttempts.set(userId, recent);
}

// ----- chat-specific rate limits ------------------------------------------

// Sliding window of new-conversation initiations per identity. Separate from
// writesPerHourPerUser because chat is opt-out per identity (different
// principal kind) and the window is finer-grained (per-minute for messages).
const chatNewConvAttempts = new Map<number, number[]>();
const chatMessageAttempts = new Map<number, number[]>();

export function assertChatNewConversationAllowed(identityId: number): void {
  if (LIMITS.chatNewConversationsPerHour === 0) return;
  const now = Date.now();
  const cutoff = now - 60 * 60_000;
  const recent = (chatNewConvAttempts.get(identityId) ?? []).filter((t) => t >= cutoff);
  if (recent.length >= LIMITS.chatNewConversationsPerHour) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "rate_limited",
      data: {
        resource: "chat_new_conversations",
        limit: LIMITS.chatNewConversationsPerHour,
        window_ms: 60 * 60_000,
        retry_at: recent[0]! + 60 * 60_000,
      },
    });
  }
  recent.push(now);
  chatNewConvAttempts.set(identityId, recent);
}

export function assertChatMessageAllowed(identityId: number): void {
  if (LIMITS.chatMessagesPerMinute === 0) return;
  const now = Date.now();
  const cutoff = now - 60_000;
  const recent = (chatMessageAttempts.get(identityId) ?? []).filter((t) => t >= cutoff);
  if (recent.length >= LIMITS.chatMessagesPerMinute) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "rate_limited",
      data: {
        resource: "chat_messages",
        limit: LIMITS.chatMessagesPerMinute,
        window_ms: 60_000,
        retry_at: recent[0]! + 60_000,
      },
    });
  }
  recent.push(now);
  chatMessageAttempts.set(identityId, recent);
}
