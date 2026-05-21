// Cloudflare Turnstile token verification.
//
// When TURNSTILE_SECRET_KEY is unset, this module is a no-op — every call to
// `assertTurnstile()` immediately returns. That keeps it free for private
// deployments and self-hosted instances who don't want the Cloudflare round-
// trip on every signup/login.
//
// When set, the public site key (TURNSTILE_SITE_KEY) is what the frontend
// renders the widget with, and the secret key is what we use server-side to
// validate the token the widget produces against:
//   https://challenges.cloudflare.com/turnstile/v0/siteverify
//
// Error codes thrown:
//   - captcha_required: no token in the request body (only thrown when
//                       Turnstile is configured)
//   - captcha_failed:   Cloudflare rejected the token (expired, replayed,
//                       wrong sitekey, or actually a bot)

import { ORPCError } from "@orpc/server";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Read env on each access. The cost is a hash lookup and lets tests flip
// these without restarting the process. Returns `null` when unset / blank
// so callers can use a single `!== null` check.
function readSecretKey(): string | null {
  return process.env.TURNSTILE_SECRET_KEY?.trim() || null;
}
function readSiteKey(): string | null {
  return process.env.TURNSTILE_SITE_KEY?.trim() || null;
}

// Exposed to the frontend via the existing `config.get` RPC. Returns null
// when Turnstile is disabled so the client knows not to render the widget.
export function turnstileSiteKey(): string | null {
  return readSiteKey();
}

export function turnstileEnabled(): boolean {
  return readSecretKey() !== null;
}

// Validates a token captured by the frontend widget. Resolves the response
// body shape Cloudflare actually returns so we can distinguish "missing"
// (captcha_required) from "invalid" (captcha_failed).
//
// `remoteIp` is optional; passing it lets Cloudflare correlate against
// reputation signals but isn't required.
export async function assertTurnstile(
  token: string | null | undefined,
  remoteIp?: string,
): Promise<void> {
  const secret = readSecretKey();
  if (secret === null) return;

  if (!token || typeof token !== "string" || token.trim() === "") {
    throw new ORPCError("FORBIDDEN", { message: "captcha_required" });
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  interface SiteverifyResponse { success: boolean; "error-codes"?: string[] }
  let result: SiteverifyResponse | null = null;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.ok) result = (await res.json()) as SiteverifyResponse;
  } catch {
    // Network failure to Cloudflare — fail closed. If Cloudflare is down or
    // unreachable from the cluster, signups/logins will fail until it's
    // reachable again. That's the safer default for a public instance.
  }

  if (!result || !result.success) {
    throw new ORPCError("FORBIDDEN", {
      message: "captcha_failed",
      data: { error_codes: result?.["error-codes"] ?? ["network_error"] },
    });
  }
}
