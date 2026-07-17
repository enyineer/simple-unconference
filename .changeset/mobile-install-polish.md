---
"simple-unconference": patch
---

Polished the conference UI on narrow (mobile) screens:

- The agenda header actions ("How it works", "Event report", "Pitch mode", "Add slot") now wrap below the title instead of clipping off the right edge.
- Long attention pills ("conflicts with ...", "room may be crowded ...") wrap onto multiple lines rather than overflowing their card.
- The breadcrumb's root crumb is a compact home icon (label kept for screen readers and as a tooltip) so it no longer wraps to two lines.
- The "install this conference as an app" nudge is tighter: a smaller title, a single right-aligned action bar (Dismiss + Install), and install-walkthrough copy sized to match its steps.

Also made the install copy clearer that an installed app can send notifications even when it isn't open - and, on iPhone/iPad, that adding it to the Home Screen is what enables notifications at all (an open Safari tab can't receive them).
