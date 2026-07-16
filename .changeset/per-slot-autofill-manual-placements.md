---
"simple-unconference": patch
---

The per-slot "Auto-fill this slot from stars" run now seats attendees into sessions a moderator placed by hand, instead of being destructive on such slots. Running assignment on a hand-authored slot keeps the manual placements intact (rooms reserved, sessions never re-placed) and routes starrers into them; mixed slots that combine hand-placed and auto-placed sessions now run without unique-constraint errors.
