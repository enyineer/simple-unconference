---
"simple-unconference": minor
---

Profile email management and identity polish.

- Members can edit their conference email from the profile editor, and moderators can fix anyone's email (e.g. a signup typo). The email is the per-conference login identifier: duplicates within a conference are rejected with an inline field error, logging in with the corrected address works immediately, and the organizer's auto-minted identity is protected (its email stays tied to the global account).
- The Directory now sorts unnamed profiles last and shows their email next to "Unnamed" for moderators/owners so they can tell people apart. Emails stay hidden from non-moderators.
- Initials avatars update immediately after a display-name change instead of showing stale initials (or "?") for up to five minutes: the fallback avatar URL carries the current name as its cache key. Applied across the profile page, editor, directory, and chat.
