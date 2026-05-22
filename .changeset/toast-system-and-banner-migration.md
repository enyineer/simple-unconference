---
"simple-unconference": minor
---

App-wide toast notification system, transfer-ownership UI, and TabBar scrollbar fix.

**Toasts replace status banners across the app.** Action-result feedback (errors, successes, info, warnings) now surfaces as floating cards anchored to the bottom-right (full-width on mobile, safe-area aware) instead of as top-of-tab `<Banner>`s. The old pattern hid errors off-screen when a user was scrolled to a deep action (the Danger zone in Settings was the trigger); toasts decouple feedback from page scroll position. Errors and warnings hang around 8s with `role="alert"` + `aria-live="assertive"`, success/info dismiss after 5s with polite live regions, and every toast is manually dismissable.

The new `useToast()` hook (imported from `design-system/hooks`) returns `{ error, success, warning, info, dismiss }`. The provider mounts once inside `<DesignSystemProvider>` in `App.tsx`. CSS vars from the active design-system plugin drive the colors so both Primer and Minimal plugins surface toasts identically.

**Migrated to toasts**: every form-submit / button-click / mutation-result feedback site — Login, ConferenceLogin, Join, Conferences ("New conference"), SettingsTab (all section saves + Danger zone + Join link), RoomsTab (Add/Edit room), PeopleTab (Invite single + bulk + revoke + remove), SessionPicker (pick / unlock), MyAssignmentsTab (CalendarSubscribe reset), ExpertsTab (book / cancel / promote / demote / pool CRUD / timeframe CRUD / expert edit), and AgendaTab (assignment results — clean / partial / conflict — slot create / slot edit / conflict-resolver apply).

**Stays as inline `<Banner>`**: persistent in-context state, not user-action results — Conference.tsx fatal page-load failure, Join.tsx invite-link-can't-be-used page, ExpertsTab.tsx "you need a room or pool first" precondition warning. Form-level field errors (the `useForm` field-by-field validation) continue to render inline under each input.

**Other fixes bundled in:**
- **Owner-side "Transfer ownership" UI** in the Settings Danger zone. The backend `conferences.transferOwnership` endpoint already existed; this wires up a confirm form (email input → click Transfer → navigate back to conferences list) and maps `user_not_found` / `same_user` to friendly messages.
- **TabBar vertical-scrollbar fix.** `overflow-x: auto` implicitly turns `overflow-y` from `visible` into `auto` per CSS spec; combined with the buttons' `margin-bottom: -1` border-overlap trick, this surfaced a spurious vertical scrollbar in the conference page header. Pinning `overflow-y: hidden` suppresses it.
