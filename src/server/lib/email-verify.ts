// Email-verification token + code helpers (account-linking Phase 3).
//
// Two parallel proofs of mailbox control, both stored only as SHA-256 hashes:
//   - a 64-hex magic-link token (high entropy, 30-min TTL), and
//   - a 6-digit code typed on the confirmation screen (low entropy, 15-min
//     TTL, capped at MAX_CODE_ATTEMPTS guesses before a forced resend).
//
// A verified email is the private join key for opt-in conference linking.

import { randomBytes, randomInt, createHash } from "node:crypto";
import { appBaseUrl } from "./app-url";

const DEFAULT_CODE_TTL_MIN = 15;
const DEFAULT_LINK_TTL_MIN = 30;

// Online-guessing cap on the 6-digit code. After this many wrong attempts the
// code is dead and the user must request a fresh one.
export const MAX_CODE_ATTEMPTS = 5;

function ttlMs(name: string, fallbackMin: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  const minutes = Number.isFinite(n) && n > 0 ? n : fallbackMin;
  return minutes * 60_000;
}

export function codeTtlMs(): number {
  return ttlMs("EMAIL_VERIFY_CODE_TTL_MIN", DEFAULT_CODE_TTL_MIN);
}
export function linkTtlMs(): number {
  return ttlMs("EMAIL_VERIFY_LINK_TTL_MIN", DEFAULT_LINK_TTL_MIN);
}
export function codeTtlMinutes(): number {
  return Math.round(codeTtlMs() / 60_000);
}

// 64 hex chars of CSPRNG entropy (same shape as the other opaque tokens).
export function generateVerifyToken(): string {
  return randomBytes(32).toString("hex");
}

// Zero-padded 6-digit code from a CSPRNG.
export function generateVerifyCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashVerifyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function hashVerifyCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function verifyUrl(token: string): string {
  return `${appBaseUrl()}/#/auth/verify?token=${token}`;
}
