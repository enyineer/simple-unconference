// Auth-related valibot schemas: signup, login, color-mode preference.

import * as v from "valibot";
import { Email, Password, TurnstileToken } from "./primitives";

export const SignupSchema = v.object({
  email: Email,
  password: Password,
  name: v.optional(v.pipe(v.string(), v.trim())),
  turnstile_token: TurnstileToken,
});
export type SignupInput = v.InferOutput<typeof SignupSchema>;

export const ColorModeSchema = v.picklist(["auto", "light", "dark"] as const);
export type ColorMode = v.InferOutput<typeof ColorModeSchema>;

export const LoginSchema = v.object({
  email: Email,
  password: v.pipe(v.string(), v.minLength(1, "Password is required.")),
  turnstile_token: TurnstileToken,
});
export type LoginInput = v.InferOutput<typeof LoginSchema>;

// Conference-scoped login. Email is unique per-conference so the slug is
// already implicit in the route input — no global lookup happens.
export const ConfLoginSchema = v.object({
  email: Email,
  password: v.pipe(v.string(), v.minLength(1, "Password is required.")),
});
export type ConfLoginInput = v.InferOutput<typeof ConfLoginSchema>;

// ----- forgot password ------------------------------------------------------

// Request a reset link. Same shape for the global owner account and for a
// per-conference identity (the conference slug, when relevant, is added by the
// contract). Turnstile-protected like signup/login.
export const RequestPasswordResetSchema = v.object({
  email: Email,
  turnstile_token: TurnstileToken,
});
export type RequestPasswordResetInput = v.InferOutput<typeof RequestPasswordResetSchema>;

// Opaque reset token: 16-128 hex chars (same family as invite / calendar
// tokens). A malformed token can't possibly match a stored hash, so we reject
// it at the schema boundary with the same generic copy the handler uses.
const ResetToken = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^[0-9a-f]{16,128}$/i, "This reset link is invalid or has expired."),
);

// Complete the reset: token from the email link + the new password.
export const ResetPasswordSchema = v.object({
  token: ResetToken,
  password: Password,
  turnstile_token: TurnstileToken,
});
export type ResetPasswordInput = v.InferOutput<typeof ResetPasswordSchema>;

// ----- email verification ---------------------------------------------------

// 6-digit numeric code typed on the confirmation screen.
export const VerifyEmailSchema = v.object({
  code: v.pipe(v.string(), v.trim(), v.regex(/^\d{6}$/, "Enter the 6-digit code from the email.")),
});
export type VerifyEmailInput = v.InferOutput<typeof VerifyEmailSchema>;

// Magic-link token (same hex family as the reset token).
export const VerifyEmailTokenSchema = v.object({
  token: v.pipe(v.string(), v.trim(), v.regex(/^[0-9a-f]{16,128}$/i, "Invalid verification link.")),
});
export type VerifyEmailTokenInput = v.InferOutput<typeof VerifyEmailTokenSchema>;

// ----- account linking ------------------------------------------------------

// Link the conference identity matching the verified global email. Proves
// control of the conference side via its own password (the slug is added by
// the contract). Email match is implicit (lookup is by the user's email).
export const LinkConferenceSchema = v.object({
  password: v.pipe(v.string(), v.minLength(1, "Password is required.")),
});
export type LinkConferenceInput = v.InferOutput<typeof LinkConferenceSchema>;
