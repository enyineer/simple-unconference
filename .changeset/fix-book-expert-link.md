---
"simple-unconference": patch
---

Fix the "Book Expert" link on a profile page navigating to the wrong tab.

`openExperts` in `ProfilePage` set `window.location.hash` to
`/conferences/<slug>?tab=experts`, but `ConferencePage` derives the active tab
from the `/:tab` URL segment (`/conferences/<slug>/experts`), not a `?tab=`
query param — so the click landed on the default "sessions" tab. It now
navigates straight to `/conferences/<slug>/experts` via `navigate`, matching
the canonical tab routing used by `setTab`.
