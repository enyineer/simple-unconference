---
"simple-unconference": patch
---

Speakers without a display name are no longer invisible.

- A registered speaker whose identity has no display name yet (and a session whose submitter has none) now resolves to the display label "Unnamed speaker" instead of an empty string.
- Previously every blank-name filter dropped the person, so the speaker silently vanished from session cards, the agenda, the calendar, the manual-placement warning, and the public board.
- Collision keys and host-duty seating are unchanged - they key on identity ids, not names.
