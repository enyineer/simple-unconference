---
"simple-unconference": patch
---

Prune the production Docker image: install only `dependencies` (no `vite`, `@types/*`, or changesets tooling) in the runtime stage. `prisma` is now a regular dependency so `prisma migrate deploy` still runs at boot.
