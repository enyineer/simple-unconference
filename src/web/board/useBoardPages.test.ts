// Unit tests for the projector board's pure page builder (buildBoardPages).
// Covers the legibility caps, the physical-fit floors, day-major + time-major
// ordering with no day straddling, and the degenerate inputs. The hook
// (useBoardPages) is a thin ResizeObserver wrapper around this function.

import { describe, test, expect } from "bun:test";
import { buildBoardPages, MAX_ROOMS_PER_PAGE, MAX_SLOTS_PER_PAGE } from "./useBoardPages";
import type { BoardRoomOut, BoardSlotOut } from "../../shared/contract/types";

const TZ = "UTC";

function rooms(n: number): BoardRoomOut[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Room ${i + 1}`, capacity: 30 }));
}

function slots(specs: { id: number; day: number; hour: number }[]): BoardSlotOut[] {
  // `day` 0 = 2026-10-01 UTC, `hour` = UTC hour. Sorted by start, like the payload.
  const base = Date.UTC(2026, 9, 1);
  return specs
    .map((s) => ({
      id: s.id,
      type: "unconference" as const,
      title: `Slot ${s.id}`,
      starts_at: base + s.day * 86_400_000 + s.hour * 3_600_000,
      ends_at: base + s.day * 86_400_000 + (s.hour + 1) * 3_600_000,
    }))
    .sort((a, b) => a.starts_at - b.starts_at);
}

describe("buildBoardPages", () => {
  test("caps bind on a huge wall: 9 rooms x 8 slots become 6-capped pages", () => {
    const rs = rooms(9);
    const ss = slots(Array.from({ length: 8 }, (_, i) => ({ id: i + 1, day: 0, hour: 9 + i })));
    const pages = buildBoardPages(rs, ss, TZ, { w: 4000, h: 2200 });

    expect(MAX_ROOMS_PER_PAGE).toBe(6);
    expect(MAX_SLOTS_PER_PAGE).toBe(6);
    // 2 slot pages (6 + 2) x 2 room pages (6 + 3) = 4, time-major then room.
    expect(pages).toHaveLength(4);
    expect(pages[0]!.roomSlice).toHaveLength(6);
    expect(pages[0]!.slotSlice).toHaveLength(6);
    expect(pages[1]!.roomSlice).toHaveLength(3);
    expect(pages[1]!.slotSlice).toHaveLength(6);
    expect(pages[2]!.roomSlice).toHaveLength(6);
    expect(pages[3]!.roomSlice).toHaveLength(3);
  });

  test("pages are time-major: start times never go backwards across pages", () => {
    const rs = rooms(7);
    const ss = slots(Array.from({ length: 8 }, (_, i) => ({ id: i + 1, day: 0, hour: 9 + i })));
    const pages = buildBoardPages(rs, ss, TZ, { w: 4000, h: 2200 });
    expect(pages.length).toBeGreaterThan(2);
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i]!.rangeStart).toBeGreaterThanOrEqual(pages[i - 1]!.rangeStart);
    }
    // First pass covers the early slots across ALL room groups before any
    // later slot group appears.
    expect(pages[0]!.slotSlice[0]!.id).toBe(pages[1]!.slotSlice[0]!.id);
    expect(pages[pages.length - 1]!.slotSlice[0]!.id).toBeGreaterThan(pages[0]!.slotSlice[0]!.id);
  });

  test("physical fit binds on a tiny wall: 1x1 pages", () => {
    const rs = rooms(3);
    const ss = slots([{ id: 1, day: 0, hour: 9 }, { id: 2, day: 0, hour: 11 }]);
    const pages = buildBoardPages(rs, ss, TZ, { w: 300, h: 300 });
    // (300 - 180) / 210 -> 1 column; (300 - 72 - 52) / 96 -> 1 row.
    expect(pages).toHaveLength(3 * 2);
    expect(pages[0]!.roomSlice).toHaveLength(1);
    expect(pages[0]!.slotSlice).toHaveLength(1);
  });

  test("pages never straddle a day and order day-major", () => {
    const rs = rooms(1);
    const ss = slots([
      { id: 1, day: 0, hour: 9 },
      { id: 2, day: 0, hour: 11 },
      { id: 3, day: 1, hour: 9 },
    ]);
    const pages = buildBoardPages(rs, ss, TZ, { w: 1920, h: 1080 });
    // Day 1's two slots fit one page (cap 6); day 2 gets its own page.
    expect(pages).toHaveLength(2);
    expect(pages[0]!.slotSlice.map((s) => s.id)).toEqual([1, 2]);
    expect(pages[1]!.slotSlice.map((s) => s.id)).toEqual([3]);
    // Multi-day: every page carries its day tag.
    expect(pages[0]!.dayLabel).toBeTruthy();
    expect(pages[1]!.dayLabel).toBeTruthy();
    expect(pages[0]!.dayLabel).not.toBe(pages[1]!.dayLabel);
  });

  test("single-day pages omit the day label", () => {
    const pages = buildBoardPages(
      rooms(1),
      slots([{ id: 1, day: 0, hour: 9 }]),
      TZ,
      { w: 1920, h: 1080 },
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]!.dayLabel).toBeNull();
  });

  test("unmeasured region: everything on one page per chunk of the caps", () => {
    const rs = rooms(2);
    const ss = slots([{ id: 1, day: 0, hour: 9 }, { id: 2, day: 0, hour: 11 }]);
    const pages = buildBoardPages(rs, ss, TZ, null);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.roomSlice).toHaveLength(2);
    expect(pages[0]!.slotSlice).toHaveLength(2);
  });

  test("empty rooms or slots produce no pages", () => {
    expect(buildBoardPages([], slots([{ id: 1, day: 0, hour: 9 }]), TZ, { w: 1920, h: 1080 })).toEqual([]);
    expect(buildBoardPages(rooms(2), [], TZ, { w: 1920, h: 1080 })).toEqual([]);
  });

  test("skipEmpty prunes empty room columns and slot rows per page", () => {
    const rs = rooms(3); // rooms 1..3
    const ss = slots([
      { id: 1, day: 0, hour: 9 },
      { id: 2, day: 0, hour: 11 },
      { id: 3, day: 0, hour: 13 },
    ]);
    // Room 2 is never used; slot 3 has nothing; slots 1-2 use rooms 1 and 3.
    const occupied = new Set(["1:1", "2:3"]);
    const opts = {
      skipEmpty: true,
      hasEntry: (slotId: number, roomId: number) => occupied.has(`${slotId}:${roomId}`),
    };
    const pages = buildBoardPages(rs, ss, TZ, { w: 1920, h: 1080 }, opts);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.roomSlice.map((r) => r.id)).toEqual([1, 3]);
    expect(pages[0]!.slotSlice.map((s) => s.id)).toEqual([1, 2]);
  });

  test("skipEmpty prunes transitively until stable", () => {
    const rs = rooms(3);
    const ss = slots([{ id: 1, day: 0, hour: 9 }, { id: 2, day: 0, hour: 11 }]);
    // Slot 1 uses room 1; slot 2 uses nothing. Pruning slot 2 doesn't touch
    // room 1; rooms 2-3 are empty everywhere. No cascade needed here — but
    // reverse the layout so a room prune empties a slot, which empties a room:
    // slot 1 uses room 3 only, slot 2 uses room 2 only... every room is used.
    // Instead: slot 2 uses room 3, slot 1 uses room 2; room 1 empty everywhere.
    const occupied = new Set(["1:2", "2:3"]);
    const opts = {
      skipEmpty: true,
      hasEntry: (slotId: number, roomId: number) => occupied.has(`${slotId}:${roomId}`),
    };
    const pages = buildBoardPages(rs, ss, TZ, { w: 1920, h: 1080 }, opts);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.roomSlice.map((r) => r.id)).toEqual([2, 3]);
    expect(pages[0]!.slotSlice.map((s) => s.id)).toEqual([1, 2]);
  });

  test("skipEmpty falls back to unpruned pages when nothing is placed at all", () => {
    const rs = rooms(2);
    const ss = slots([{ id: 1, day: 0, hour: 9 }, { id: 2, day: 0, hour: 11 }]);
    const opts = {
      skipEmpty: true,
      hasEntry: () => false,
    };
    const pages = buildBoardPages(rs, ss, TZ, { w: 1920, h: 1080 }, opts);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.roomSlice).toHaveLength(2);
    expect(pages[0]!.slotSlice).toHaveLength(2);
  });

  test("skipEmpty off keeps every room column and slot row", () => {
    const rs = rooms(3);
    const ss = slots([{ id: 1, day: 0, hour: 9 }]);
    const occupied = new Set(["1:1"]);
    const opts = {
      skipEmpty: false,
      hasEntry: (slotId: number, roomId: number) => occupied.has(`${slotId}:${roomId}`),
    };
    const pages = buildBoardPages(rs, ss, TZ, { w: 1920, h: 1080 }, opts);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.roomSlice).toHaveLength(3);
    expect(pages[0]!.slotSlice).toHaveLength(1);
  });

  test("sparse days MERGE into fewer pages: prune runs before chunking", () => {
    // 8 rooms would chunk 6+2, but only rooms 1, 7, 8 are used — and by
    // different slots. Day-scoped pruning leaves 3 rooms + 2 slots, which fit
    // ONE page (previously each chunk pruned independently: 2+ pages).
    const rs = rooms(8);
    const ss = slots([
      { id: 1, day: 0, hour: 11 },
      { id: 2, day: 0, hour: 13 },
    ]);
    const occupied = new Set(["1:1", "2:7", "2:8"]);
    const opts = {
      skipEmpty: true,
      hasEntry: (slotId: number, roomId: number) => occupied.has(`${slotId}:${roomId}`),
    };
    const pages = buildBoardPages(rs, ss, TZ, { w: 1920, h: 1080 }, opts);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.roomSlice.map((r) => r.id)).toEqual([1, 7, 8]);
    expect(pages[0]!.slotSlice.map((s) => s.id)).toEqual([1, 2]);
  });

  test("a window's rooms are picked by first use, never by room id", () => {
    // Slot 1's ONLY session sits in room 7 (highest id); slot 2 fills rooms
    // 1-6. Page 1 must lead with room 7 (it hosts the earliest slot) and
    // every page of the window carries both slot rows — no page starts at a
    // later time, and no unused room column ever appears.
    const rs = rooms(7);
    const ss = slots([
      { id: 1, day: 0, hour: 11 },
      { id: 2, day: 0, hour: 13 },
    ]);
    const occupied = new Set([
      "1:7",
      "2:1", "2:2", "2:3", "2:4", "2:5", "2:6",
    ]);
    const opts = {
      skipEmpty: true,
      hasEntry: (slotId: number, roomId: number) => occupied.has(`${slotId}:${roomId}`),
    };
    const pages = buildBoardPages(rs, ss, TZ, { w: 4000, h: 2200 }, opts);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.slotSlice.map((s) => s.id)).toEqual([1, 2]);
    expect(pages[1]!.slotSlice.map((s) => s.id)).toEqual([1, 2]);
    // Room 7 hosts the earliest slot → FIRST column of page 1.
    expect(pages[0]!.roomSlice.map((r) => r.id)).toEqual([7, 1, 2, 3, 4, 5]);
    expect(pages[1]!.roomSlice.map((r) => r.id)).toEqual([6]);
  });
});
