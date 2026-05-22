---
"simple-unconference": patch
---

Every user action now confirms via toast — no more silent deletes, no more leftover inline success banners, no more `alert()` for errors.

Audited and fixed across SessionsTab (create / delete / publish / unpublish / reject / star / unstar), AgendaTab (slot delete, track set/clear, slot configure save, mixer room selection, mixer avoid-mode), RoomsTab (create / update / delete), and PeopleTab (revoke invite, promote / demote, remove participant). Inline form-validation `Banner`s stay where they belong (next to the form input that's invalid).

Also extracted a shared `CopyButton` component so every "copy to clipboard" action gives the same feedback shape — inline label toggle (Copy → ✓ Copied for 1.5s) PLUS a success toast PLUS a `window.prompt()` fallback when the clipboard API is blocked. Previously the SettingsTab "Join link" Copy button was completely silent, while the My-schedule "Copy" button had inline-only feedback and the PeopleTab "Copy link" had nothing. All three now use the shared component and behave identically.
