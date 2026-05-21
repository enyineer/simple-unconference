---
"simple-unconference": minor
---

Public-instance hardening: four layered defenses, all opt-in via env vars (Docker-friendly) and Helm chart values, every one disable-able individually with a `0` / empty value.

- **Cloudflare Turnstile** gating on `auth.signup`, `auth.login`, `conferences.claimInvite`, and `conferences.signupViaLink`. Set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to enable; leave either empty for a no-op. The site key is exposed through `config.get` so the SPA lazy-loads the widget only when enabled. `claimInvite` is gated too so an abusive moderator can't burn the participant cap by self-inviting + bot-redeeming fake emails they control.
- **Per-email failed-login lockout** on both global `auth.login` and per-conference `conferences.login`. NAT-blind (per-email, not per-IP) so venue Wi-Fi works fine. Defaults: 5 failures / 15-min window → 15-min lockout (`LOGIN_FAIL_LIMIT`, `LOGIN_FAIL_WINDOW_MIN`, `LOGIN_LOCKOUT_MIN`).
- **Per-account write rate** (sliding 1-hour window, default 600/user via `WRITES_PER_HOUR_PER_USER`) applied to expensive `create`/`update` operations. Stars and notification marks are exempt — legitimate bursts during agenda review are normal.
- **Per-account / per-conference quotas**: `MAX_CONFERENCES_PER_USER` (3), `MAX_SESSIONS_PER_USER_PER_CONFERENCE` (5), `MAX_PARTICIPANTS_PER_CONFERENCE` (2500), `MAX_PENDING_INVITES_PER_CONFERENCE` (2500), `MAX_ROOMS_PER_CONFERENCE` (100). Defaults sized for events up to ~2000 attendees; private deployments raise via env or set to `0` for unlimited.

Helm chart adds `limits:` and `turnstile:` blocks that emit the corresponding env vars. The Login + Join pages render the Turnstile widget when `config.get` reports a site key; the script loads lazily on first mount and is cached for subsequent ones. Error codes returned to the client: `quota_exceeded` (with `data: { resource, limit, current }`), `account_locked`, `rate_limited`, `captcha_required`, `captcha_failed`.

README adds a [Public-instance hardening](https://github.com/enyineer/simple-unconference#public-instance-hardening) section explaining the four-layer design and why per-IP rate limits would be wrong for the venue-WLAN traffic pattern. The free public instance at <https://unconference.enking.dev> runs with these defaults enabled.
