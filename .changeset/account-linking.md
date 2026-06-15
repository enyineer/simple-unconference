---
"simple-unconference": minor
---

Add verified global accounts and opt-in cross-conference account linking.

When an email transport is configured, new owner signups must confirm their
email (6-digit code or magic link) before entering; a `requireVerified` gate
also protects conference creation and linking server-side. A verified email is
then the private join key for linking: from the dashboard, an owner can link
the per-conference identities that share their email (proving control with that
conference's password once), after which a single global login resolves into
every linked conference. Linking never exposes `linkedUserId` or verification
state to other users, and discovery only runs behind the authenticated,
verified session, so it can't be used to enumerate accounts.

Email transport is now pluggable via `EMAIL_TRANSPORT`: `resend` (REST),
`smtp` (lazy-loaded nodemailer), `memory` (enabled but outbox-only, for
dev/CI), or `none`. With no real transport configured, signups auto-verify and
the verification wall + linking UI are switched off, so self-hosted instances
are never locked out and the base product is unchanged. New env vars:
`EMAIL_TRANSPORT`, `SMTP_URL`/`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/
`SMTP_SECURE`, `EMAIL_VERIFY_CODE_TTL_MIN`, `EMAIL_VERIFY_LINK_TTL_MIN`,
`VERIFY_RESEND_PER_HOUR_PER_EMAIL`, `VERIFY_RESEND_PER_HOUR_PER_IP`. Adds a
Prisma migration (email-verification columns on User, `linkedUserId` on
ConferenceIdentity) with a backfill that grandfathers existing accounts.
