---
"simple-unconference": patch
---

Run SQLite in WAL journal mode: boot now enables it (idempotent + persistent), so one
stalled writer can no longer block every reader across workers (P1008/SQLITE_BUSY outage
class). Also fix test-only process.env pollution from push.test.ts restores.
