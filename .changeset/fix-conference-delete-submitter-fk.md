---
"simple-unconference": patch
---

Fix `P2003` foreign-key crash when deleting a conference (and when removing a participant who authored a submission).

`Submission.submitter` referenced `ConferenceIdentity` with no `onDelete`, so it defaulted to `Restrict`. Deleting a conference cascades into both its identities and its submissions, but the Restrict edge between a submission and its (about-to-be-deleted) submitter blocked the cascade, surfacing as `ForeignKeyConstraintViolation`. The same edge made `conferences.removeParticipant` 500 whenever the removed identity had submitted a session. The relation is now `onDelete: Cascade` (migration `submission_submitter_cascade`): removing an identity removes the sessions they authored.
