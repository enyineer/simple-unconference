---
"simple-unconference": patch
---

Each conference can now be installed as its own separate app. The app moved from hash-based URLs (`/#/conferences/<slug>`) to real paths (`/conferences/<slug>/`), and each conference's web app manifest now has a distinct path-scoped `scope`/`start_url`. Previously every conference shared `scope: "/"`, so Chrome treated them as one app — installing a second conference just showed "Open <the first one>". Now Chrome installs each conference as its own icon.

Old `/#/…` links (bookmarks, already-sent verification / password-reset emails, existing push and board links) are transparently redirected to the new path form at load, so nothing breaks.
