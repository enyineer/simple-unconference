---
"simple-unconference": minor
---

Host-duty seating: registered speakers are seated into every occurrence of their sessions.

- Host resolution now covers the full speaker list (multi-host sessions seat every registered speaker), in both the global "Update seating" solver and the per-slot placement pass.
- Host seats are duty seats: they never consume room capacity, are never blocked by a full room, and ignore the attend-each-session-once rule (hosting is work, not attendance). A host still leads at most one session per time-band - parallel twin occurrences go to the most-starred one, and a host already committed in a band (fixed pick, another pin) leaves that occurrence unhosted.
- Sessions whose speaker list contains only typed (unregistered) names are explicitly unhosted: the real presenters self-manage. Register speakers on a session so seating can assign them; an empty speaker list keeps the submitter-as-host default.
- Speaker or submitter edits on placed sessions - and member removal cascading speaker rows away - now flag the affected slots seating-stale, so the next "Update seating" picks the change up (previously these host-set changes propagated invisibly).
- The assignment rules modal documents the new hosting rule.
