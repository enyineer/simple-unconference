import { formatInTz, instantToWallClock, wallClockToInstant } from "../../../../shared/tz";
import { SNAP_MIN } from "./constants";

// ----- time helpers --------------------------------------------------------

// `startOfDay` / `endOfDay` operate **in the conference timezone**, not the
// viewer's local. Two slots scheduled "the same conference day" might span
// different UTC days from another locale, so we resolve via the wall clock.
export function startOfDay(ms: number, timeZone: string): number {
  const wall = instantToWallClock(ms, timeZone); // "YYYY-MM-DDTHH:MM"
  const datePart = wall.slice(0, 10); // YYYY-MM-DD
  // wallClockToInstant inverts back precisely: local midnight in `timeZone`
  // → the corresponding absolute ms.
  return wallClockToInstant(`${datePart}T00:00`, timeZone);
}
export function endOfDay(ms: number, timeZone: string): number {
  return startOfDay(ms, timeZone) + 24 * 60 * 60 * 1000;
}
export function snapToMinutes(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}
export function fmtTime(ms: number, timeZone: string): string {
  return formatInTz(ms, timeZone, { hour: "2-digit", minute: "2-digit" });
}
