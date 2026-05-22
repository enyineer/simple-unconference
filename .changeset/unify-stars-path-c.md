---
"simple-unconference": minor
---

Unified the "star" concept. A single star on a Submission now drives BOTH the unconference algorithm AND planned-slot schedule visibility — no more confusion about why starring on the Sessions tab didn't put the talk on your schedule.

**For participants:** clicking "Star" anywhere (the Sessions tab card or the calendar's star toggle on a planned track) writes the same `Submission.Star` record. Every linked planned-slot `TrackAssignment` that references a session you starred now derives onto your `My schedule` and your iCal feed automatically. Submitters always see their own scheduled speaking gigs without needing to star themselves; mandatory tracks remain force-attended for everyone.

When the same Submission is scheduled across multiple offerings (sibling slots of a series, or independent placements), one star yields multiple schedule rows; the schedule view groups them with a *"Same session also at HH:MM"* caption so you know they're the same content. Time-overlapping starred rows surface a *"conflicts with X"* pill.

**For mods:** every planned track is now anchored to a Submission. Custom-title tracks are gone — to schedule an invited speaker, create a Submission for them first (the editor surfaces a required session picker; the optional `speakers` field is now for co-presenter / addendum text only).

The "finished" badge has been split + renamed by cause:

- **Fully scheduled** — the submission's placement cap is reached (algorithm exclusion only).
- **Marked complete** — the mod manually flipped `manually_finished`.

Both are informational only under the new model: participants still see and can star these submissions, and the star still derives any linked planned tracks onto their schedule. Only the unconference algorithm pool excludes them.

**Internals:** the `StaticStar` table is gone. `TrackAssignment.submissionId` is now `NOT NULL` and the `title` column is dropped (display title comes from the linked Submission). `MyAssignments` derivation joins TrackAssignments against the user's `Star`s + mandatory + submitter-self in a single query. The `agenda.starTrack` / `agenda.unstarTrack` endpoints have been removed from the contract.

A migration mirrors any existing `StaticStar` rows into Submission stars before dropping the table. Existing custom-title tracks need converting to a Submission first (the migration errors clearly if any remain).
