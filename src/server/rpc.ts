// oRPC server router: every API procedure declared in `src/shared/contract.ts`
// is implemented here. The shape returned by each handler is checked at
// compile time against the contract via the `implement(contract)` pattern,
// so client/server drift surfaces as a TypeScript error.
//
// One exception: GET /api/calendar/<token>.ics is served directly by Hono
// (see `src/server/routes/calendar.ts`) because it produces text/calendar
// for third-party calendar clients to subscribe to.

import { RPCHandler } from "@orpc/server/fetch";
import type { PrismaClient } from "@prisma/client";
import { base } from "./rpc/shared";
import { configRouter } from "./rpc/config";
import { authRouter } from "./rpc/auth";
import { conferenceRouter } from "./rpc/conferences";
import { roomsRouter } from "./rpc/rooms";
import { submissionsRouter } from "./rpc/submissions";
import { agendaRouter } from "./rpc/agenda";
import { expertsRouter } from "./rpc/experts";
import { notificationsRouter } from "./rpc/notifications";
import { profilesRouter } from "./rpc/profiles";

export function buildRouter() {
  return base.router({
    config: configRouter,
    auth: authRouter,
    conferences: conferenceRouter,
    rooms: roomsRouter,
    submissions: submissionsRouter,
    agenda: agendaRouter,
    experts: expertsRouter,
    notifications: notificationsRouter,
    profiles: profilesRouter,
  });
}

export type AppRouter = ReturnType<typeof buildRouter>;

// Hono adapter — call from a `app.all("/api/*", ...)` route. Returns null
// when oRPC didn't match (so the caller can hand off to other Hono routes).
export async function handleRpc(
  prisma: PrismaClient,
  req: Request,
): Promise<Response | null> {
  const handler = new RPCHandler(buildRouter());
  const responseHeaders = new Headers();
  const { matched, response } = await handler.handle(req, {
    prefix: "/api",
    context: { prisma, req, responseHeaders },
  });
  if (!matched) return null;
  // Splice any Set-Cookie headers the procedures wrote (login/logout/etc).
  for (const [k, v] of responseHeaders) response.headers.append(k, v);
  return response;
}
