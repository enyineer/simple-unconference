// Shared client-side helpers for the room-constraints feature (dedication +
// availability). Pure functions + structured-error decoders, importable from
// any tab. Keep the availability rule (full containment inside a single
// window) in ONE place so the RoomsTab editor, the slot-side pickers, and the
// server stay in agreement.

import type {
  AvailabilityStrandsUsageErrorData,
  RoomsInUseErrorData,
} from "../../shared/contract";
import { ApiError } from "../api";
import { fmtDayShort, fmtTimeShort } from "./helpers";
import type { Room, Slot } from "./types";

export interface AvailabilityWindow {
  starts_at: number;
  ends_at: number;
}

/**
 * True when the interval `[startsAt, endsAt)` can run in a room with these
 * availability windows. No windows = always available (the hard default). With
 * windows, the interval must fit FULLY inside a single window — the same rule
 * the server enforces (`roomAvailableFor`).
 */
export function roomAvailableForWindow(
  windows: AvailabilityWindow[],
  startsAt: number,
  endsAt: number,
): boolean {
  if (windows.length === 0) return true;
  return windows.some((w) => w.starts_at <= startsAt && w.ends_at >= endsAt);
}

/** "Sat 23 May 09:00-12:00" — one window, in the conference timezone. */
export function formatWindow(w: AvailabilityWindow, timeZone: string): string {
  return `${fmtDayShort(w.starts_at, timeZone)} ${fmtTimeShort(w.starts_at, timeZone)}-${fmtTimeShort(w.ends_at, timeZone)}`;
}

/** Comma-joined window list for tooltips / captions. */
export function formatWindows(
  windows: AvailabilityWindow[],
  timeZone: string,
): string {
  return windows.map((w) => formatWindow(w, timeZone)).join(", ");
}

/**
 * Why a slot-side room picker should dim/disable a room for THIS slot, or null
 * when the room is usable. Expert-dedicated rooms are never usable for a slot;
 * a room with availability windows is unusable when the slot's time doesn't fit
 * inside one. Returns the short hint to show as a `title`/suffix.
 */
export function slotRoomBlockReason(
  room: Pick<Room, "expert_dedicated" | "availability">,
  slot: Pick<Slot, "starts_at" | "ends_at">,
): string | null {
  if (room.expert_dedicated) return "Reserved for expert bookings";
  if (!roomAvailableForWindow(room.availability, slot.starts_at, slot.ends_at)) {
    return "Not available at this slot's time";
  }
  return null;
}

function offenderKindLabel(
  kind: "planned" | "unconference" | "expert_booking",
): string {
  switch (kind) {
    case "planned":
      return "a planned talk";
    case "unconference":
      return "a session";
    case "expert_booking":
      return "an expert booking";
  }
}

/**
 * Decodes the `rooms_in_use` BAD_REQUEST the server throws when a pool / expert
 * room-list write targets rooms that already carry agenda usage. Returns a
 * readable message, or null for any other error (so callers can chain).
 */
export function roomsInUseMessage(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.message !== "rooms_in_use") return null;
  // Structured payload is opaque `unknown` off the wire — same decode pattern
  // as quotaErrors.ts.
  const data = e.data as RoomsInUseErrorData | undefined;
  const rooms = data?.rooms ?? [];
  if (rooms.length === 0) {
    return "Some rooms already have agenda usage and can't be reserved for experts. Clear their assignments first.";
  }
  const first = rooms[0]!;
  const usage =
    first.usage.kind === "planned" ? "a planned talk" : "an unconference session";
  const more = rooms.length > 1 ? ` and ${rooms.length - 1} more` : "";
  return `${first.name} is used by the agenda (${usage}: "${first.usage.title}")${more}. Clear its assignments before reserving it for experts.`;
}

/**
 * Decodes the `availability_strands_usage` BAD_REQUEST the server throws when a
 * room availability edit would leave existing usage (a track / placement /
 * booking) outside the new windows. Returns a readable message naming the first
 * offender, or null for any other error.
 */
export function availabilityStrandsMessage(
  e: unknown,
  timeZone: string,
): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.message !== "availability_strands_usage") return null;
  const data = e.data as AvailabilityStrandsUsageErrorData | undefined;
  const offenders = data?.offenders ?? [];
  if (offenders.length === 0) {
    return "Can't shrink availability - existing agenda usage would fall outside the new windows.";
  }
  const first = offenders[0]!;
  const label = first.title ? `"${first.title}"` : offenderKindLabel(first.kind);
  const when = formatWindow(
    { starts_at: first.starts_at, ends_at: first.ends_at },
    timeZone,
  );
  const more = offenders.length > 1 ? ` and ${offenders.length - 1} more` : "";
  return `Can't shrink availability - ${label} (${when})${more} would fall outside the new windows.`;
}
