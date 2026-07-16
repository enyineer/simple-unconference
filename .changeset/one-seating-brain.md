---
"simple-unconference": minor
---

One seating model: placing sessions and seating attendees are now separate actions. Authoring an unconference slot (the per-slot "Run assignment") only decides which session runs in which room — it never seats attendees anymore. Seating is a single global "Update seating" action that, by default, only re-seats the future slots whose placements actually changed; every other slot (past, started, or unchanged) stays frozen as a hard constraint, so moderators can tweak one slot without reshuffling the rest. Past and started slots are never re-seated, and manual attendee picks are always preserved. A tick-box re-seats unchanged future slots too when a full refresh is wanted. Seating runs now notify only the people whose seat actually changed, instead of everyone.
