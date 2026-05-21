---
"simple-unconference": minor
---

Add `DISABLE_SIGNUP` env var to lock down global owner signup. When set to `1`/`true`/`yes`, the signup form is hidden on the login page and `POST /api/auth/signup` returns `403 signup_disabled`. Existing accounts can still sign in. Per-conference participant signup is unaffected. Exposed in the Helm chart as `auth.disableSignup`.
