---
"simple-unconference": patch
---

Helm chart: fail the install when the Resend transport is configured (explicitly via `email.transport: resend`, or implicitly via a Resend API key with blank transport) but `email.from` is empty. Without a sender address the app falls back to `onboarding@resend.dev`, which Resend restricts to sandbox delivery (the account owner's own address only), so emails to real users silently fail with a 403.
