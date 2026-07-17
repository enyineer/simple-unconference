---
"simple-unconference": patch
---

Made push notifications proactive and correctly per-conference.

- **Proactive opt-in**: a dismissible "Turn on notifications" card now appears in a conference (once per conference/device) so the opt-in isn't buried in the notification bell. It defers to the install nudge so the two never stack, and only shows when push can actually be enabled.
- **Per-conference accuracy (bug fix)**: enabling push in one conference used to make every other conference *look* enabled (the client read the browser's origin-level subscription), while the server only registered the one you clicked. Now each conference reflects its own server-side registration via a new `push.status` check. Enabling registers only the current conference (reusing the shared browser subscription without re-prompting), and turning it off removes only that conference's registration instead of killing the shared browser channel — so muting one conference no longer breaks the others.
