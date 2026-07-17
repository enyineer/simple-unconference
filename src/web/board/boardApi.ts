// Tiny typed fetch helper for the public Live Board.
//
// The board is served by a plain Hono route (`GET /api/board/:slug?t=<token>`),
// NOT the oRPC client, so it can't ride the `api` object. This keeps a single
// typed entry point returning the exact `BoardPayloadOut` shape the server
// declares. A 404 means "no such board / wrong token" (the server never
// distinguishes the two) — surfaced to the page as `notActive`.

import type { BoardPayloadOut } from "../../shared/contract/types";

export type BoardFetchResult =
  | { kind: "ok"; payload: BoardPayloadOut }
  | { kind: "not_active" }
  | { kind: "error" };

export async function fetchBoardPayload(
  slug: string,
  token: string,
): Promise<BoardFetchResult> {
  try {
    const res = await fetch(
      `${window.location.origin}/api/board/${encodeURIComponent(slug)}?t=${encodeURIComponent(token)}`,
      { credentials: "same-origin", headers: { accept: "application/json" } },
    );
    if (res.status === 404) return { kind: "not_active" };
    if (!res.ok) return { kind: "error" };
    const payload = (await res.json()) as BoardPayloadOut;
    return { kind: "ok", payload };
  } catch {
    return { kind: "error" };
  }
}

// SSE stream URL for the same slug/token. The client opens an EventSource here
// and refetches the payload (debounced) on any forwarded event.
export function boardStreamUrl(slug: string, token: string): string {
  return `${window.location.origin}/api/board/${encodeURIComponent(slug)}/stream?t=${encodeURIComponent(token)}`;
}
