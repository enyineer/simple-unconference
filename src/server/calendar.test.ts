import { describe, test, expect } from "bun:test";
import { buildICalendar } from "./calendar";

// Reference values for deterministic UTC formatting.
const STAMP = Date.UTC(2026, 4, 20, 12, 0, 0); // 2026-05-20T12:00:00Z
const STAMP_STR = "20260520T120000Z";

describe("buildICalendar — envelope", () => {
  test("emits required VCALENDAR headers and is wrapped in BEGIN/END", () => {
    const out = buildICalendar({ name: "x", events: [], dtStampMs: STAMP });
    expect(out.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(out.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(out).toContain("VERSION:2.0\r\n");
    expect(out).toContain("CALSCALE:GREGORIAN\r\n");
    expect(out).toContain("METHOD:PUBLISH\r\n");
    expect(out).toContain("PRODID:-//simple-unconference//");
  });

  test("uses CRLF line endings throughout (RFC 5545)", () => {
    const out = buildICalendar({
      name: "x",
      events: [{ uid: "a@x", startMs: STAMP, endMs: STAMP + 3600_000, summary: "Hi" }],
      dtStampMs: STAMP,
    });
    // Every newline must be \r\n.
    const lines = out.split("\r\n");
    expect(lines.length).toBeGreaterThan(5);
    // No lone \n outside CRLF pairs.
    const reassembled = lines.join("\r\n");
    expect(reassembled).toBe(out);
    expect(out).not.toMatch(/[^\r]\n/);
  });

  test("emits X-WR-CALNAME with the supplied calendar name", () => {
    const out = buildICalendar({
      name: "My schedule", events: [], dtStampMs: STAMP,
    });
    expect(out).toContain("X-WR-CALNAME:My schedule");
  });
});

describe("buildICalendar — events", () => {
  test("renders a minimal VEVENT with UID, DTSTAMP, DTSTART, DTEND, SUMMARY", () => {
    const out = buildICalendar({
      name: "x",
      dtStampMs: STAMP,
      events: [{
        uid: "evt-1@simple-unconference",
        startMs: STAMP,
        endMs: STAMP + 3600_000,
        summary: "Welcome keynote",
      }],
    });
    expect(out).toContain("BEGIN:VEVENT\r\n");
    expect(out).toContain("END:VEVENT\r\n");
    expect(out).toContain("UID:evt-1@simple-unconference\r\n");
    expect(out).toContain(`DTSTAMP:${STAMP_STR}\r\n`);
    expect(out).toContain(`DTSTART:${STAMP_STR}\r\n`);
    expect(out).toContain("DTEND:20260520T130000Z\r\n");
    expect(out).toContain("SUMMARY:Welcome keynote\r\n");
  });

  test("includes LOCATION + DESCRIPTION when present, skips them when empty/undefined", () => {
    const withExtras = buildICalendar({
      name: "x", dtStampMs: STAMP,
      events: [{
        uid: "u@x", startMs: STAMP, endMs: STAMP + 1, summary: "S",
        location: "Room A", description: "Bring laptop",
      }],
    });
    expect(withExtras).toContain("LOCATION:Room A\r\n");
    expect(withExtras).toContain("DESCRIPTION:Bring laptop\r\n");

    const minimal = buildICalendar({
      name: "x", dtStampMs: STAMP,
      events: [{ uid: "u@x", startMs: STAMP, endMs: STAMP + 1, summary: "S" }],
    });
    expect(minimal).not.toContain("LOCATION:");
    expect(minimal).not.toContain("DESCRIPTION:");

    const emptyStrings = buildICalendar({
      name: "x", dtStampMs: STAMP,
      events: [{
        uid: "u@x", startMs: STAMP, endMs: STAMP + 1, summary: "S",
        location: "", description: "",
      }],
    });
    expect(emptyStrings).not.toContain("LOCATION:");
    expect(emptyStrings).not.toContain("DESCRIPTION:");
  });

  test("escapes backslash, comma, semicolon and newlines in text fields", () => {
    const out = buildICalendar({
      name: "x", dtStampMs: STAMP,
      events: [{
        uid: "u@x", startMs: STAMP, endMs: STAMP + 1,
        summary: "Hi; there, friend\\foe",
        description: "First line\nSecond line",
      }],
    });
    expect(out).toContain("SUMMARY:Hi\\; there\\, friend\\\\foe");
    expect(out).toContain("DESCRIPTION:First line\\nSecond line");
  });

  test("sorts events by start time, ties broken by UID", () => {
    const out = buildICalendar({
      name: "x", dtStampMs: STAMP,
      events: [
        { uid: "z@x", startMs: STAMP + 7200_000, endMs: STAMP + 10_800_000, summary: "later" },
        { uid: "b@x", startMs: STAMP, endMs: STAMP + 3600_000, summary: "earlier-b" },
        { uid: "a@x", startMs: STAMP, endMs: STAMP + 3600_000, summary: "earlier-a" },
      ],
    });
    const uids = [...out.matchAll(/UID:([^\r]+)\r\n/g)].map((m) => m[1]);
    expect(uids).toEqual(["a@x", "b@x", "z@x"]);
  });

  test("formats DTSTART/DTEND as UTC `YYYYMMDDTHHMMSSZ`", () => {
    const out = buildICalendar({
      name: "x", dtStampMs: STAMP,
      events: [{
        uid: "u@x",
        startMs: Date.UTC(2026, 11, 31, 23, 59, 5), // 2026-12-31T23:59:05Z
        endMs:   Date.UTC(2027, 0, 1, 0, 30, 0),    // 2027-01-01T00:30:00Z
        summary: "NYE",
      }],
    });
    expect(out).toContain("DTSTART:20261231T235905Z\r\n");
    expect(out).toContain("DTEND:20270101T003000Z\r\n");
  });

  test("emits empty calendar gracefully (no VEVENT blocks)", () => {
    const out = buildICalendar({ name: "Empty", events: [], dtStampMs: STAMP });
    expect(out).not.toContain("BEGIN:VEVENT");
    expect(out).toContain("BEGIN:VCALENDAR");
    expect(out).toContain("END:VCALENDAR");
  });
});

describe("buildICalendar — line folding (RFC 5545 §3.1)", () => {
  test("folds lines longer than 75 octets with CRLF + space", () => {
    const longSummary = "x".repeat(200); // → "SUMMARY:" + 200 x's = 208 chars
    const out = buildICalendar({
      name: "x", dtStampMs: STAMP,
      events: [{ uid: "u@x", startMs: STAMP, endMs: STAMP + 1, summary: longSummary }],
    });
    // The continuation marker is `\r\n ` (CRLF + single space).
    expect(out).toContain("\r\n ");
    // No physical line exceeds 75 chars.
    for (const line of out.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(75);
    }
  });

  test("short lines pass through unfolded", () => {
    const out = buildICalendar({
      name: "x", dtStampMs: STAMP,
      events: [{ uid: "u@x", startMs: STAMP, endMs: STAMP + 1, summary: "Short" }],
    });
    expect(out).toContain("SUMMARY:Short\r\n");
  });
});

describe("buildICalendar — determinism", () => {
  test("same input → byte-identical output", () => {
    const inp = {
      name: "x", dtStampMs: STAMP,
      events: [
        { uid: "a@x", startMs: STAMP, endMs: STAMP + 3600_000, summary: "A" },
        { uid: "b@x", startMs: STAMP + 7200_000, endMs: STAMP + 10_800_000, summary: "B" },
      ],
    };
    expect(buildICalendar(inp)).toBe(buildICalendar(inp));
  });
});
