// Fit-to-screen pagination for the projector Live Board. A wall never scrolls,
// so instead of one over-wide/over-tall matrix we slice rooms (columns) and
// slots (rows) into pages that each fit the measured board region, and the grid
// auto-rotates through them (see BoardGrid).
//
// A ResizeObserver on the board region gives the true available box. We reserve
// a fixed allowance for the sticky room-header row and the pager strip, then
// fit as many legible columns/rows as the remaining space holds — CAPPED at a
// legibility maximum (MAX_ROOMS_PER_PAGE / MAX_SLOTS_PER_PAGE): a page packed
// to the physical limit has cells too small to read from across the room, so
// overflow becomes MORE PAGES on the existing rotation instead of denser
// pages. Fewer items per page also means the surviving cells stretch to fill
// the same space (the grid template uses minmax(..., 1fr) on both axes).
//
// Slots are first bucketed by LOCAL CALENDAR DAY (in the conference timezone) so
// a page never straddles a day boundary — otherwise its clock-only time range
// would read backwards (day-1 evening → day-2 morning). Page ordering is then
// DAY-major, ROOM-major within a day: all of day 1's room/time pages, then day
// 2's. A viewer sees a room's whole day before the columns shift under them.
//
// When `skipEmpty` is set (Conference.boardSkipEmpty, default on), each day
// first prunes room columns / slot rows with no placed session — a fixed-point
// pass, BEFORE chunking, so sparse days merge into fewer denser pages instead
// of pages shrinking independently. A per-page polish pass then drops rows
// whose sessions all landed in another page's room chunk. If pruning would
// remove EVERY page (nothing placed at all), the unpruned pages render
// instead so the wall stays informative.

import { useEffect, useMemo, useState, type RefObject } from "react";
import type { BoardRoomOut, BoardSlotOut } from "../../shared/contract/types";
import { instantToWallClock } from "../../shared/tz";

// Minimum legible column width and the first-column time rail width — mirror the
// grid template `clamp(150px,16vw,210px) repeat(n, minmax(210px,1fr))`.
const MIN_COL_PX = 210;
const TIME_RAIL_PX = 180;
// Minimum legible row height (a cell floors at 84px + gap).
const MIN_ROW_PX = 96;
// Non-row height inside the region: the room-header row and the pager strip
// (each incl. its grid/flex gap). Kept a touch generous so we never over-fill.
const ROOM_HEAD_PX = 72;
const PAGER_PX = 52;

// LEGIBILITY CAPS. Hard maximums per page, independent of screen size — more
// rooms/slots than this becomes additional pages, never smaller cells. 6×6 is
// about the densest matrix that stays readable from a hallway's far end.
export const MAX_ROOMS_PER_PAGE = 6;
export const MAX_SLOTS_PER_PAGE = 6;

export interface BoardPage {
  roomSlice: BoardRoomOut[];
  slotSlice: BoardSlotOut[];
  // 1-based room index range for the pager label ("Rooms 1–8 of 14"). After
  // pruning, the span of the room columns still visible on the page.
  roomStart: number;
  roomEnd: number;
  roomTotal: number;
  // Time window covered by this page's slots, for the pager label.
  rangeStart: number;
  rangeEnd: number;
  // Short day tag ("Fri 17 Jul") for the pager, or null on a single-day
  // conference (no day prefix needed).
  dayLabel: string | null;
}

