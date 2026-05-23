---
"simple-unconference": patch
---

Fix `react-hooks/set-state-in-effect` lint failure in `usePaginatedList`.

The fetch effect previously called `setLoading(true)` and `setError(null)` synchronously before kicking off the request, which the React ESLint plugin flags as a cascading-render hazard. Page, error, and the inputs they were loaded for now live in a single state object updated atomically from inside the promise callback; `loading` is derived from `(result.key !== currentKey)` so it flips true automatically when inputs change without any synchronous setState. Error display clears in lockstep with new data since both ride on the same update.
