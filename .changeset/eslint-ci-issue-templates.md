---
"simple-unconference": patch
---

Add ESLint, a CI workflow that runs typecheck/lint/tests on PRs, and GitHub issue templates (bug report, feature request) adapted from `enyineer/checkstack`.

ESLint flat config (v9) bundles the de facto standard rulesets: `@eslint/js`, `typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks` v7 (compiler-aligned), and `eslint-plugin-react-refresh`. All resulting violations are fixed at the source rather than silenced.

Notable refactors driven by the new rules:

- `useNow()` hook (in `src/web/useNow.ts`) replaces `Date.now()` calls in component render paths for `isPast` / `expired` checks (react-hooks/purity).
- Async data fetches in `App.tsx`, `Conference.tsx`, `NotificationBell.tsx`, `AgendaTab.tsx`, `MyAssignmentsTab.tsx`, `PeopleTab.tsx`, `RoomsTab.tsx`, `SessionsTab.tsx`, `SettingsTab.tsx`, and the design-system provider now read with `.then(setX)` + cancellation flags instead of awaiting in async helpers, so `setState` no longer fires synchronously in effect bodies. Reset-on-prop-change patterns are reworked into slug-tracked derived state or render-time state adjustment (react-hooks/set-state-in-effect).
- Design-system plugin files are split into `components.tsx` (component exports) + `index.tsx` (plugin object), and `useDesignSystem` moves to its own `context.tsx`, so component files stay Fast-Refresh-friendly (react-refresh/only-export-components).
- `useForm`'s generic is constrained to `Record<string, unknown>`, removing `any` casts; remaining design-system `as any` shims were either replaced with proper Primer types or removed where the value was already assignable.
