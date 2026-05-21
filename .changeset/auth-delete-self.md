---
"simple-unconference": minor
---

Self-service account lifecycle: two new authenticated RPCs.

- `auth.deleteSelf` deletes the calling owner's User row. Sessions cascade via the existing FK so all the user's devices are signed out; the response clears the global cookie. **Refuses with `owned_conferences_present` (error data: `{ owned: string[] }`) when the caller still owns conferences** — those carry other people's data and shouldn't be silently orphaned. Caller must first delete or transfer each conference.
- `conferences.transferOwnership({ new_owner_email })` hands ownership of a conference to another existing global User by email. Owner-only. The new owner's `ConferenceIdentity` auto-mints on their next visit; the previous owner loses owner-level access (re-invite as moderator if needed). Errors: `user_not_found`, `same_user`.

The loadtest runner now uses `auth.deleteSelf` to teardown the owner account it creates during bootstrap. Combined with the existing `conferences.delete()`, runs leave no trace on the target by default. Pass `--no-cleanup` to skip teardown for debugging. Falls back gracefully (warning, no error) when run against older releases that don't have these endpoints yet.
