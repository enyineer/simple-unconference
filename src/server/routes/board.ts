// Public, token-gated, read-only Live Board (F1).
//
// Two endpoints, both mounted under /api/board and BEFORE the oRPC catch-all
// (they're public and one is text/event-stream — neither fits the oRPC
// contract, mirroring routes/calendar.ts + routes/realtime.ts):
//
//   GET /api/board/:slug?t=<token>         → PUBLIC-SAFE JSON snapshot
//   GET /api/board/:slug/stream?t=<token>  → SSE: agenda.changed + board.spotlight
//
// The token (`Conference.boardToken`) is the only secret. Anyone with the URL
// sees the board; the owner enables/rotates it in Settings. The payload is
// strictly PUBLIC-SAFE: titles, room names, star counts, submitter DISPLAY
// NAMES (names are OK per the privacy rules), attendee counts — NEVER emails,
// NEVER unpublished-profile-sensitive data. Keep it that way for any field
// added here.

import { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import type {
  BoardPayloadOut,
  BoardEntryOut,
  BoardSpotlightOut,
} from "../../shared/contract/types";
import { getBus, boardTopicKey, type BusEvent } from "../realtime/bus";
import { effectiveSpeakerNames } from "../lib/speakers";

const HEARTBEAT_INTERVAL_MS = 20_000;

// Prisma select for everything the board needs to render a session's public
// presenter line: authorship (submitter) + the effective speaker rows. Shared
// across the track / placement / spotlight queries so they stay in sync.
const PRESENTER_SELECT = {
  submitterId: true,
  submitter: { select: { name: true } },
  speakers: {
    orderBy: { position: "asc" },
    select: { identityId: true, name: true, identity: { select: { name: true } } },
  },
} as const;

// The board's public presenter line: the session's EFFECTIVE speaker display
// names, joined. Names only (never emails) — safe for the public board. Falls
// back to null when no named presenter resolves.
function presenterLine(sub: {
  submitterId: number;
  submitter: { name: string | null } | null;
  speakers: { identityId: number | null; name: string | null; identity: { name: string | null } | null }[];
}): string | null {
  const names = effectiveSpeakerNames(sub).filter((n) => n.trim().length > 0);
  return names.length > 0 ? names.join(", ") : null;
}

// Resolve + authorize a board request: the conference must exist, have a board
// token set (board enabled), and the `t` query param must match it. Returns the
// conference id + basics, or null when anything fails (caller answers 404 — we
// never distinguish "no such conference" from "wrong token" to avoid leaking
// which conferences have a board enabled).
async function authorizeBoard(
  prisma: PrismaClient,
  slug: string,
  token: string | null,
): Promise<{ id: number; name: string; timezone: string; spotlightSubmissionId: number | null } | null> {
  if (!token) return null;
  const conf = await prisma.conference.findUnique({
    where: { slug },
    select: { id: true, name: true, timezone: true, boardToken: true, spotlightSubmissionId: true },
  });
  if (!conf || !conf.boardToken || conf.boardToken !== token) return null;
  return {
    id: conf.id,
    name: conf.name,
    timezone: conf.timezone,
    spotlightSubmissionId: conf.spotlightSubmissionId,
  };
}

export function boardRoutes(prisma: PrismaClient) {
  const app = new Hono();

  app.get("/:slug", async (c) => {
    const slug = c.req.param("slug");
    const conf = await authorizeBoard(prisma, slug, c.req.query("t") ?? null);
    if (!conf) return c.notFound();
    const payload = await buildBoardPayload(prisma, conf);
    // No caching — the board is live and clients also hold an SSE stream.
    return c.json(payload, 200, { "cache-control": "no-store" });
  });

  // Live updates. Late joiners fetch the current snapshot via the payload route
  // above, so there's no replay/backfill here — we only forward events that
  // arrive after the connection opens. IDs-only events; the client debounces
  // and refetches the payload (see the W3 board page).
  app.get("/:slug/stream", async (c) => {
    const slug = c.req.param("slug");
    const conf = await authorizeBoard(prisma, slug, c.req.query("t") ?? null);
    if (!conf) return c.notFound();

    const bus = getBus();
    const encoder = new TextEncoder();
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    function teardown(): void {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      try { unsubscribe?.(); } catch { /* ignore */ }
      try { controller?.close(); } catch { /* already closed */ }
    }
    function send(chunk: string): void {
      if (closed || !controller) return;
      try { controller.enqueue(encoder.encode(chunk)); } catch { teardown(); }
    }

    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        // Flush an immediate comment so proxies start streaming the body.
        send(":hello\n\n");
        // Subscribe on the conference's board topic key (negative, so it never
        // collides with a per-identity notification subscription). Forward only
        // the two board-relevant kinds as tiny JSON lines.
        unsubscribe = bus.subscribe(boardTopicKey(conf.id), (ev: BusEvent) => {
          if (ev.kind === "agenda.changed" || ev.kind === "board.spotlight") {
            send(`event: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
          }
        });
        heartbeat = setInterval(() => send(":ping\n\n"), HEARTBEAT_INTERVAL_MS);
      },
      cancel() { teardown(); },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        "connection": "keep-alive",
      },
    });
  });

  return app;
}

// Build the public board snapshot with a handful of grouped queries (no N+1).
async function buildBoardPayload(
  prisma: PrismaClient,
  conf: { id: number; name: string; timezone: string; spotlightSubmissionId: number | null },
): Promise<BoardPayloadOut> {
  const confId = conf.id;
  const [slots, rooms, tracks, placements, unconfCounts, spotlight] = await Promise.all([
    prisma.agendaSlot.findMany({
      where: { conferenceId: confId },
      orderBy: { startsAt: "asc" },
      select: { id: true, type: true, title: true, startsAt: true, endsAt: true },
    }),
    prisma.room.findMany({
      where: { conferenceId: confId },
      orderBy: { id: "asc" },
      select: { id: true, name: true, capacity: true },
    }),
    // Planned tracks — one entry per (slot, room). Title + submitter name come
    // from the linked submission; star count from its stars.
    prisma.trackAssignment.findMany({
      where: { slot: { conferenceId: confId } },
      select: {
        slotId: true, roomId: true, submissionId: true, mandatory: true,
        submission: {
          select: {
            title: true,
            ...PRESENTER_SELECT,
            _count: { select: { stars: true } },
          },
        },
      },
    }),
    // Unconference placements — one entry per (slot, room).
    prisma.unconferencePlacement.findMany({
      where: { slot: { conferenceId: confId } },
      select: {
        slotId: true, roomId: true, submissionId: true,
        submission: {
          select: {
            title: true,
            ...PRESENTER_SELECT,
            _count: { select: { stars: true } },
          },
        },
      },
    }),
    // Seat counts for unconference placements.
    prisma.userAssignment.groupBy({
      by: ["slotId", "submissionId"],
      where: { slot: { conferenceId: confId, type: "unconference" }, submissionId: { not: null } },
      _count: { userId: true },
    }),
    // Spotlight card — only when still published (the board is public, so a
    // session unpublished after being spotlighted must not surface).
    conf.spotlightSubmissionId === null
      ? Promise.resolve(null)
      : prisma.submission.findFirst({
          where: { id: conf.spotlightSubmissionId, conferenceId: confId, status: "published" },
          select: {
            id: true, title: true,
            ...PRESENTER_SELECT,
            _count: { select: { stars: true } },
          },
        }),
  ]);

  const seatCount = new Map(
    unconfCounts.map((u) => [`${u.slotId}:${u.submissionId}`, u._count.userId]),
  );
  const entries: BoardEntryOut[] = [
    ...tracks.map((t) => ({
      slot_id: t.slotId,
      room_id: t.roomId,
      submission_id: t.submissionId,
      title: t.submission.title,
      star_count: t.submission._count.stars,
      submitter_name: presenterLine(t.submission),
      attendee_count: 0,
      planned: true,
      mandatory: t.mandatory,
    })),
    ...placements.map((p) => ({
      slot_id: p.slotId,
      room_id: p.roomId,
      submission_id: p.submissionId,
      title: p.submission.title,
      star_count: p.submission._count.stars,
      submitter_name: presenterLine(p.submission),
      attendee_count: seatCount.get(`${p.slotId}:${p.submissionId}`) ?? 0,
      planned: false,
      mandatory: false,
    })),
  ];

  const spotlightOut: BoardSpotlightOut | null = spotlight
    ? {
        submission_id: spotlight.id,
        title: spotlight.title,
        star_count: spotlight._count.stars,
        submitter_name: presenterLine(spotlight),
      }
    : null;

  return {
    name: conf.name,
    timezone: conf.timezone,
    spotlight: spotlightOut,
    slots: slots.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      starts_at: s.startsAt.getTime(),
      ends_at: s.endsAt.getTime(),
    })),
    rooms: rooms.map((r) => ({ id: r.id, name: r.name, capacity: r.capacity })),
    entries,
  };
}
