// Back-compat for the old hash-router URLs. The app now uses real path routing
// (so each conference can install as its own PWA — see routes/manifest.ts), but
// links minted before the switch use the `/#/…` fragment form: old bookmarks,
// already-sent verification / password-reset emails, existing push CTAs, shared
// board links. This pure helper maps such a URL onto its path equivalent so a
// one-time `history.replaceState` at boot keeps every old link working.
//
// Pure (no DOM) so it's unit-tested in legacyRoute.test.ts; the caller in
// client.tsx feeds it `location.hash` + `location.search` and applies the result.

/**
 * Translate a legacy hash-route URL into the equivalent path URL, or return null
 * when there's nothing to migrate (no `#/…` fragment).
 *
 * The hash payload can carry its own query tail (`#/board/foo?t=abc`); wouter's
 * old hash-navigate also sometimes hoisted a `?query` into the real search
 * (`/?next=…#/…`). We fold both into the resulting search string so nothing is
 * lost, with the hash payload's own query winning on key conflicts.
 *
 * @param hash   `window.location.hash` (e.g. "#/conferences/foo?x=1")
 * @param search `window.location.search` (e.g. "?next=/conferences/foo")
 * @returns the path URL to replace to (e.g. "/conferences/foo?x=1"), or null.
 */
export function legacyHashToPath(hash: string, search: string): string | null {
  if (!hash.startsWith("#/")) return null;

  const payload = hash.slice(1); // drop the leading "#": "/conferences/foo?x=1"
  const qIdx = payload.indexOf("?");
  const pathPart = qIdx === -1 ? payload : payload.slice(0, qIdx);
  const hashQuery = qIdx === -1 ? "" : payload.slice(qIdx + 1);

  // Common case: the hash payload has no query of its own — keep any pre-existing
  // real search verbatim (avoids URLSearchParams re-encoding, e.g. of ?next=).
  if (!hashQuery) return pathPart + search;

  // Otherwise merge the pre-existing real search with the hash payload's query;
  // the hash payload's own params win, since that's the route the user opened.
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [k, v] of new URLSearchParams(hashQuery)) params.set(k, v);

  const query = params.toString();
  return query ? `${pathPart}?${query}` : pathPart;
}
