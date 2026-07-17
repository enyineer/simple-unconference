---
"simple-unconference": patch
---

Fixed the default PWA icons being served as Git LFS pointer text instead of real PNG bytes. The default `icon-192.png` / `icon-512.png` are LFS-tracked, but the CI test and release image builds checked out without LFS, so a conference with no custom icon would have served a broken image (and the icon-fallback test failed). Both the `test` and `docker` CI checkouts now pull LFS objects.
