---
"simple-unconference": minor
---

Add whole-agenda attendee assignment with moderator-authored placements.

Moderators can now place a session into a specific slot + room
(`agenda.placeSubmission` / `unplaceSubmission`, surfaced as the placement
authoring controls on an unconference slot), including placing the same session
on multiple slots to build a recurring session. A new **Assign attendees**
action (`agenda.assignAll`) then routes participants across the entire agenda at
once instead of one slot at a time.

The global router (`assignAgenda`, a new pure module) is an integer min-cost
flow that, unlike the per-slot greedy assigner, sees the whole agenda: it
**splits a recurring session's starrers evenly across its occurrences** and
applies **cross-slot look-ahead** (a user starring two same-time sessions, one
of which also runs later, is sent to the non-recurring one now and caught up
with the other at its later showing). Hard rules still hold: at most one session
per overlapping time-band, room capacity, never the same session twice, and
manual picks + submitter hosting are respected. It writes only `UserAssignment`
rows — authored placements are preserved. The existing per-slot "Run assignment"
button is unchanged.
