---
"simple-unconference": minor
---

Rooms can now be reserved for experts and given availability windows. A room that belongs to an expert room pool or an expert's room list is "dedicated": it's excluded from every slot assignment (unconference, mixer, planned scheduling, placement, and refit), and hand-scheduling into it returns a clear conflict. The two systems are mutually exclusive in both directions — a room already used by a slot can't be dedicated, and a dedicated room can't be pinned or scheduled to. Each room can also declare one or more availability windows; a room is only usable for a time interval that fits fully inside a single window, and this gates both assignments and expert bookings. **A room with no windows is always available** (the default), so existing conferences behave exactly as before. Editing a room's windows is blocked when it would strand an existing track, placement, or booking.
