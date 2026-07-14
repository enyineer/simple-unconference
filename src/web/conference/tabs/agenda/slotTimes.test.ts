import { describe, expect, test } from "bun:test";
import { LONG_SLOT_MS, formatDuration, slotTimesValid } from "./slotTimes";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe("slotTimesValid", () => {
  test("end after start is valid", () => {
    expect(slotTimesValid(1000, 2000)).toBe(true);
  });

  test("end equal to start is invalid", () => {
    expect(slotTimesValid(1000, 1000)).toBe(false);
  });

  test("end before start is invalid", () => {
    expect(slotTimesValid(2000, 1000)).toBe(false);
  });
});

describe("formatDuration", () => {
  test("minutes only", () => {
    expect(formatDuration(45 * MINUTE)).toBe("45 min");
  });

  test("whole hours", () => {
    expect(formatDuration(2 * HOUR)).toBe("2 h");
  });

  test("hours and minutes", () => {
    expect(formatDuration(HOUR + 30 * MINUTE)).toBe("1 h 30 min");
  });

  test("rounds sub-minute remainders", () => {
    expect(formatDuration(HOUR + 29 * MINUTE + 40 * 1000)).toBe("1 h 30 min");
  });

  test("day-spanning durations stay in hours", () => {
    expect(formatDuration(26 * HOUR)).toBe("26 h");
  });
});

describe("LONG_SLOT_MS threshold", () => {
  test("is four hours", () => {
    expect(LONG_SLOT_MS).toBe(4 * HOUR);
  });
});
