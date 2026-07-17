---
"simple-unconference": minor
---

Added Web Push notifications: opt-in OS-level push that reaches participants even when the app is closed, augmenting (never replacing) the in-app bell + toast. Enable it per browser from the notification bell. Best-effort by design - a push failure never affects the in-app notification - and fully inert when the instance hasn't configured VAPID keys. Payloads stay privacy-safe (names and titles only, never emails). Configure with `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and optional `VAPID_SUBJECT`; generate a keypair with `bun run scripts/gen-vapid.ts`.
