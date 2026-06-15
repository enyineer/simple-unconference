---
"simple-unconference": minor
---

Add a self-service forgot-password flow for both global owner accounts and
per-conference identities. Users request a reset link from the sign-in screen;
the link carries a single-use, short-lived token (default 30 min). Completing
the reset rotates the password, signs out all existing sessions, and logs the
user in.

Security: only the SHA-256 hash of the token is stored (never the raw token);
requests never reveal whether an address exists (no account enumeration);
requests are rate-limited per-email and per-IP and protected by Cloudflare
Turnstile when configured. Email is sent via Resend (`RESEND_API_KEY` /
`EMAIL_FROM`); when no transport is configured the link is logged so
self-hosted operators can still recover accounts. New env vars: `APP_URL`,
`RESEND_API_KEY`, `EMAIL_FROM`, `PASSWORD_RESET_TOKEN_TTL_MIN`,
`PASSWORD_RESET_PER_HOUR_PER_EMAIL`, `PASSWORD_RESET_PER_HOUR_PER_IP`.
