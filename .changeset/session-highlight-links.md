---
"simple-unconference": patch
---

Shareable session deep links. Every published session card gets a "Copy link" action producing a `?highlight=<id>` URL; the conference page always renders the highlighted session pinned at the top with an accent card and filters it out of the paginated list below, so the link surfaces its session exactly once regardless of which page or filters the viewer currently has — no duplicate render, and a "Clear highlight" action removes the pin. The board's pitch-mode spotlight QR now encodes the same link for the currently spotlighted session and regenerates when the spotlight changes. Invisible sessions (drafts of others) stay unfetchable through the new pinpoint filter.
