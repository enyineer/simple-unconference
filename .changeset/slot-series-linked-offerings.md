---
"simple-unconference": minor
---

Mods can now duplicate any agenda slot as a linked offering. Use cases: the same workshop running in a 10am and a 2pm block, a keynote repeated for capacity, an open discussion offered three times a day.

A duplicated slot joins (or creates) a `SlotSeries`. The series owns the shared config — room pool, eligible submissions, repeat-avoidance flags, type — and is edited once via the series form; per-instance fields (time, title, description) remain on each offering. Each slot in the calendar shows an "Offering N of M" badge with prev/next arrows for jumping between siblings without closing the sheet.

For planned slots, the source's `TrackAssignment` rows are copied onto the new offering so the duplicate carries the same content (subject to the explicit per-offering placement-cap warning shown when duplicating). When a `setSeries` edit would orphan existing tracks/placements (e.g. removing a room that's already used), the server short-circuits with a confirmation request listing exactly what would be removed; the mod re-submits with `confirm: true` to cascade-delete and apply.

For unconference + mixer slots, the assignment algorithm picks up a new `avoidRepeatsAcrossSiblings` series-level flag (default on): a participant placed in a session in one sibling won't be re-placed in the same session in another sibling. Turn it off for series where attending twice is the point.

Mods can detach a single offering back to standalone (snapshots the series's current config onto the slot), or dissolve the series entirely with "Disband series" (keep slots) / "Delete with offerings" (drop everything). A series that ends up with one remaining member auto-detaches — no pointless "Offering 1 of 1."

Also fixed: duplicating a planned slot used to leave the duplicate empty because `TrackAssignment` rows weren't copied.
