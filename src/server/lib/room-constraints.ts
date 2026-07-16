// Room constraint helpers: expert-dedicated rooms and availability windows.
//
// Two orthogonal constraints gate whether a room may host a slot assignment or
// an expert booking:
//
//   1. Expert dedication. A room reserved for 1:1 expert conversations is
//      "dedicated" and must be excluded from EVERY slot-assignment path. A room
//      is dedicated when it is a member of any ExpertRoomPool (via
//      ExpertRoomPoolRoom) OR appears in any per-expert ExpertRoom row for the
//      conference. Dedication and slot usage are mutually exclusive: a room with
//      slot usage can't be made dedicated, and a dedicated room is never handed
//      to a slot assignment.
//
//   2. Availability windows. A room may declare zero or more availability
//      windows (RoomAvailability rows). **No rows = always available** (the hard
//      default). With windows, an interval is usable only when it lies fully
//      inside a single window.
//
// Every room-consuming path (agenda assignment, planned scheduling, unconference
// placement, refit, expert booking) must consult `expertDedicatedRoomIds` +
// `unavailableRoomIds` (or `roomAvailableFor` for a single interval).

import type { Prisma } from "@prisma/client";

// Accepts both the top-level client and an interactive-transaction client
// (a full PrismaClient is assignable to TransactionClient), so callers inside a
// `$transaction` can pass `tx` without a cast. Only model delegates are used.
type Db = Prisma.TransactionClient;

/** One planned track or unconference placement occupying a room, with enough
 *  detail to name the clash in a user-facing message. */
export interface RoomSlotUsage {
  kind: "planned" | "unconference";
  title: string;
  slot_starts_at: number;
}

/** A room that can't be made expert-dedicated because it already has slot
 *  usage. `usage` is the earliest occupying track/placement (first example). */
export interface RoomInUseOffender {
  id: number;
  name: string;
  usage: RoomSlotUsage;
}

/** A usage window that would be stranded by a proposed availability edit. */
export interface AvailabilityStrandOffender {
  kind: "planned" | "unconference" | "expert_booking";
  title: string | null;
  starts_at: number;
  ends_at: number;
}

// Union of every room id reserved for experts in this conference: pool members
// (any pool) ∪ per-expert room rows.
export async function expertDedicatedRoomIds(
  prisma: Db,
  conferenceId: number,
): Promise<Set<number>> {
  const [poolRooms, expertRooms] = await Promise.all([
    prisma.expertRoomPoolRoom.findMany({
      where: { pool: { conferenceId } },
      select: { roomId: true },
    }),
    prisma.expertRoom.findMany({
      where: { expert: { conferenceId } },
      select: { roomId: true },
    }),
  ]);
  const out = new Set<number>();
  for (const r of poolRooms) out.add(r.roomId);
  for (const r of expertRooms) out.add(r.roomId);
  return out;
}

// Why a specific room is expert-dedicated, for a conflict message. Returns the
// owning pool name, or `{ poolName: null }` for a per-expert room list, or null
// when the room isn't dedicated at all. Pool membership takes precedence.
export async function expertDedicationOf(
  prisma: Db,
  conferenceId: number,
  roomId: number,
): Promise<{ poolName: string | null } | null> {
  const poolRoom = await prisma.expertRoomPoolRoom.findFirst({
    where: { roomId, pool: { conferenceId } },
    select: { pool: { select: { name: true } } },
  });
  if (poolRoom) return { poolName: poolRoom.pool.name };
  const expertRoom = await prisma.expertRoom.findFirst({
    where: { roomId, expert: { conferenceId } },
    select: { roomId: true },
  });
  if (expertRoom) return { poolName: null };
  return null;
}

// True when `[start, end)` is usable given `windows`. No windows = always
// available; otherwise the interval must lie fully inside a single window.
export function roomAvailableFor(
  windows: { startsAt: Date; endsAt: Date }[],
  start: Date,
  end: Date,
): boolean {
  return (
    windows.length === 0 ||
    windows.some((w) => w.startsAt <= start && end <= w.endsAt)
  );
}

