// Small pure helpers shared by the conference tabs. No React, no DOM —
// keep this importable from anywhere (tests too).

import { formatInTz } from "../../shared/tz";

/**
 * Pick the most useful identifier for a submitter:
 *   - their display name if set,
 *   - else their email (which is only non-null for moderator/owner viewers),
 *   - else null (caller decides what to render).
 */
export function submitterLabel(s: {
  submitter_name: string | null;
  submitter_email: string | null;
}): string | null {
  if (s.submitter_name && s.submitter_name.trim()) return s.submitter_name;
  if (s.submitter_email) return s.submitter_email;
  return null;
}

/**
 * The effective presenter display names for a session, in order, with any
 * blank entries dropped. This is "who presents" (defaults to the submitter
 * when no explicit speakers are set) — distinct from `submitterLabel`, which
 * is authorship. Use for plain-text presenter contexts (calendar labels,
 * select hints); use the `SpeakerList` component when you want profile links.
 */
export function speakerNames(s: { speakers: { name: string }[] }): string[] {
  return s.speakers.map((sp) => sp.name).filter((n) => n.trim().length > 0);
}

/** The effective presenters joined for a plain-text line, or null when there
 *  is no named presenter to show. */
export function speakerLabel(s: { speakers: { name: string }[] }): string | null {
  const names = speakerNames(s);
  return names.length > 0 ? names.join(", ") : null;
}

/** Format an epoch instant as "HH:MM" in the conference timezone. */
export function fmtTimeShort(ms: number, timeZone: string): string {
  return formatInTz(ms, timeZone, { hour: "2-digit", minute: "2-digit" });
}

/** Format an epoch instant as a short day label, e.g. "Sat 23 May". */
export function fmtDayShort(ms: number, timeZone: string): string {
  return formatInTz(ms, timeZone, {
    weekday: "short", day: "numeric", month: "short",
  });
}

/** Stable YYYY-MM-DD key for an instant in the given timezone. */
export function dayKeyInTz(ms: number, timeZone: string): string {
  return formatInTz(ms, timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

/** True when the given instants fall on more than one conference-local day. */
export function spansMultipleDays(times: number[], timeZone: string): boolean {
  if (times.length < 2) return false;
  let first: string | undefined;
  for (const ms of times) {
    const key = dayKeyInTz(ms, timeZone);
    if (first === undefined) first = key;
    else if (key !== first) return true;
  }
  return false;
}

/** Format an instant as "HH:MM", optionally prefixed with a short day label. */
export function fmtTimeMaybeDay(
  ms: number,
  timeZone: string,
  withDay: boolean,
): string {
  return withDay
    ? `${fmtDayShort(ms, timeZone)} ${fmtTimeShort(ms, timeZone)}`
    : fmtTimeShort(ms, timeZone);
}
