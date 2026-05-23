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
}, CLEANUP_INTERVAL_MS).unref?.();

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

// Test-only escape hatch — flushes both stores. Called from setupTestApp().
export function __resetLimitsState(): void {
  loginFails.clear();
  writeAttempts.clear();
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
