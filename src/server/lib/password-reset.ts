// Forgot-password token helpers.
//
// The raw token is what goes in the email link; only its SHA-256 hash is ever
// persisted (`passwordResetTokenHash`), so reading the DB can't mint a valid
// reset. Tokens are single-use + short-lived (see `resetTokenTtlMs`).

import { randomBytes, createHash } from "node:crypto";
import { appBaseUrl } from "./app-url";

const DEFAULT_TTL_MIN = 30;

// Reset-link lifetime. Read per-call so operators can tune it without a code
// change; falls back to 30 minutes on unset / invalid input.
export function resetTokenTtlMs(): number {
  const raw = process.env.PASSWORD_RESET_TOKEN_TTL_MIN?.trim();
  const n = raw ? Number(raw) : NaN;
  const minutes = Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MIN;
  return minutes * 60_000;
}

export function resetTokenTtlMinutes(): number {
  return Math.round(resetTokenTtlMs() / 60_000);
}

// 64 hex chars of CSPRNG entropy. Same shape as the other opaque tokens in the
// codebase (invite / join-link / calendar feed), so the hex validators apply.
export function generateResetToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function ownerResetUrl(token: string): string {
  return `${appBaseUrl()}/auth/reset?token=${token}`;
}

export function identityResetUrl(slug: string, token: string): string {
  return `${appBaseUrl()}/c/${encodeURIComponent(slug)}/reset?token=${token}`;
}
