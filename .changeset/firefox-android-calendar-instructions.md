---
"simple-unconference": patch
---

Replace the broken "Open in calendar app" button on Firefox for Android with paste-by-URL instructions.

Firefox for Android deliberately blocks dispatch of non-allowlisted schemes (incl. `webcal://`) to external apps as a Mozilla security policy, so the existing button was a no-op there. Serving the plain `https://` URL would technically "do something" but only as a one-time `.ics` import, losing the auto-update subscription behavior the panel promises.

On Firefox Android, the green button is now replaced inline with a muted instruction asking the user to copy the URL above and paste it into their calendar app's "Add by URL" / "Add subscription" setting — preserving the real subscribe-with-updates flow. Every other browser keeps the `webcal://` one-click button unchanged.