// Subset of `roomIds` that are NOT available for `[start, end)` given their
// availability windows. Rooms with no windows are always available and never
// appear in the result.
export async function unavailableRoomIds(
  prisma: Db,
  roomIds: Iterable<number>,
  start: Date,
  end: Date,
): Promise<Set<number>> {
  const ids = [...new Set(roomIds)];
  if (ids.length === 0) return new Set();
  const rows = await prisma.roomAvailability.findMany({
    where: { roomId: { in: ids } },
    select: { roomId: true, startsAt: true, endsAt: true },
  });
  const byRoom = new Map<number, { startsAt: Date; endsAt: Date }[]>();
  for (const r of rows) {
    const arr = byRoom.get(r.roomId) ?? [];
    arr.push({ startsAt: r.startsAt, endsAt: r.endsAt });
    byRoom.set(r.roomId, arr);
  }
  const out = new Set<number>();
  for (const id of ids) {
    if (!roomAvailableFor(byRoom.get(id) ?? [], start, end)) out.add(id);
  }
  return out;
}

// A room's availability windows as epoch-ms pairs, ascending. Used to build the
// `room_unavailable` conflict payload.
export async function roomAvailabilityWindows(
  prisma: Db,
  roomId: number,
): Promise<{ starts_at: number; ends_at: number }[]> {
  const rows = await prisma.roomAvailability.findMany({
    where: { roomId },
    orderBy: { startsAt: "asc" },
    select: { startsAt: true, endsAt: true },
  });
  return rows.map((r) => ({
    starts_at: r.startsAt.getTime(),
    ends_at: r.endsAt.getTime(),
  }));
}

// Rooms in this conference that already carry any slot usage (a planned track or
// an unconference placement). Used to render the `slot_used` RoomOut flag.
export async function slotUsedRoomIds(
  prisma: Db,
  conferenceId: number,
): Promise<Set<number>> {
  const [tracks, placements] = await Promise.all([
    prisma.trackAssignment.findMany({
      where: { slot: { conferenceId } },
      select: { roomId: true },
      distinct: ["roomId"],
    }),
    prisma.unconferencePlacement.findMany({
      where: { slot: { conferenceId } },
      select: { roomId: true },
      distinct: ["roomId"],
    }),
  ]);
  const out = new Set<number>();
  for (const t of tracks) out.add(t.roomId);
  for (const p of placements) out.add(p.roomId);
  return out;
}

// Per-room slot usage (planned tracks + unconference placements) for the given
// rooms, keyed by room id. Only rooms with at least one usage appear. `count`
// is the total; `example` is the earliest occupying track/placement — enough to
// name the clash in a `rooms_in_use` message.
export async function slotUsageOfRooms(
  prisma: Db,
  conferenceId: number,
  roomIds: Iterable<number>,
): Promise<Map<number, { count: number; example: RoomSlotUsage }>> {
  const ids = [...new Set(roomIds)];
  const out = new Map<number, { count: number; example: RoomSlotUsage }>();
  if (ids.length === 0) return out;
  const [tracks, placements] = await Promise.all([
    prisma.trackAssignment.findMany({
      where: { roomId: { in: ids }, slot: { conferenceId } },
      select: {
        roomId: true,
        submission: { select: { title: true } },
        slot: { select: { startsAt: true } },
      },
    }),
    prisma.unconferencePlacement.findMany({
      where: { roomId: { in: ids }, slot: { conferenceId } },
      select: {
        roomId: true,
        submission: { select: { title: true } },
        slot: { select: { startsAt: true } },
      },
    }),
  ]);
  const push = (roomId: number, usage: RoomSlotUsage) => {
    const cur = out.get(roomId);
    if (!cur) {
      out.set(roomId, { count: 1, example: usage });
      return;
    }
    cur.count += 1;
    // Keep the earliest-starting occupant as the example.
    if (usage.slot_starts_at < cur.example.slot_starts_at) cur.example = usage;
  };
  for (const t of tracks) {
    push(t.roomId, {
      kind: "planned",
      title: t.submission.title,
      slot_starts_at: t.slot.startsAt.getTime(),
    });
  }
  for (const p of placements) {
    push(p.roomId, {
      kind: "unconference",
      title: p.submission.title,
      slot_starts_at: p.slot.startsAt.getTime(),
    });
  }
  return out;
}

