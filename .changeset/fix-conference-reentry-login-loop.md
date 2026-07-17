---
"simple-unconference": patch
---

Fix a login loop when re-entering a conference. Visiting a conference deep link
while signed out cached an empty session for that slug; after signing in and
landing back on the same slug, the app read that stale empty result as
"not authenticated" and bounced straight back to the login page - cancelling the
fresh session fetch in the process, so only a full page reload could break out.
The cached result is now dropped the moment the active conference changes, so the
fresh fetch always decides.
