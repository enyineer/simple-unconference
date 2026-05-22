---
"simple-unconference": minor
---

Path C follow-ups: parallel-star correctness, auto-room scheduling for planned tracks, and soft capacity warnings.

**Algorithm correctness (Path C gap fix).** A participant who starred a session that's scheduled as a planned track in an *overlapping* slot now correctly counts as busy in the unconference algorithm — they're locked into the planned track and will no longer be auto-placed into a parallel unconference session. Previously the busy-user set only considered explicit `UserAssignment` rows, so derived planned-track attendance was invisible to the algo. The same fix applies to `avoidRepeats` cross-slot history: a starred planned-track session counts as already attended for rotation purposes. Submitters and mandatory tracks follow the same rule — if the planned track is mandatory in an overlapping slot, every participant is busy; if you submitted the session, you're busy regardless of stars. No algorithm change in `assignment.ts` — only the route-layer data feed.

**Auto-room scheduling for planned tracks.** New moderator action *Add session → Auto-assign room*. Mods pick a Submission; the server picks the room using a deterministic priority: `Submission.preAssignedRoomId` (hard pin) → `Submission.roomRequirements` (tag constraints) → largest free room in the slot's effective scope. Conflicts come back as a structured payload — `pin_room_taken`, `pin_room_out_of_scope`, `unsatisfiable_requirements`, or `no_free_room` — surfaced as readable toasts that tell the mod what to clear, repin, or reconfigure. The existing per-room "pin to this room" buttons remain as a secondary affordance. Implemented as a new RPC `agenda.scheduleSubmission`; no schema change. The unconference matcher is untouched.

**Soft capacity warnings.** When the number of stars on a session exceeds the room's capacity, both moderators and participants now see a clear advisory badge:

- **Moderator side:** the planned-track editor and the unconference-placement detail both show `⚠ Room may be full (stars/capacity)`. Hovering reveals how many starrers are likely unplaced.
- **Participant side:** the `My schedule` row for a planned track shows `room may be crowded (stars/capacity)`, signalling that arriving early or watching for an upgrade is worthwhile.

Capacity is advisory only — the algorithm still places popular sessions in whatever room is largest, and stars are never refused. To clarify a question that came up: a much-starred session is **always placed**. The unconference top-N is purely star-driven; capacity only clips per-user assignments, not the placement itself. So a 100-star, 50-cap session runs as expected; 50 attendees are placed; the remaining starrers either land in another starred session or appear as unplaced (with the option to switch).

**Internals.** `AssignmentOut` gains `expected_attendance` and `room_capacity` (static rows only). `PlacementOut` gains `star_count` and `room_capacity`. `AssignmentRulesModal` has a new *Planned tracks & soft capacity* section explaining the unified star model, the cross-slot busy rule, and the advisory nature of the warning. Regression tests cover all four new busy-user paths (star, submitter, mandatory, avoid-repeats derivation) and every conflict reason of `scheduleSubmission`.
