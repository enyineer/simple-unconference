---
"simple-unconference": patch
---

`My schedule` no longer flags adjacent sessions as "conflicts with X" when their labels read as touching.

Same root cause as the calendar-overlap fix in the previous release: the conflict detector compared raw millisecond timestamps while the displayed times round to `HH:MM`. A session ending at `18:07:30` (labeled "18:07") next to one starting at `18:07:00` got tagged as a 30-second overlap even though the labels read as adjacent.

Generalized the fix instead of patching each comparison site: every user-set instant (agenda slot starts/ends, expert timeframes, expert bookings) is now clipped to the whole minute that contains it — via a shared `clipToMinute` helper applied at the write boundary (`createSlot` / `updateSlot` / `duplicateSlot` / `createTimeframe` / `book`). Client-side comparators (MyAssignments conflict detector, Calendar overlap layout) use the same helper so display always matches storage.

Includes a one-time SQL migration that floors existing `agenda_slots`, `expert_timeframes`, and `expert_bookings` timestamps to whole minutes — fixes the rendering immediately for environments that already have sub-minute legacy data without needing app-level backfill.
