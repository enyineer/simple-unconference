---
"simple-unconference": minor
---

Add `auth.deleteSelf` RPC: an authenticated owner can delete their own User row. Sessions cascade via the existing FK so all the user's devices are signed out; the response clears the global cookie. Conferences they still own become orphaned (`ownerUserId -> NULL` per the schema's existing `SetNull` rule) — call `conferences.delete()` first for a fully clean slate.

The loadtest runner now uses this to teardown the owner account it creates during bootstrap. Combined with an existing `conferences.delete()`, runs leave no trace on the target instance by default. Pass `--no-cleanup` to skip teardown for debugging. Falls back gracefully (warning, no error) when run against older releases that don't have `auth.deleteSelf` yet.
