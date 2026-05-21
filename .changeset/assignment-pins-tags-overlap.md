---
"simple-unconference": minor
---

Assignment engine: pre-assignment + tag matching + overlap rules

- **Pre-assignment (pin to room)**: moderators can pin a session to a specific room from the Sessions tab. The pin always wins over star-based room ranking and required features.
- **Required room features**: sessions can request tag-based features (projector, whiteboard, etc). The picker only offers tags that actually exist on at least one room. The algorithm restricts candidate rooms to those whose tag set is a superset of the requested features.
- **Bipartite matching with post-processing**: tag-constrained sessions are matched to rooms via Kuhn's algorithm, then a swap pass canonicalizes "popular gets bigger room" among feasible matchings.
- **Up-front cascade conflict analysis**: when a session can't be matched, the algorithm tries the next-most-starred candidate and surfaces every session that would conflict in one comprehensive resolve panel — no more iterative resolve / re-run rounds.
- **Overlap rules**: assignment now automatically excludes (a) rooms used by overlapping slots, (b) submitters speaking in overlapping slots, (c) sessions placed in overlapping slots (configurable per session via `allow_overlapping_placements`), and (d) participants assigned to overlapping sessions. Exclusions are reported informationally in the run banner.
- **Resolve panel redesign**: radio-list per session with clear option descriptions, smarter defaults (skip is preselected for tag conflicts), and an Apply button that's disabled until every conflict group has a non-default action.
- **"How assignment works" modal**: in-app explanation (with mod-only sections) accessible from the slot detail and Agenda header. Documents every rule the engine applies.
- **UI polish**: condensed slot action row (help trigger on the meta line, Delete pushed to the right), critical banner severity for blocked runs, disabled Run button when there are no rooms or no eligible sessions, generous sheet bottom padding across both design-system plugins, and grab-to-scroll for horizontally-overflowing calendar rows.
- **Synthetic seed**: new "Unconference round 3 (conflict demo)" slot with sessions designed to surface both `duplicate_room` and `unsatisfiable_requirements` conflicts, plus a `Recurring Workshop` example with overlapping placements allowed.

Schema migrations (additive): `Submission.preAssignedRoomId`, `Submission.allowOverlappingPlacements`, new `SubmissionRoomRequirement` table.
