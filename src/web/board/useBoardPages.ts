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
// DAY-major, TIME-major within a day: all pages of the earliest time window,
// then the next window — a page never jumps back to earlier sessions.
//
// A page's ROOM COLUMNS are the rooms that actually host one of the window's
// sessions, ordered by FIRST USE in the window — never a raw id-ordered prefix
// of all rooms (room ids can be in any order). So the room with the earliest
// session leads page 1, and no page ever wastes a column on an empty room.
// Slot rows are shared verbatim by every page of a window, so the wall's first
// row is always the day's earliest non-empty slot. When `skipEmpty` is off,
// every room counts as "used" (plain id-order chunks).
//
// Days with slots whose sessions are placed nowhere at all still render via a
// fallback: if pruning empties EVERY page, the unpruned pages render so the
// wall stays informative.

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
  // Time window covered by this page's slots, for the pager label.
  rangeStart: number;
  rangeEnd: number;
  // Short day tag ("Fri 17 Jul") for the pager, or null on a single-day
  // conference (no day prefix needed).
  dayLabel: string | null;
}

export interface BoardPageOpts {
  /** Only show rooms hosting a session in each time window (ordered by first
   *  use) and drop slots with no placed session anywhere. */
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
  // ONLY consult real occupancy when skipEmpty is on — with it off, every room
  // counts as used. (Letting the raw opts.hasEntry leak through here made the
  // no-placements fallback recurse forever: skipEmpty:false still saw
  // "nothing anywhere" and re-entered with zero pages.)
  const hasEntry = skipEmpty && opts.hasEntry ? opts.hasEntry : () => true;

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
    // Drop slots with no placed session anywhere (day scope, before the time
    // split) — the wall never shows an entirely empty row.
    let daySlotsSurviving = daySlots;
    if (skipEmpty) {
      daySlotsSurviving = daySlots.filter((s) => rooms.some((r) => hasEntry(s.id, r.id)));
    }
    const slotGroups = chunk(daySlotsSurviving, slotsPerPage);
    for (const slotSlice of slotGroups) {
      const first = slotSlice[0];
      const last = slotSlice[slotSlice.length - 1];
      if (!first || !last) continue;
      // Rooms for THIS TIME WINDOW: exactly the rooms hosting one of the
      // window's sessions — never a raw id-ordered prefix of all rooms.
      // Ordered by FIRST USE in the window (earliest slot wins; stable sort
      // keeps payload order on ties), so the room with the window's earliest
      // session leads page 1 no matter what its room id is. With skipEmpty
      // off, hasEntry is always true → firstUse 0 → plain payload order.
      const windowRooms = rooms
        .map((room) => ({
          room,
          firstUse: slotSlice.findIndex((s) => hasEntry(s.id, room.id)),
        }))
        .filter((x) => x.firstUse >= 0)
        .sort((a, b) => a.firstUse - b.firstUse)
        .map((x) => x.room);
      for (const roomSlice of chunk(windowRooms, roomsPerPage)) {
        pages.push({
          roomSlice,
          slotSlice,
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
