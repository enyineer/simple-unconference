---
"simple-unconference": patch
---

Internal: split the largest source files into focused modules, and fail fast in dev when the API port is already bound.

The nine largest files (`src/server/rpc.ts` at 4466 lines, `AgendaTab.tsx` at 3448, `SessionsTab.tsx` at 1528, `Calendar.tsx` at 1005, `ExpertsTab.tsx` at 985, `SettingsTab.tsx` at 926, `shared/contract.ts` at 915, `MyAssignmentsTab.tsx` at 718, and `shared/schemas.ts` at 555) have been split by router / component / domain into per-file modules under `src/server/rpc/`, `src/web/conference/tabs/<area>/`, `src/shared/contract/`, and `src/shared/schemas/`. Public exports and import paths used by external consumers are preserved (the shared entry files now re-export from the sub-modules), so no calling code changed. Behavior is identical: typecheck clean, lint clean, all 320 tests pass.

Dev port guard: `Bun.serve` previously used `reusePort: true` unconditionally, which let a freshly-started dev API silently bind alongside an orphaned old process and answer half the requests. `reusePort` is now enabled only for forked cluster workers (which have `WORKER_ID` set). Single-process mode — `bun dev`, `bun start`, and `WORKERS=1`/unset — leaves it off, so a port collision surfaces as a hard `EADDRINUSE` instead of two backends serving stale code in parallel. Multi-worker production behavior is unchanged.
