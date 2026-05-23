import { formatInTz } from "../../../../shared/tz";

export function fmtRange(startMs: number, endMs: number, tz: string): string {
  const sameDay = formatInTz(startMs, tz, { year: "numeric", month: "2-digit", day: "2-digit" })
    === formatInTz(endMs, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  const dateLabel = formatInTz(startMs, tz, { weekday: "short", month: "short", day: "numeric" });
  const startTime = formatInTz(startMs, tz, { hour: "2-digit", minute: "2-digit" });
  const endTime = formatInTz(endMs, tz, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `${dateLabel}, ${startTime}-${endTime}`;
  const endDate = formatInTz(endMs, tz, { weekday: "short", month: "short", day: "numeric" });
  return `${dateLabel} ${startTime} – ${endDate} ${endTime}`;
}

export function fmtTime(ms: number, tz: string): string {
  return formatInTz(ms, tz, { hour: "2-digit", minute: "2-digit" });
}

export function humanError(code: string): string {
  return ({
    cannot_book_self: "You can't book yourself.",
    slot_not_found: "That slot no longer exists.",
    slot_in_past: "That slot is in the past.",
    already_booked_expert: "You already booked this expert. Cancel your existing booking first.",
    overlapping_booking: "You already have a booking that overlaps this slot.",
    no_room_available: "Every eligible room is busy at that time. Try a different slot.",
    no_rooms_configured: "This expert has no rooms set up yet.",
    pool_name_taken: "A pool with that name already exists.",
    already_expert: "That person is already an expert.",
    not_a_member: "That person is not in this conference.",
    pool_not_found: "Pool not found.",
    timeframe_too_short: "The timeframe is shorter than one slot.",
    ends_before_starts: "End time must be after start time.",
  } as Record<string, string>)[code] ?? code;
}
