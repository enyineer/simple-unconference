---
"simple-unconference": patch
---

Polish the profile page and directory tab for mobile and visual consistency.

Profile page: the avatar previously rendered at a fixed `256×256`, which dominated narrow viewports. It now sizes responsively (`160×160` on desktop, `88×88` on mobile) and opens in a full-viewport lightbox on click (dismiss with click anywhere or Esc; body scroll is locked while open). Each entry row collapses from `label | value | copy` to a 2-row stack on screens ≤640px so long values get the full width instead of competing with a fixed label column. The "Tags", "Web & socials", and "Contact" sections are now wrapped in `Card` to match the header's chrome, and the in-card heading was demoted from `h1` to `h2` (the page already owns the document-level heading context).

Directory tab: `YourProfileCard` and `DirectoryRow` now share the same row chrome — the accent-left stripe on the viewer's own row is gone, replaced by an inline "You" badge next to the name, so the directory reads as one consistent list. Rows collapse on screens ≤480px (actions drop below the text instead of being squeezed against the avatar), long names and subtitles ellipsize (subtitle line-clamped to 2 lines), the search input gained a clear (×) button when populated, and a result count line ("12 profiles match your filters") appears above the list.
