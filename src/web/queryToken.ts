// Read the `token` query param off the current location.
//
// wouter v3's `useLocation()` returns the bare pathname — the query tail lives
// in its `useSearch()` hook (`"?token=…"`, or `""` when absent). Token-bearing
// links (password reset, magic-link email verify) must read the param from the
// SEARCH, not the path: a path-only scan finds no `?` and silently yields an
// empty token, which the schema then rejects client-side with the same generic
// copy the server uses for a genuinely bad token.
//
// Pure (no DOM) so it's unit-tested in queryToken.test.ts.

export function tokenFromSearch(search: string): string {
  // `URLSearchParams` strips a single leading "?" itself, so both wouter's
  // `useSearch()` output and a bare param string work as-is.
  return new URLSearchParams(search).get("token") ?? "";
}
