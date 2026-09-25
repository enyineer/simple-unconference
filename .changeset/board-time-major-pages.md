---
"simple-unconference": patch
---

Live Board pages now follow time first, rooms second.

- Page order is day-major, then time-window major: every room page of the earliest time window shows before the next window opens, so the wall never jumps back to earlier sessions mid-rotation.
- Each time window's pages show only the rooms that actually host one of the window's sessions, ordered by first use - the room with the earliest session leads page 1 regardless of its room id. Empty room columns and empty slot rows never render.
- Removed the "x of y rooms" badge from the board header; it only shows day and time window now.