export interface BoardPageOpts {
  /** Prune room columns / slot rows with no placed session — day-scoped,
   *  BEFORE pages are chunked (so sparse days merge into fewer pages), plus a
   *  per-page polish pass for cross-chunk strays. */
  skipEmpty?: boolean;
  /** Whether the (slot, room) cell has a session — required for skipEmpty. */
  hasEntry?: (slotId: number, roomId: number) => boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Contiguous runs of slots that share a local calendar day (slots arrive ordered
// by start). Keyed by a timezone-stable y/m/d string so a page can't span days.
function groupByDay(slots: BoardSlotOut[], timeZone: string): BoardSlotOut[][] {
  let current: { key: string; items: BoardSlotOut[] } | null = null;
  const groups: { key: string; items: BoardSlotOut[] }[] = [];
  for (const slot of slots) {
    const key = instantToWallClock(slot.starts_at, timeZone).slice(0, 10);
    if (!current || current.key !== key) {
      current = { key, items: [] };
      groups.push(current);
    }
    current.items.push(slot);
  }
  return groups.map((g) => g.items);
}

// Fixed-point pruning of one page's slices: drop rooms with no entry in any
// surviving slot, drop slots with no entry in any surviving room, repeat until
// stable — a slot emptied by a room prune can prune further rooms in turn.
function pruneEmpty(
  rs: BoardRoomOut[],
  ss: BoardSlotOut[],
  hasEntry: (slotId: number, roomId: number) => boolean,
): { rs: BoardRoomOut[]; ss: BoardSlotOut[] } {
  for (;;) {
    const nextSlots = ss.filter((slot) => rs.some((r) => hasEntry(slot.id, r.id)));
    const nextRooms = rs.filter((r) => nextSlots.some((slot) => hasEntry(slot.id, r.id)));
    if (nextRooms.length === rs.length && nextSlots.length === ss.length) {
      return { rs, ss };
    }
    rs = nextRooms;
    ss = nextSlots;
  }
}

// Pure page builder — the hook below only owns the ResizeObserver. `viewport`
// is the measured board region; before the first measurement callers pass
// null and everything lands on one page (the observer fires right after
// mount and reflows into real pages).
export function buildBoardPages(
  rooms: BoardRoomOut[],
  slots: BoardSlotOut[],
  timeZone: string,
  viewport: { w: number; h: number } | null,
  opts: BoardPageOpts = {},
): BoardPage[] {
  if (rooms.length === 0 || slots.length === 0) return [];

  const skipEmpty = opts.skipEmpty === true && typeof opts.hasEntry === "function";
  const hasEntry = opts.hasEntry ?? (() => true);

  const measured = viewport !== null && viewport.w > 0 && viewport.h > 0;
  const physicalRooms = measured
    ? Math.max(1, Math.floor((viewport!.w - TIME_RAIL_PX) / MIN_COL_PX))
    : rooms.length;
  const physicalSlots = measured
    ? Math.max(1, Math.floor((viewport!.h - ROOM_HEAD_PX - PAGER_PX) / MIN_ROW_PX))
    : slots.length;
  // The caps bind before the physical fit on anything projector-sized.
  const roomsPerPage = Math.min(physicalRooms, MAX_ROOMS_PER_PAGE, rooms.length);
  const slotsPerPage = Math.min(physicalSlots, MAX_SLOTS_PER_PAGE, slots.length);

  const dayGroups = groupByDay(slots, timeZone);
  const multiDay = dayGroups.length > 1;
  const dayLabelFmt = new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  const pages: BoardPage[] = [];
  let candidates = 0;
  for (const daySlots of dayGroups) {
    // A day with any slots is a fallback candidate — even when pruning later
    // empties it entirely (that's exactly when the fallback must fire).
    if (daySlots.length > 0) candidates++;
    // Prune BEFORE chunking, at day scope: drop rooms with no entry anywhere
    // in this day's slots and slots with no entry in any room, fixed-point.
    // Doing this before the page split is what lets sparse days MERGE into
    // fewer, denser pages — pruning per page could only shrink pages, never
    // combine them.
    let dayRooms = rooms;
    let daySlotsSurviving = daySlots;
    if (skipEmpty) {
      const pruned = pruneEmpty(rooms, daySlots, hasEntry);
      dayRooms = pruned.rs;
      daySlotsSurviving = pruned.ss;
    }
    const slotGroups = chunk(daySlotsSurviving, slotsPerPage);
    for (const roomSlice of chunk(dayRooms, roomsPerPage)) {
      for (const slotSlice of slotGroups) {
        const first = slotSlice[0];
        const last = slotSlice[slotSlice.length - 1];
        if (!first || !last) continue;
        let pageRooms = roomSlice;
        let pageSlots = slotSlice;
        if (skipEmpty) {
          // Polish pass: when the day's survivors span multiple pages, a slot
          // whose sessions all sit in another page's room chunk would still
          // render an empty row here — re-prune the page's own matrix.
          const pruned = pruneEmpty(pageRooms, pageSlots, hasEntry);
          pageRooms = pruned.rs;
          pageSlots = pruned.ss;
          if (pageRooms.length === 0 || pageSlots.length === 0) continue;
        }
        // The nav span tracks the room columns still visible after pruning.
        const startIdx = rooms.indexOf(pageRooms[0]!);
        const endIdx = rooms.indexOf(pageRooms[pageRooms.length - 1]!);
        pages.push({
          roomSlice: pageRooms,
          slotSlice: pageSlots,
          roomStart: startIdx + 1,
          roomEnd: endIdx + 1,
          roomTotal: rooms.length,
          rangeStart: first.starts_at,
          rangeEnd: last.ends_at,
          dayLabel: multiDay ? dayLabelFmt.format(first.starts_at) : null,
        });
      }
    }
  }
  // Fallback: if pruning emptied EVERY page (no placements at all), render the
  // unpruned pages so the wall never goes blank — skipping is de-noising, not
  // a way to hide that nothing is scheduled yet.
  if (pages.length === 0 && candidates > 0) {
    return buildBoardPages(rooms, slots, timeZone, viewport, { ...opts, skipEmpty: false });
  }
  return pages;
}

export function useBoardPages(
  regionRef: RefObject<HTMLElement | null>,
  rooms: BoardRoomOut[],
  slots: BoardSlotOut[],
  timezone: string,
  opts: BoardPageOpts = {},
): BoardPage[] {
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = regionRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ w: box.width, h: box.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [regionRef]);

  const measured = useMemo(
    () => (size.w > 0 && size.h > 0 ? { w: size.w, h: size.h } : null),
    [size.w, size.h],
  );
  return useMemo(
    () => buildBoardPages(rooms, slots, timezone, measured, opts),
    [rooms, slots, timezone, measured, opts],
  );
}
