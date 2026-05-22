---
"simple-unconference": minor
---

Per-conference user profiles, a directory tab, and link-everywhere navigation.

Each attendee can now publish a profile with a bio, pronouns, title, company, avatar, free-form web/social links, contact entries, and tags. Profiles are opt-in (a "Published" toggle gates visibility) and per-entry public flags let people share a public LinkedIn while keeping a Signal number visible only to moderators.

A new **Directory** tab (visible to all members) lists every published profile with debounced search and tag filtering. The viewer's own card is pinned at the top with "View" / "Edit" buttons, so setting up or updating your profile is one click from the directory. People + Rooms tabs remain moderator-only.

Names in the **Sessions**, **Agenda**, and **Experts** tabs render as profile links when the target has published a profile (moderators always get a link). Unlinked names remain plain text so non-mods never get a dead-end click.

Avatars are stored as 256×256 WebP under `data/avatars/<conf>/<id>.webp`, served at `/api/avatars/:slug/:identityId[/:hash]` with content-hash-based cache busting. Hashed URLs are publicly cacheable for one year when the profile is published; unpublished or stale-hash requests fall back to private or no-store caching, and any profile not visible to the viewer returns an initials SVG (never a 404) so the existence of an unpublished profile can't be probed.

Includes 14 server-side privacy regression tests, 11 avatar pipeline tests, schema migrations for `ProfileEntry`, `ProfileTag`, and the new fields on `ConferenceIdentity`, plus permission table + CLAUDE.md updates.
