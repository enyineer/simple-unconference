---
"simple-unconference": minor
---

Make quotas visible — error messages, usage panel, threshold notifications.

- **Specific error messages** for every `quota_exceeded` response. New `src/web/quotaErrors.ts` resource-switches on `data.resource` and renders a real sentence with the actual limit (e.g. "You've reached the limit of 5 sessions for this conference. Delete one of yours before submitting another.") instead of the raw code. Wired into every page that can hit a quota: Login, Conferences, Join, SessionsTab, RoomsTab, PeopleTab.
- **Mod-only Usage card** in the Settings tab. Shows live counters for Participants, Pending invites, Rooms, and Total sessions against their configured caps, with progress bars that turn yellow at 80% and red at the cap. Reads from a new `usage` field on the `conferences.get` response (populated only when caller is moderator+).
- **Threshold notifications.** When a `claimInvite`, `signupViaLink`, `createInvite`, or `rooms.create` insert crosses 80% or hits 100% of its cap, all conference moderators get an inbox notification (`kind: "quota_threshold"`) so they can raise the limit before the wall is hit. Fires once per integer crossing — no spam.
- **Owner-side quota hint** on the global Conferences page. Counts conferences the viewer owns against `MAX_CONFERENCES_PER_USER` (now exposed via `config.get`), with the same yellow-at-80% / red-at-cap colour treatment.
- **Per-user session cap visibility** on the Sessions tab. Shows "X of N session submissions used" using a new `my_session_count` field on `conferences.get` — counts ALL the viewer's submissions including rejected and finished ones, since those occupy quota slots but aren't returned by `submissions.list` for non-mods. Stays accurate across creates/deletes via an `onSessionMutated` refresh hook.

Net result: nobody hits a wall as a surprise; the first quota_exceeded is the *third* signal you've had a chance to act on.
