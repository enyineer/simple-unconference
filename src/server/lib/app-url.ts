// Public base URL of this instance, used to build links in outgoing email
// (password reset, email verification). The SPA uses hash routing (see
// src/web/router.tsx), hence the `/#/...` segment in the callers.
//
// REQUIRED — there is deliberately no default. A wrong base URL silently
// produces broken/loopback links in every reset + verification email, which
// is the kind of misconfiguration that only surfaces after rollout. So we
// fail loudly instead: `appBaseUrl()` throws if APP_URL is unset, and the
// server validates it at boot (see startServer) so it can never be missed.

const APP_URL_HELP =
  "APP_URL is not set. Set it to this instance's public origin so email " +
  "links resolve (e.g. https://unconf.example.com in production, or " +
  "http://localhost:5173 in dev — the dev launcher sets this for you).";

export function appBaseUrl(): string {
  const raw = process.env.APP_URL?.trim();
  if (!raw) throw new Error(APP_URL_HELP);
  return raw.replace(/\/+$/, "");
}

// Boot-time guard: call early so a missing APP_URL fails fast at startup with a
// clear message, rather than lazily the first time someone requests an email.
export function assertAppUrlConfigured(): void {
  appBaseUrl();
}
