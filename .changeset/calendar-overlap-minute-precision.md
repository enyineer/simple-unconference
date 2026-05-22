---
"simple-unconference": patch
---

Calendar no longer renders adjacent slots as side-by-side columns when their displayed times read as touching.

The overlap-clustering algorithm used to compare slot times at millisecond precision while the labels round to `HH:MM`. A slot ending at `18:07:30` (labeled "18:07") next to one starting at `18:07:15` (also "18:07") got rendered side-by-side because they technically overlapped by 15 seconds, even though the labels read as adjacent. Layout now normalizes both edges to whole minutes before deciding overlap, so the rendering matches what the labels show: same-minute touches are no longer treated as overlap.
