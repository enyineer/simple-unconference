// iCalendar (RFC 5545) feed for per-user schedule subscription.
//
// We emit a single VCALENDAR document covering every event the user is on
// across every conference they belong to. Calendar apps (Apple Calendar,
// Google Calendar, Outlook, Thunderbird, Fantastical, …) subscribe to a URL
// and poll it themselves — no server push required.
//
// Times are emitted in UTC (suffix `Z`) so we don't have to embed VTIMEZONE
// blocks; calendar clients render them in the viewer's local zone anyway.

export interface ICalEvent {
  /** Stable, globally-unique id. Must not change across feed rebuilds. */
  uid: string;
  /** UTC milliseconds. */
  startMs: number;
  endMs: number;
  /** Plain text — escaping is handled by the builder. */
  summary: string;
  location?: string;
  description?: string;
}

export interface ICalCalendar {
  /** Shown to the user when subscribing. */
  name: string;
  /** Used for generating PRODID — typically the deployment host. */
  prodId?: string;
  events: ICalEvent[];
  /**
   * Used as the DTSTAMP on every event (the "last modified" time of this
   * calendar generation). Pass a stable value (e.g. `Date.now()`) per request.
   */
  dtStampMs: number;
}

// ----- text helpers --------------------------------------------------------

// Per RFC 5545 §3.3.11: SUMMARY/LOCATION/DESCRIPTION text must escape
// backslash, comma, semicolon, and newline. We *don't* escape colon — only
// the four required characters — so URLs in DESCRIPTION stay readable.
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Per RFC 5545 §3.1: content lines longer than 75 octets MUST be folded by
// inserting CRLF followed by a single space at the wrap point. Strict
// validators (e.g. iCalendar Validator, some older Outlook versions) reject
// unfolded long lines, so we do this consistently.
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const slice = line.slice(i, i + (i === 0 ? 75 : 74));
    out.push(i === 0 ? slice : " " + slice);
    i += i === 0 ? 75 : 74;
  }
  return out.join("\r\n");
}

// Format a JS millisecond timestamp as a UTC datetime per RFC 5545:
// `YYYYMMDDTHHMMSSZ`.
function fmtUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

// ----- public API ----------------------------------------------------------

export function buildICalendar(cal: ICalCalendar): string {
  const prodId = cal.prodId ?? "simple-unconference";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${prodId}//simple-unconference//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(cal.name)}`,
    "X-WR-TIMEZONE:UTC",
  ];

  // Sort events by start time so the feed has a stable, scannable order.
  const events = [...cal.events].sort((a, b) => a.startMs - b.startMs || a.uid.localeCompare(b.uid));

  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${fmtUtc(cal.dtStampMs)}`);
    lines.push(`DTSTART:${fmtUtc(ev.startMs)}`);
    lines.push(`DTEND:${fmtUtc(ev.endMs)}`);
    lines.push(`SUMMARY:${escapeText(ev.summary)}`);
    if (ev.location !== undefined && ev.location !== "") {
      lines.push(`LOCATION:${escapeText(ev.location)}`);
    }
    if (ev.description !== undefined && ev.description !== "") {
      lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  // Fold long lines, then join with CRLF (RFC 5545 line ending).
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
