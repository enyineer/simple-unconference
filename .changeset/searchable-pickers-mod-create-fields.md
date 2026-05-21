---
"simple-unconference": minor
---

Submitter reassignment, mod fields at create, searchable pickers

- **Reassign submitter**: moderators can change a session's submitter (the conference identity the session is attributed to). Useful when a mod submits on someone else's behalf — the actual speaker shows up as the author instead of the mod. Available in the session edit sheet via the new "Submitter" picker.
- **Mod-only fields at submission time**: moderators can now set the submitter, pre-assigned room, max placements, "mark as finished" flag, and overlapping-placements toggle directly on the create form — same UI as edit, no more create-then-edit two-step.
- **Searchable pickers**: long dropdowns (rooms, conference members, sessions, expert pools, timezones) are now type-to-filter comboboxes with keyboard navigation. Short fixed-option selects (slot type, cap mode, design system, etc.) are unchanged.

Schema change (additive): `CreateSubmissionSchema` now accepts the same optional mod-only fields as `UpdateSubmissionSchema`; the server enforces role and silently drops them for participants.
