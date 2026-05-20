// Pure helpers for the expert-booking feature.
//
// Slot derivation is deterministic: a timeframe yields back-to-back slots of
// `slotDurationMinutes` until the next slot would extend past `endsAt`.
//
// Room allocation at booking time:
//   1. Resolve the expert's candidate room ids (from pool or explicit set).
//   2. Filter out rooms that already have a booking overlapping the desired
//      window (any expert, same conference — rooms are not multi-tenant).
//   3. Pick the first remaining candidate (lowest room id) for determinism.

export interface SlotWindow {
  startsAt: number; // epoch ms, inclusive
  endsAt: number;   // epoch ms, exclusive
}

export function deriveSlots(
  startsAt: Date | number,
  endsAt: Date | number,
  slotDurationMinutes: number,
): SlotWindow[] {
  const start = typeof startsAt === "number" ? startsAt : startsAt.getTime();
  const end = typeof endsAt === "number" ? endsAt : endsAt.getTime();
  const stepMs = slotDurationMinutes * 60_000;
  if (stepMs <= 0 || end <= start) return [];
  const out: SlotWindow[] = [];
  for (let t = start; t + stepMs <= end; t += stepMs) {
    out.push({ startsAt: t, endsAt: t + stepMs });
  }
  return out;
}

export function overlaps(a: SlotWindow, b: SlotWindow): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/**
 * From a set of candidate room ids and a set of bookings that the candidate
 * rooms might already hold, return the first (lowest-id) room that has no
 * overlap with `window`. Returns null when every candidate is busy.
 */
export function pickAvailableRoom(
  candidateRoomIds: number[],
  existingBookings: Array<{ roomId: number; startsAt: number; endsAt: number }>,
  window: SlotWindow,
): number | null {
  const busy = new Set<number>();
  for (const b of existingBookings) {
    if (overlaps({ startsAt: b.startsAt, endsAt: b.endsAt }, window)) {
      busy.add(b.roomId);
    }
  }
  const sorted = [...new Set(candidateRoomIds)].sort((a, b) => a - b);
  for (const id of sorted) if (!busy.has(id)) return id;
  return null;
}
