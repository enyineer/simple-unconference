// One global SSE stream per browser tab. Mounted at GET /api/realtime/stream.
//
// Auth: enumerates every per-conference identity cookie on the request PLUS
// the owner cookie (and auto-mints owner identities for every conference the
// owner runs). Subscribes the connection to the EventBus for each identity id.
// One connection therefore covers the user's full notification + chat surface
// across every conference they belong to — see plans/chat.md Phase 3.
//
// Replay: if the client sends `Last-Event-ID: <msgId>:<notifId>`, we backfill
// messages with id > msgId and notifications with id > notifId for every
// subscribed identity before going live. EventSource auto-resends this header
// on reconnect, so transient disconnects heal without client-side bookkeeping.
//
// Wire format per event:
//   id: <highestMsgIdSoFar>:<highestNotifIdSoFar>
//   event: <kind>
//   data: <JSON payload>
//   (blank line)
//
// The id tuple is opaque to EventSource; we control both encoding and parsing.
// Heartbeats `:ping\n\n` go out every 20s to keep proxies (nginx, traefik,
// Vite's http-proxy) from idle-closing the connection.

import { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { ownerCookieName, readCookie, principalFromRequest } from "../auth";
import { getBus, type BusEvent } from "../realtime/bus";
import {
  recordConnectionOpened,
  recordConnectionClosed,
  recordReplayMessageEvent,
  recordReplayNotificationEvent,
} from "../realtime/metrics";

const HEARTBEAT_INTERVAL_MS = 20_000;
// Stop accepting new events when this many are already queued for a single
// connection. Forces the client to reconnect (and replay via Last-Event-ID),
// recovering naturally without the server holding unbounded memory.
const PER_CONNECTION_QUEUE_LIMIT = 256;

interface LastSeenIds {
  messageId: number;
  notificationId: number;
}

function parseLastEventId(header: string | null): LastSeenIds | null {
  if (!header) return null;
  const [msgStr, notifStr] = header.split(":");
  const m = Number(msgStr);
  const n = Number(notifStr);
  if (!Number.isFinite(m) || !Number.isFinite(n)) return null;
  return { messageId: Math.max(0, Math.floor(m)), notificationId: Math.max(0, Math.floor(n)) };
}

// Resolve every identity id this request has access to. Reads:
//   - owner cookie -> auto-mints / fetches identity rows for every owned conf
//   - per-conference identity cookies -> identity row directly
// Cross-cookie dedup via Set on identity id.
async function resolveSubscriberIdentities(
  prisma: PrismaClient,
  req: Request,
): Promise<Array<{ identityId: number; conferenceId: number }>> {
  const ids = new Map<number, number>(); // identityId -> conferenceId

  // Owner: one identity row per owned conference.
  const ownerToken = readCookie(req, ownerCookieName());
  if (ownerToken) {
    const owner = await principalFromRequest(prisma, req, { type: "owner" });
    if (owner && owner.kind === "owner") {
      const ownedConfs = await prisma.conference.findMany({
        where: { ownerId: owner.user.id },
        select: { id: true },
      });
      for (const c of ownedConfs) {
        // Idempotent owner-identity mint: matches resolveConferencePrincipal's
        // ensureOwnerIdentity behavior. Inlined to avoid coupling.
        const existing = await prisma.conferenceIdentity.findUnique({
          where: { conferenceId_email: { conferenceId: c.id, email: owner.user.email } },
          select: { id: true },
        });
        const idRow = existing ?? await prisma.conferenceIdentity.create({
          data: {
            conferenceId: c.id,
            email: owner.user.email,
            name: owner.user.name,
            passwordHash: null,
            role: "participant",
            ownerUserId: owner.user.id,
            claimedAt: new Date(),
          },
          select: { id: true },
        });
        ids.set(idRow.id, c.id);
      }
    }
  }

  // Identities: scan cookie header for uncon_session_<confId> patterns.
  const cookieHeader = req.headers.get("cookie") ?? "";
  const ownerName = ownerCookieName();
  const seenConfs = new Set<number>();
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq);
    if (name === ownerName) continue;
    const prefix = `${ownerName}_`;
    if (!name.startsWith(prefix)) continue;
    const confIdStr = name.slice(prefix.length);
    const confId = Number(confIdStr);
    if (!Number.isInteger(confId) || confId <= 0) continue;
    if (seenConfs.has(confId)) continue;
    seenConfs.add(confId);
    const p = await principalFromRequest(prisma, req, { type: "conference", conferenceId: confId });
    if (p && p.kind === "identity") {
      ids.set(p.identity.id, p.identity.conferenceId);
    }
  }

  return Array.from(ids.entries()).map(([identityId, conferenceId]) => ({ identityId, conferenceId }));
}

