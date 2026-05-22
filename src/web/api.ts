// Typed oRPC client for the SPA.
//
// Inputs are validated against valibot schemas declared in
// `src/shared/contract.ts`. Output types are inferred from the server
// router (`RouterClient<AppRouter>`) so the exact shape each handler
// returns flows back to every caller — change a handler return value
// and TypeScript catches the drift at the call site immediately.
//
// `import type` keeps the AppRouter reference type-only: the server
// module is never bundled into the browser build.

import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../server/rpc";

const link = new RPCLink({
  url: () => `${window.location.origin}/api`,
  // Forward + accept the session cookie. Required for /auth/login etc.
  fetch: (request, init) => fetch(request, { ...init, credentials: "same-origin" }),
});

export const api: RouterClient<AppRouter> = createORPCClient(link);

// `ApiError` is the runtime class thrown when an RPC call fails. We alias
// oRPC's own `ORPCError` so existing `e instanceof ApiError` checks keep
// working — wrapping the client in a Proxy would break oRPC's own lazy
// nested-Proxy that builds the procedure path on each property access.
export { ORPCError as ApiError } from "@orpc/client";

// The server throws like `new ORPCError("CONFLICT", { message: "session_full" })`.
// On the wire, `code` is the HTTP class ("CONFLICT") and `message` carries
// our domain code ("session_full"). Components branch on the domain code,
// so they should read it via this helper rather than `.code` directly.
export function errorCode(e: unknown): string {
  if (e instanceof ORPCError) return e.message || e.code;
  return "error";
}

// Multipart avatar upload. The avatar pipeline lives behind a plain Hono
// route (binary body), so it can't go through the oRPC client. The server
// hashes the resized webp and returns the new content hash so callers can
// compose the cacheable URL (`/api/avatars/<slug>/<id>/<hash>`) without
// re-fetching the profile to learn it.
export async function uploadAvatar(
  slug: string,
  file: File,
  identityId?: number,
): Promise<{ hash: string }> {
  const fd = new FormData();
  fd.append("file", file);
  if (identityId != null) fd.append("identity_id", String(identityId));
  const r = await fetch(`/api/avatars/${encodeURIComponent(slug)}/upload`, {
    method: "POST",
    body: fd,
    credentials: "same-origin",
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "upload_failed");
  }
  const body = (await r.json()) as { ok: boolean; hash: string };
  return { hash: body.hash };
}

// Flatten Standard-Schema validation issues into a `{ path → message }` map
// (the shape `useForm.applyServerErrors` already understands).
type Issue = { path?: ReadonlyArray<{ key: PropertyKey } | PropertyKey>; message?: string };
export function errorFields(e: unknown): Record<string, string> | undefined {
  if (!(e instanceof ORPCError)) return undefined;
  const data = e.data as { fields?: Record<string, string>; issues?: Issue[] } | undefined;
  if (data?.fields) return data.fields;
  if (data?.issues) {
    const out: Record<string, string> = {};
    for (const issue of data.issues) {
      const path = (issue.path ?? [])
        .map((p) => String(typeof p === "object" && p !== null && "key" in p ? p.key : p))
        .join(".") || "_";
      if (!(path in out)) out[path] = issue.message ?? "Invalid";
    }
    return out;
  }
  return undefined;
}
