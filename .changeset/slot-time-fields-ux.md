---
"simple-unconference": patch
---

Slot form time-picker UX: the start and end pickers no longer constrain each other natively (which made it impossible to move a slot's start into the future without editing the end first). An invalid order now shows an inline "End time must be after start time." error and disables saving. The forms also show a live duration readout, warn when a slot exceeds 4 hours (a slot is one agenda block, not the whole day), and the new-slot form explains that days are built from several slots.
