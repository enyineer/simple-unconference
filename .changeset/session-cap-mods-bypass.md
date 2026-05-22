---
"simple-unconference": minor
---

Mods and owners no longer count against the per-user session submission cap.

`MAX_SESSIONS_PER_USER_PER_CONFERENCE` (default 5) exists to prevent participant spam — but it also blocked organizers from seeding the agenda with keynotes, sponsor talks, and prepared workshops before opening submissions to the room. The cap is now skipped server-side for moderator/owner principals (including the mod-on-behalf-of-a-participant path: if a mod explicitly attributes a session to someone else, the attributee's cap doesn't apply either, since the mod has made the trust decision).

The Sessions tab no longer renders the "X / N submissions used" hint for mods/owners; participants still see their remaining quota and still get a `quota_exceeded` error past the cap.

Other instance-scale caps (`MAX_PARTICIPANTS_PER_CONFERENCE`, `MAX_PENDING_INVITES_PER_CONFERENCE`, `MAX_ROOMS_PER_CONFERENCE`, `MAX_CONFERENCES_PER_USER`, `WRITES_PER_HOUR_PER_USER`, login lockout) are unchanged — they guard resource bounds, not user behavior, and bypassing them for mods would defeat their actual purpose.
