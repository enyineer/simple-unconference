// Public iCal subscription endpoint. The URL contains an opaque per-identity
// token (ConferenceIdentity.calendarToken) — the token itself is the secret,
// so this route runs without any session-cookie middleware. Anyone with the
// URL can read this identity's schedule for one conference; participants can
// revoke a calendar client by resetting the token via conferences.resetCalendar.

import { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { buildICalendar, type ICalEvent } from "../calendar";

export function calendarRoutes(prisma: PrismaClient) {
  const app = new Hono();

  // We route by `:filename` and strip the `.ics` suffix ourselves. This
  // avoids Hono path-parameter quirks around literal dots in the route
  // template, and lets us accept both `/<token>.ics` (preferred) and a
  // future bare-token variant if needed.
  app.get("/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!filename.endsWith(".ics")) return c.notFound();
    const token = filename.slice(0, -4);
    if (!/^[a-f0-9]{16,128}$/.test(token)) return c.notFound();

    const identity = await prisma.conferenceIdentity.findUnique({
      where: { calendarToken: token },
      select: {
        id: true, name: true, email: true, conferenceId: true,
        conference: { select: { id: true, name: true } },
      },
    });
    if (!identity) return c.notFound();

    const events = await buildIdentityEvents(prisma, identity.id, identity.conferenceId);

    const body = buildICalendar({
      name: `${identity.name ?? identity.email} - ${identity.conference.name}`,
      events,
      dtStampMs: Date.now(),
    });

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        // Mild caching so calendar clients (which can be eager) don't hammer
        // us on every refresh tick.
        "cache-control": "private, max-age=300",
        // Hint to browsers that download the URL directly.
        "content-disposition": `inline; filename="unconference.ics"`,
      },
    });
  });

  return app;
}

// Collects every scheduled event this identity is part of within its single
// conference (identities are conference-scoped, so the FK on userId already
// constrains the result; no separate conference filter required).
async function buildIdentityEvents(
  prisma: PrismaClient,
  identityId: number,
  conferenceId: number,
): Promise<ICalEvent[]> {
  const [userAssigns, derivedTracks, expertBookerBookings, ownExpert] = await Promise.all([
    prisma.userAssignment.findMany({
      where: { userId: identityId },
      include: {
        slot: {
          select: {
            id: true, type: true, title: true,
            startsAt: true, endsAt: true,
            conference: { select: { id: true, name: true } },
          },
        },
        submission: { select: { title: true, description: true } },
        room: { select: { id: true, name: true, description: true } },
      },
    }),
    // Path C derivation: a planned TrackAssignment lands on this identity's
    // feed when it's mandatory OR the identity has starred the linked
    // submission OR the identity IS the linked submission's submitter
    // (so submitters' speaking gigs auto-export to their calendar).
    prisma.trackAssignment.findMany({
      where: {
        slot: { conferenceId },
        OR: [
          { mandatory: true },
          { submission: { stars: { some: { userId: identityId } } } },
          { submission: { submitterId: identityId } },
        ],
      },
      include: {
        slot: {
          select: {
            id: true, title: true,
            startsAt: true, endsAt: true,
            conference: { select: { name: true } },
          },
        },
        submission: { select: { title: true, description: true } },
        room: { select: { name: true, description: true } },
      },
    }),
    // Expert bookings this identity made as the booker.
    prisma.expertBooking.findMany({
      where: { bookerId: identityId },
      include: {
        expert: { include: {
          identity: { select: { name: true, email: true } },
          conference: { select: { name: true } },
        } },
        room: { select: { name: true, description: true } },
      },
    }),
    // If this identity is themselves an expert, surface bookings against them.
    prisma.expert.findUnique({
      where: { identityId },
      include: {
        conference: { select: { name: true } },
        bookings: {
          include: {
            booker: { select: { name: true, email: true } },
            room: { select: { name: true, description: true } },
          },
        },
      },
    }),
  ]);

  const events: ICalEvent[] = [];

  for (const a of userAssigns) {
    const slot = a.slot;
    if (!slot) continue;
    const confName = slot.conference.name;
    const roomName = a.room?.name;
    const title = a.submission?.title
      ?? (slot.type === "mixer" ? (slot.title ?? "Mixer") : "Unconference");
    const kindLabel = slot.type === "mixer" ? "Mixer" : "Unconference";
    events.push({
      uid: `${slot.type}-${slot.id}-${identityId}@simple-unconference`,
      startMs: slot.startsAt.getTime(),
      endMs: slot.endsAt.getTime(),
      summary: roomName ? `${title} (${roomName})` : title,
      location: roomName ? `${roomName} - ${confName}` : confName,
      description: [
        `${kindLabel} session at ${confName}.`,
        a.submission?.description ?? "",
        a.room?.description ?? "",
      ].filter(Boolean).join("\n\n"),
    });
  }

  for (const b of expertBookerBookings) {
    const confName = b.expert.conference.name;
    const expertName = b.expert.identity.name ?? b.expert.identity.email;
    const roomName = b.room?.name;
    events.push({
      uid: `expert-booking-${b.id}-booker@simple-unconference`,
      startMs: b.startsAt.getTime(),
      endMs: b.endsAt.getTime(),
      summary: `Expert: ${expertName}${roomName ? ` (${roomName})` : ""}`,
      location: roomName ? `${roomName} - ${confName}` : confName,
      description: [
        `Expert booking at ${confName}.`,
        `Expert: ${expertName}`,
        b.room?.description ?? "",
      ].filter(Boolean).join("\n\n"),
    });
  }

  if (ownExpert) {
    const confName = ownExpert.conference.name;
    for (const b of ownExpert.bookings) {
      const bookerName = b.booker.name ?? b.booker.email;
      const roomName = b.room?.name;
      events.push({
        uid: `expert-booking-${b.id}-expert@simple-unconference`,
        startMs: b.startsAt.getTime(),
        endMs: b.endsAt.getTime(),
        summary: `Booked by ${bookerName}${roomName ? ` (${roomName})` : ""}`,
        location: roomName ? `${roomName} - ${confName}` : confName,
        description: [
          `Expert booking at ${confName}.`,
          `Booked by: ${bookerName}`,
          b.room?.description ?? "",
        ].filter(Boolean).join("\n\n"),
      });
    }
  }

  for (const t of derivedTracks) {
    const slot = t.slot;
    const title = t.submission.title ?? slot.title ?? "Session";
    const roomName = t.room?.name;
    const confName = slot.conference.name;
    events.push({
      // Key the UID on the STABLE (slot, submission, identity) triple, not on
      // the TrackAssignment.id — planned-track ids are recreated (and thus
      // change) by `agenda.refitRooms`, and a UID that shifted on every refit
      // would make calendar clients drop + re-add the event instead of
      // updating it in place. (slot, submission) uniquely identifies a planned
      // track: at most one track per submission per slot on a subscriber's feed.
      uid: `static-${t.slotId}-${t.submissionId}-${identityId}@simple-unconference`,
      startMs: slot.startsAt.getTime(),
      endMs: slot.endsAt.getTime(),
      summary: roomName ? `${title} (${roomName})` : title,
      location: roomName ? `${roomName} - ${confName}` : confName,
      description: [
        `Planned session at ${confName}.`,
        t.speakers ? `Speakers: ${t.speakers}` : "",
        t.submission?.description ?? "",
        t.room?.description ?? "",
      ].filter(Boolean).join("\n\n"),
    });
  }

  return events;
}
