---
"simple-unconference": patch
---

Fixed password-reset and magic-link verification pages rejecting valid tokens.

After the move to real path URLs, the pages still scanned the bare pathname for the `?token=` query parameter and never found it, so owner password reset, magic-link verification, and conference reset links all failed client-side with a generic "invalid or expired" message before reaching the server.
