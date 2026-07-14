// Pure helpers for the slot time fields, kept out of the component file so
// react-refresh works and the logic is unit-testable without JSX.

export const SLOT_TIMES_ERROR = "End time must be after start time.";

// Above this a slot is almost certainly a "whole day" mistake - a slot is one
// block on the agenda, not the full program. Warning only; long slots are
// legal and the server accepts them.
export const LONG_SLOT_MS = 4 * 60 * 60 * 1000;

export function slotTimesValid(startsAt: number, endsAt: number): boolean {
  return endsAt > startsAt;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}
