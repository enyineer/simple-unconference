// Timezone helpers shared by server + web.
//
// A conference picks an IANA timezone (e.g. "Europe/Berlin"). When we show
// the user "the slot starts at 14:00", that wall-clock time is *in that
// timezone*, regardless of where the viewer happens to sit. These helpers
// convert between the absolute moment (ms since epoch) and the local wall
// clock in a given zone, via the platform's Intl API.

const FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = FMT_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    FMT_CACHE.set(timeZone, f);
  }
  return f;
}

function parts(timeZone: string, instant: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  // Intl sometimes reports "24" for midnight; normalize.
  if (out.hour === "24") out.hour = "00";
  return out;
}

/**
 * Convert an absolute instant (ms since epoch) to a "datetime-local" string
 * (`YYYY-MM-DDTHH:MM`) interpreting the wall clock in the given timezone.
 */
export function instantToWallClock(ms: number, timeZone: string): string {
  const p = parts(timeZone, ms);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * Convert a "datetime-local" string (`YYYY-MM-DDTHH:MM`) interpreted in the
 * given timezone back to an absolute instant (ms since epoch).
 *
 * Algorithm: parse the string naively as UTC, then ask the IANA zone what
 * wall clock that fake-UTC instant maps to. The difference between those two
 * wall clocks is the zone's offset at the actual instant; subtracting it
 * gives the correct epoch.
 */
export function wallClockToInstant(wallClock: string, timeZone: string): number {
  // Accept "YYYY-MM-DDTHH:MM" or with seconds.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wallClock);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m;
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"));
  const p = parts(timeZone, naive);
  const reformed = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second),
  );
  const offsetMs = reformed - naive;
  return naive - offsetMs;
}

/** Format an instant in a given timezone using `Intl.DateTimeFormat`. */
export function formatInTz(
  ms: number,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" },
): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, ...options }).format(new Date(ms));
}

/** True if the timezone string is a valid IANA identifier on this runtime. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * List of IANA timezones the runtime knows about, sorted. Wraps
 * `Intl.supportedValuesOf`. Returns a short fallback list when not available
 * (older engines).
 */
export function listTimeZones(): string[] {
  // Intl.supportedValuesOf is present on Node 18+/modern browsers/Bun.
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof f === "function") {
    try { return f("timeZone").slice().sort(); } catch { /* fall through */ }
  }
  return ["UTC", "Europe/Berlin", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];
}

/** Best guess for the viewer's local timezone via Intl. */
export function detectLocalTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
