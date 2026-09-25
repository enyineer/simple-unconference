---
"simple-unconference": minor
---

Moderator-managed Live Board config in the Pitch Mode sheet.

Board-link management (enable / copy / rotate) moved from the owner-only Settings tab into the Pitch Mode sheet and is now open to moderators as well as owners. New board config options, all applied live on open walls:

- **Shown-days filter**: pick which days appear on the board wall (server-side payload filter; the spotlight is deliberately not day-bound).
- **Skip-empty pages**: room columns and slot rows with nothing placed are pruned day-scoped before chunking, so sparse days merge into fewer, denser pages (on by default).
- **Density caps**: pages cap at 6 room columns / 6 slot rows - overflow becomes more pages instead of smaller cells.
