// Test hermeticity preload (configured via bunfig.toml `[test] preload`).
//
// Bun auto-loads `.env`, so a developer's local email config (RESEND_API_KEY,
// EMAIL_TRANSPORT, SMTP_*) would otherwise bleed into the suite, flip
// `emailConfigured()` on, and break the no-email assumption most tests make
// (signup would create *unverified* users -> conference creation gated ->
// widespread failures). Clear it all here, once, before any test file's
// beforeAll runs. Files that exercise email opt in explicitly by setting
// `process.env.EMAIL_TRANSPORT = "memory"` in their own beforeAll.

for (const key of [
  "EMAIL_TRANSPORT",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "SMTP_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_SECURE",
]) {
  delete process.env[key];
}

// APP_URL is required by the server (no default) for building email links;
// give the suite a stable origin. The host is irrelevant to assertions.
process.env.APP_URL = "http://localhost:3000";
