---
"simple-unconference": patch
---

Shareable session deep links. Every published session card gets a "Copy link" action producing a `?highlight=<id>` URL; the conference page highlights the targeted session (accent card) and, since the sessions list is cursor-paginated, pins a copy above the list whenever the session isn't on the currently visible page — the link always surfaces its session regardless of pagination or active filters. The board's pitch-mode spotlight QR now encodes the same link for the currently spotlighted session and regenerates when the spotlight changes. Invisible sessions (drafts of others) stay unfetchable through the new pinpoint filter.
