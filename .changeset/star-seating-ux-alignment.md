---
"simple-unconference": patch
---

Aligned the star/seating UX with what the assignment algorithm actually does.

- The demand badge on recurring talks now compares total stars vs total seats across all occurrences instead of false-alarming against a single room.
- Seated-count chip is always visible; star toasts clarify interest vs seat.
- The rules modal now matches the implementation (star rule, global solver description, filled-up case in the unplaced rule, and more).
- Moderator nudges after a run point at concrete next steps; the placement toast points at "Update seating".
- SessionCard: title-first hierarchy, moderator-only status/room badges, clamped descriptions with a show-more toggle, star count merged into the Star button, scheduled offerings as accent chips.
