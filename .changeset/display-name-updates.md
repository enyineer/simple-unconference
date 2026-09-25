---
"simple-unconference": minor
---

Display names can now be edited in place.

- New `auth.updateMe` procedure updates the global account's display name; an inline editor in the account menu (dashboard) saves it without leaving the page.
- The conference profile editor gained a "Display name" field, and the in-conference account menu can rename the conference identity directly (via `conferences.updateConfMe`), so participants and moderators no longer need workarounds to fix names.
- Moderators can set any member's display name through `profiles.updateAny`. Names are trimmed, capped at 80 characters, and an explicit empty value clears the name (same rule as signup).