// Offenders that block making `roomIds` expert-dedicated: any room with slot
// usage, carrying its name + earliest usage. Empty = safe to dedicate.
export async function roomsInUseForDedication(
  prisma: Db,
  conferenceId: number,
  roomIds: Iterable<number>,
): Promise<RoomInUseOffender[]> {
  const ids = [...new Set(roomIds)];
  if (ids.length === 0) return [];
  const usage = await slotUsageOfRooms(prisma, conferenceId, ids);
  if (usage.size === 0) return [];
  const rooms = await prisma.room.findMany({
    where: { id: { in: [...usage.keys()] }, conferenceId },
    select: { id: true, name: true },
  });
  const nameById = new Map(rooms.map((r) => [r.id, r.name]));
  return [...usage.entries()]
    .map(([id, u]) => ({
      id,
      name: nameById.get(id) ?? "(unknown room)",
      usage: u.example,
    }))
    .sort((a, b) => a.id - b.id);
}

// Existing usages of `roomId` that a proposed set of availability windows would
// strand (i.e. their interval no longer lies fully inside a single window).
// Considers planned tracks + unconference placements (by slot window) and
// expert bookings (by booking window). Empty = the edit strands nothing.
export async function availabilityStranding(
  prisma: Db,
  conferenceId: number,
  roomId: number,
  newWindows: { startsAt: Date; endsAt: Date }[],
): Promise<AvailabilityStrandOffender[]> {
  // Clearing to always-available never strands anything.
  if (newWindows.length === 0) return [];
  const [tracks, placements, bookings] = await Promise.all([
    prisma.trackAssignment.findMany({
      where: { roomId, slot: { conferenceId } },
      select: {
        submission: { select: { title: true } },
        slot: { select: { startsAt: true, endsAt: true } },
      },
      orderBy: { slot: { startsAt: "asc" } },
    }),
    prisma.unconferencePlacement.findMany({
      where: { roomId, slot: { conferenceId } },
      select: {
        submission: { select: { title: true } },
        slot: { select: { startsAt: true, endsAt: true } },
      },
      orderBy: { slot: { startsAt: "asc" } },
    }),
    prisma.expertBooking.findMany({
      where: { roomId, expert: { conferenceId } },
      select: {
        startsAt: true,
        endsAt: true,
        expert: { select: { identity: { select: { name: true } } } },
      },
      orderBy: { startsAt: "asc" },
    }),
  ]);
  const offenders: AvailabilityStrandOffender[] = [];
  for (const t of tracks) {
    if (!roomAvailableFor(newWindows, t.slot.startsAt, t.slot.endsAt)) {
      offenders.push({
        kind: "planned",
        title: t.submission.title,
        starts_at: t.slot.startsAt.getTime(),
        ends_at: t.slot.endsAt.getTime(),
      });
    }
  }
  for (const p of placements) {
    if (!roomAvailableFor(newWindows, p.slot.startsAt, p.slot.endsAt)) {
      offenders.push({
        kind: "unconference",
        title: p.submission.title,
        starts_at: p.slot.startsAt.getTime(),
        ends_at: p.slot.endsAt.getTime(),
      });
    }
  }
  for (const b of bookings) {
    if (!roomAvailableFor(newWindows, b.startsAt, b.endsAt)) {
      offenders.push({
        kind: "expert_booking",
        title: b.expert.identity.name,
        starts_at: b.startsAt.getTime(),
        ends_at: b.endsAt.getTime(),
      });
    }
  }
  return offenders;
}
