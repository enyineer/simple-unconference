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
