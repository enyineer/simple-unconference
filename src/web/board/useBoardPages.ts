// Fit-to-screen pagination for the projector Live Board. A wall never scrolls,
// so instead of one over-wide/over-tall matrix we slice rooms (columns) and
// slots (rows) into pages that each fit the measured board region, and the grid
// auto-rotates through them (see BoardGrid).
//
// A ResizeObserver on the board region gives the true available box. We reserve
// a fixed allowance for the sticky room-header row and the pager strip, then fit
// as many legible columns/rows as the remaining space holds.
//
// Slots are first bucketed by LOCAL CALENDAR DAY (in the conference timezone) so
// a page never straddles a day boundary — otherwise its clock-only time range
// would read backwards (day-1 evening → day-2 morning). Page ordering is then
// DAY-major, ROOM-major within a day: all of day 1's room/time pages, then day
// 2's. A viewer sees a room's whole day before the columns shift under them.

import { useEffect, useMemo, useState, type RefObject } from "react";
import type { BoardRoomOut, BoardSlotOut } from "../../shared/contract/types";

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

export interface BoardPage {
  roomSlice: BoardRoomOut[];
  slotSlice: BoardSlotOut[];
  // 1-based room index range for the pager label ("Rooms 1–8 of 14").
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

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Contiguous runs of slots that share a local calendar day (slots arrive ordered
// by start). Keyed by a timezone-stable y/m/d string so a page can't span days.
function groupByDay(slots: BoardSlotOut[], dayKey: Intl.DateTimeFormat): BoardSlotOut[][] {
  let current: { key: string; items: BoardSlotOut[] } | null = null;
  const groups: { key: string; items: BoardSlotOut[] }[] = [];
  for (const slot of slots) {
    const key = dayKey.format(slot.starts_at);
    if (!current || current.key !== key) {
      current = { key, items: [] };
      groups.push(current);
    }
    current.items.push(slot);
  }
  return groups.map((g) => g.items);
}

export function useBoardPages(
  regionRef: RefObject<HTMLElement | null>,
  rooms: BoardRoomOut[],
  slots: BoardSlotOut[],
  timezone: string,
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

  return useMemo(() => {
    if (rooms.length === 0 || slots.length === 0) return [];

    // Before the first measurement, show everything as one page; the observer
    // fires right after mount and reflows into real pages.
    const measured = size.w > 0 && size.h > 0;
    const roomsPerPage = measured
      ? Math.max(1, Math.floor((size.w - TIME_RAIL_PX) / MIN_COL_PX))
      : rooms.length;
    const slotsPerPage = measured
      ? Math.max(1, Math.floor((size.h - ROOM_HEAD_PX - PAGER_PX) / MIN_ROW_PX))
      : slots.length;

    const dayKeyFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const dayGroups = groupByDay(slots, dayKeyFmt);
    const multiDay = dayGroups.length > 1;
    const dayLabelFmt = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
    });

    const pages: BoardPage[] = [];
    for (const daySlots of dayGroups) {
      const slotGroups = chunk(daySlots, slotsPerPage);
      let roomStart = 0;
      for (const roomSlice of chunk(rooms, roomsPerPage)) {
        for (const slotSlice of slotGroups) {
          const first = slotSlice[0];
          const last = slotSlice[slotSlice.length - 1];
          if (!first || !last) continue;
          pages.push({
            roomSlice,
            slotSlice,
            roomStart: roomStart + 1,
            roomEnd: roomStart + roomSlice.length,
            roomTotal: rooms.length,
            rangeStart: first.starts_at,
            rangeEnd: last.ends_at,
            dayLabel: multiDay ? dayLabelFmt.format(first.starts_at) : null,
          });
        }
        roomStart += roomSlice.length;
      }
    }
    return pages;
  }, [rooms, slots, size.w, size.h, timezone]);
}
