---
"simple-unconference": minor
---

Paginate + add server-side search to the large list views so big conferences (hundreds-to-thousands of sessions, participants, profiles, rooms, invites, and chat reports) stay responsive.

**Shared building blocks**

- New `Page<T> = { items, total, next_cursor }` envelope in `src/shared/contract/types.ts` and a matching `PageInputEntries` valibot primitive (`q`, `cursor`, `limit`) composed into each paginated procedure's input.
- Server helpers `parsePageInput` / `pageOf` in `src/server/rpc/shared.ts`. `cursor` is an opaque offset token (decimal string); `limit` clamps to `[1, 100]`, default 25.
- Frontend `usePaginatedList` hook in `src/web/conference/usePaginatedList.ts` — owns search `q` with 200ms debounce, cursor stack so Prev is O(1), stale-fetch suppression via a sequence counter, and a `refresh()` hook callers wire to realtime bus events.
- `<Pager />` UI in `src/web/conference/ui/Pager.tsx`: "Showing X-Y of N · Page X/Y" + Prev/Next. Drop-in for every list.

**Paginated + searchable**

- `rooms.list` — search by name / description / tag.
- `submissions.list` — search by title / description / submitter name / tag (mods also match submitter email). `status`, `starred_only`, and `tags[]` (AND) are server-side too so paging counts honor them.
- `profiles.list` — search by name / title / company / tag.
- `conferences.listParticipants` — search by email / name.
- `conferences.listInvites` — search by email; new `status: "pending" | "claimed" | "all"` filter.
- `moderation.listChatReports` — search by reason / reporter name / sender name / message body. Returns compact `MessageReportSummaryOut` rows (no surrounding-message window).
- `moderation.listChatBans` — search by name / email / ban reason.

**New escape-hatch procedures**

Picker / form contexts that genuinely need every row (slot pickers, session room-tag picker, expert/agenda views) keep working via:
- `rooms.listAll` — unpaginated, `RoomOut[]` (the previous shape of `rooms.list`).
- `submissions.listAll` — unpaginated, `SubmissionOut[]` (the previous shape of `submissions.list`); honors the same privacy gate.
- `moderation.getChatReport` — full `MessageReportOut` (revisions + ±5 surrounding messages) loaded lazily when the moderator opens a report from the paginated list.
- `conferences.exportInvites` — server-streamed CSV-source list of every pending invite matching the current search `q`. The People tab's "Download CSV" button now calls this instead of paging the client through every row, so big rosters export consistently and don't race against creates / claims.

**UI changes**

- Rooms tab: search input + pager.
- Sessions tab: search now hits the server (folds in tag/title/description/speaker matches); status chips and starred-only toggle are server-driven; pager replaces the implicit "everything in memory" model.
- Directory: pager replaces the old "load everything" pattern; the existing 200ms debounce moves into `usePaginatedList`.
- People tab: separate search + pager for participants and pending invites; Chat-reports section gets its own search + pager, plus a separate search + pager for the banned-from-chat list. Status chips on reports keep working.

**Wire-shape changes**

The `list` procedures above now return `Page<T>` instead of `T[]`. Tests that consumed the array directly use `.items` (or `listAll` where the original semantics matter). All 374 tests pass; `tsc --noEmit` clean.

**Dev script reliability**

`bun --hot` reloads file bodies in place, but the oRPC router is built once at module-eval time — `implement(contract)` + the `requireConf(...).foo.list.handler(...)` chain capture references to the contract object then. Reshaping the contract or adding a procedure doesn't propagate to the running router; the API keeps serving the old wire shape while the SPA recompiles against the new types. `scripts/dev.ts` now restarts the API on changes under `src/server/rpc/**` or `src/shared/contract*`, matching the existing Prisma-client watcher pattern. All three watchers share a single 300ms debounced timer.