// Serialize a bus event into the SSE wire format. Caller passes the running
// cursor tuple so the id field is monotonically updated.
function frameEvent(kind: string, data: unknown, ids: LastSeenIds): string {
  return `id: ${ids.messageId}:${ids.notificationId}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function realtimeRoutes(prisma: PrismaClient) {
  const app = new Hono();

  app.get("/stream", async (c) => {
    const subscribers = await resolveSubscriberIdentities(prisma, c.req.raw);
    if (subscribers.length === 0) {
      return c.text("unauthorized", 401);
    }

    const lastSeen = parseLastEventId(c.req.header("last-event-id") ?? null);
    const identityIds = subscribers.map((s) => s.identityId);
    const identitySet = new Set(identityIds);

    const bus = getBus();
    const encoder = new TextEncoder();

    // Per-connection state. `closed` short-circuits everything once the
    // client disconnects or we force a tear-down for backpressure.
    let closed = false;
    let queuedBytes = 0; // not bytes — count of in-flight events
    const cursor: LastSeenIds = lastSeen ?? { messageId: 0, notificationId: 0 };
    const unsubscribes: Array<() => void> = [];
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    function safeEnqueue(chunk: string): void {
      if (closed || !controller) return;
      if (queuedBytes >= PER_CONNECTION_QUEUE_LIMIT) {
        // Drop the connection — client reconnect + replay recovers.
        teardown("backpressure");
        return;
      }
      try {
        queuedBytes++;
        controller.enqueue(encoder.encode(chunk));
      } catch {
        teardown("enqueue_failed");
      } finally {
        // We don't truly know when the chunk drains; treat this as a coarse
        // counter rather than a precise queue depth. Decrement on a microtask
        // so a flood of synchronous publishes still trips the limit, but
        // steady-state load drains.
        queueMicrotask(() => { queuedBytes = Math.max(0, queuedBytes - 1); });
      }
    }

    function teardown(reason: string): void {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      for (const off of unsubscribes) {
        try { off(); } catch { /* ignore */ }
      }
      recordConnectionClosed();
      try { controller?.close(); } catch { /* already closed */ }
      // reason is for future log-sampling; intentionally not logged on every
      // close to avoid noise. Reconnect storms would surface via the metrics
      // counters and dropped-event logs.
      void reason;
    }

    // Build the ReadableStream. We do replay + subscription inside `start`
    // so we have controller access; the connection is "open" from the
    // client's perspective the moment we return the Response.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        recordConnectionOpened();

        // Flush an immediate heartbeat so the dev proxy + the browser see
        // the response body start streaming right away (otherwise some
        // proxies hold the headers until the first byte). The browser's
        // EventSource ignores `:` comment lines.
        safeEnqueue(":hello\n\n");

        // Replay: emit anything newer than the cursor across all identities,
        // then subscribe to the live bus. Order matters: we must finish
        // backfill before live events to keep client state monotonic.
        void (async () => {
          try {
            await replay();
            subscribeToBus();
            heartbeat = setInterval(() => safeEnqueue(":ping\n\n"), HEARTBEAT_INTERVAL_MS);
          } catch (e) {
            console.error("[realtime] replay/subscribe failed", e);
            teardown("replay_failed");
          }
        })();
      },
      cancel() {
        teardown("client_closed");
      },
    });

    async function replay(): Promise<void> {
      // Messages addressed to any of our identities (sender is OTHER party;
      // we don't replay our own sent messages — they were returned by the
      // chat.send RPC response and the client already has them).
      const newMessages = await prisma.message.findMany({
        where: {
          id: { gt: cursor.messageId },
          conversation: {
            OR: [
              { identityIdLow: { in: identityIds } },
              { identityIdHigh: { in: identityIds } },
            ],
          },
        },
        orderBy: { id: "asc" },
        select: {
          id: true,
          conversationId: true,
          senderIdentityId: true,
          conversation: { select: { identityIdLow: true, identityIdHigh: true } },
        },
      });
      for (const m of newMessages) {
        const recipientId = identitySet.has(m.conversation.identityIdLow)
          ? m.conversation.identityIdLow
          : m.conversation.identityIdHigh;
        cursor.messageId = Math.max(cursor.messageId, m.id);
        safeEnqueue(frameEvent("message.created", {
          messageId: m.id,
          conversationId: m.conversationId,
          recipientId,
        }, cursor));
        recordReplayMessageEvent();
      }

      const newNotifs = await prisma.notification.findMany({
        where: {
          id: { gt: cursor.notificationId },
          identityId: { in: identityIds },
        },
        orderBy: { id: "asc" },
        select: { id: true, identityId: true },
      });
      for (const n of newNotifs) {
        cursor.notificationId = Math.max(cursor.notificationId, n.id);
        safeEnqueue(frameEvent("notification.upserted", {
          notificationId: n.id,
          recipientId: n.identityId,
        }, cursor));
        recordReplayNotificationEvent();
      }
    }

    function subscribeToBus(): void {
      for (const { identityId } of subscribers) {
        const off = bus.subscribe(identityId, (ev: BusEvent) => {
          // Advance the cursor before writing so the wire `id:` field reflects
          // the latest event the client has seen. Tracking the two streams
          // independently lets the replay query target each correctly.
          if (ev.kind === "message.created" || ev.kind === "message.edited" || ev.kind === "message.deleted") {
            cursor.messageId = Math.max(cursor.messageId, ev.messageId);
          } else if (ev.kind === "notification.upserted") {
            cursor.notificationId = Math.max(cursor.notificationId, ev.notificationId);
          }
          safeEnqueue(frameEvent(ev.kind, ev, cursor));
        });
        unsubscribes.push(off);
      }
    }

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        // Disable proxy buffering (nginx, traefik) so events flush immediately
        // instead of pooling until the response body completes.
        "x-accel-buffering": "no",
        "connection": "keep-alive",
      },
    });
  });

  return app;
}
