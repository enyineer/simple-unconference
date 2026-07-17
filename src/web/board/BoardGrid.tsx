// The room x slot board grid. Two layouts from the same grouped data: a true
// matrix (rooms = columns, slots = rows) for the projector, and a stacked
// fallback (slot cards with room sub-rows) for phones. The layout is chosen by
// a matchMedia hook so neither is ever rendered off-screen.
//
// The projector never scrolls, so the matrix paginates BOTH axes (see
// useBoardPages) and auto-rotates through the pages, seeded to the live moment.
//
// A cell's INNER content is keyed by submission id, so when the session in a
// cell changes the entry animation replays; an unchanged cell updates in place
// (calm — no flicker on every refetch).

import { useEffect, useRef, useState } from "react";
import type {
  BoardEntryOut,
  BoardPayloadOut,
  BoardRoomOut,
  BoardSlotOut,
} from "../../shared/contract/types";
import { formatSlotRange, isSlotNow, slotKindMeta } from "./boardFormat";
import { useBoardPages, type BoardPage } from "./useBoardPages";

// Calm auto-advance cadence for the projector page rotation.
const PAGE_ROTATE_MS = 15_000;

// The "where am I looking" summary for the currently visible page, surfaced up
// to the board header (the prominent wayfinding spot) rather than buried in the
// bottom pager. `rooms`/`day` are null when they'd add nothing (all rooms fit /
// single-day conference).
export interface BoardNav {
  day: string | null;
  rooms: string | null;
  time: string;
}

function navForPage(page: BoardPage, timeFmt: Intl.DateTimeFormat): BoardNav {
  return {
    day: page.dayLabel,
    rooms:
      page.roomTotal > page.roomSlice.length
        ? `Rooms ${page.roomStart}–${page.roomEnd} of ${page.roomTotal}`
        : null,
    time: `${timeFmt.format(page.rangeStart)}–${timeFmt.format(page.rangeEnd)}`,
  };
}

function useNarrow(query = "(max-width: 720px)"): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

function entryKey(slotId: number, roomId: number): string {
  return `${slotId}:${roomId}`;
}

function CellContent({ entry }: { entry: BoardEntryOut }) {
  return (
    <div className="board-cell-in">
      <div className="board-cell-title">{entry.title}</div>
      {entry.submitter_name && <div className="board-cell-by">{entry.submitter_name}</div>}
      <div className="board-cell-meta">
        <span className="board-cell-stars">★ {entry.star_count}</span>
        {!entry.planned && (
          <span className="board-cell-seats">◍ {entry.attendee_count}</span>
        )}
        {entry.mandatory && <span className="board-cell-badge">Everyone</span>}
      </div>
    </div>
  );
}

function Cell({
  entry,
  kindClass,
}: {
  entry: BoardEntryOut | undefined;
  kindClass: string;
}) {
  if (!entry) return <div className="board-cell is-empty" aria-hidden="true" />;
  return (
    <div className={`board-cell ${kindClass}`}>
      {/* Keyed so a changed session remounts + replays the entry animation. */}
      <CellContent key={entry.submission_id} entry={entry} />
    </div>
  );
}

export function BoardGrid({
  payload,
  now,
  timeFmt,
  onNav,
}: {
  payload: BoardPayloadOut;
  now: number;
  timeFmt: Intl.DateTimeFormat;
  // Reports the currently-visible page's day/rooms/time up to the header so it
  // can show a prominent "where am I looking" indicator. Null on the phone
  // stacked layout / empty board (nothing to page through).
  onNav: (nav: BoardNav | null) => void;
}) {
  const narrow = useNarrow();
  const { rooms, slots, entries } = payload;

  const byCell = new Map<string, BoardEntryOut>();
  for (const e of entries) byCell.set(entryKey(e.slot_id, e.room_id), e);

  // The stacked/empty paths don't paginate, so the header indicator has nothing
  // to show — clear it. Guarded on the values so it isn't fired every render.
  const noNav = narrow || slots.length === 0 || rooms.length === 0;
  useEffect(() => {
    if (noNav) onNav(null);
  }, [noNav, onNav]);

  if (slots.length === 0 || rooms.length === 0) {
    return (
      <div className="board-empty-note">
        The schedule is being prepared. Sessions will appear here as they are placed.
      </div>
    );
  }

  if (narrow) {
    return <StackedBoard rooms={rooms} slots={slots} byCell={byCell} now={now} timeFmt={timeFmt} />;
  }

  return (
    <PagedBoard
      rooms={rooms}
      slots={slots}
      byCell={byCell}
      now={now}
      timeFmt={timeFmt}
      timezone={payload.timezone}
      onNav={onNav}
    />
  );
}

// Desktop projector matrix. Owns the measured region ref, the page slices, and
// the rotation index. Renders exactly one page at a time so nothing is ever cut
// off or below the fold.
function PagedBoard({
  rooms,
  slots,
  byCell,
  now,
  timeFmt,
  timezone,
  onNav,
}: {
  rooms: BoardRoomOut[];
  slots: BoardSlotOut[];
  byCell: Map<string, BoardEntryOut>;
  now: number;
  timeFmt: Intl.DateTimeFormat;
  timezone: string;
  onNav: (nav: BoardNav | null) => void;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const pages = useBoardPages(regionRef, rooms, slots, timezone);
  // `tick` is the rotation counter (advanced by the timer). The visible page is
  // (seed + tick) % length, so a freshly-opened wall starts on the live moment
  // and then rotates from there.
  const [tick, setTick] = useState(0);

  // Seed once to the page holding the current "now" slot. Adjust-state-during-
  // render (the React-blessed pattern for deriving from props): the conditional
  // guard runs it only until seeded. Gated on `> 1` so the brief pre-measurement
  // single-page state never consumes the seed; resize reflows keep the seed.
  const [seed, setSeed] = useState<number | null>(null);
  if (seed === null && pages.length > 1) {
    const live = pages.findIndex((p) => p.slotSlice.some((s) => isSlotNow(s, now)));
    setSeed(live > 0 ? live : 0);
  }

  // Auto-advance through the pages, looping. Cadence is identical under
  // reduced-motion; only the per-page transition style changes (CSS-driven).
  useEffect(() => {
    if (pages.length <= 1) return;
    const id = setInterval(() => setTick((t) => t + 1), PAGE_ROTATE_MS);
    return () => clearInterval(id);
  }, [pages.length]);

  const active = pages.length > 0 ? ((seed ?? 0) + tick) % pages.length : 0;
  const page = pages[active];

  // Surface the visible page's day/rooms/time to the header. Effect (not
  // render) because it setStates a parent; deps are the derived page + fmt, so
  // it only fires on an actual page change or resize reflow — no loop.
  useEffect(() => {
    onNav(page ? navForPage(page, timeFmt) : null);
  }, [page, timeFmt, onNav]);

  return (
    <div className="board-page" ref={regionRef}>
      {page && (
        <BoardMatrix
          key={active}
          page={page}
          byCell={byCell}
          now={now}
          timeFmt={timeFmt}
        />
      )}
      {/* Bottom strip is now just the rotation dots — the day/rooms/time label
          lives prominently in the header (see BoardHeaderNav). */}
      {pages.length > 1 && <BoardPager count={pages.length} active={active} />}
    </div>
  );
}

// One page of the matrix: its room slice as columns, its slot slice as rows.
// Keyed by the active page index in the parent so a page change replays the
// entrance animation.
function BoardMatrix({
  page,
  byCell,
  now,
  timeFmt,
}: {
  page: BoardPage;
  byCell: Map<string, BoardEntryOut>;
  now: number;
  timeFmt: Intl.DateTimeFormat;
}) {
  const { roomSlice, slotSlice } = page;
  // A FIXED first track (a single clamp length, not a content-sized minmax) so
  // the head grid and the body rows — two separate grids — resolve their
  // columns to identical widths and stay aligned.
  const template = `clamp(150px, 16vw, 210px) repeat(${roomSlice.length}, minmax(210px, 1fr))`;

  return (
    <div className="board-page-anim">
      <div className="board-grid-head" style={{ gridTemplateColumns: template }}>
        <div className="board-corner">Rooms →</div>
        {roomSlice.map((r) => (
          <div key={r.id} className="board-room-head">
            <span className="board-room-name">{r.name}</span>
            <span className="board-room-cap">{r.capacity} seats</span>
          </div>
        ))}
      </div>
      <div className="board-grid" style={{ gridAutoRows: "minmax(84px, 1fr)" }}>
        {slotSlice.map((slot) => {
          const nowSlot = isSlotNow(slot, now);
          const meta = slotKindMeta(slot.type);
          return (
            <div
              key={slot.id}
              className={`board-row${nowSlot ? " is-now" : ""}`}
              style={{ gridTemplateColumns: template }}
            >
              <div className="board-slot-rail">
                <span className="board-slot-time">{formatSlotRange(slot, timeFmt)}</span>
                {slot.title && <span className="board-slot-title">{slot.title}</span>}
                <span className="board-slot-type" style={{ color: meta.colorVar }}>
                  {meta.label}
                </span>
                {nowSlot && <span className="board-now-tag">Now</span>}
              </div>
              {roomSlice.map((r) => (
                <Cell
                  key={r.id}
                  entry={byCell.get(entryKey(slot.id, r.id))}
                  kindClass={meta.cellClass}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Rotation progress: one dot per page, active dot highlighted. The textual
// "which day / rooms / time" label lives prominently in the header now
// (BoardHeaderNav), so the bottom strip is just the dots.
function BoardPager({ count, active }: { count: number; active: number }) {
  return (
    <div className="board-pager">
      <span className="board-pager-dots">
        {Array.from({ length: count }, (_, i) => (
          <span
            key={i}
            className={`board-pager-dot${i === active ? " is-active" : ""}`}
            aria-hidden="true"
          />
        ))}
      </span>
    </div>
  );
}

function StackedBoard({
  rooms,
  slots,
  byCell,
  now,
  timeFmt,
}: {
  rooms: BoardRoomOut[];
  slots: BoardSlotOut[];
  byCell: Map<string, BoardEntryOut>;
  now: number;
  timeFmt: Intl.DateTimeFormat;
}) {
  return (
    <div className="board-stack">
      {slots.map((slot) => {
        const nowSlot = isSlotNow(slot, now);
        const meta = slotKindMeta(slot.type);
        const filled = rooms
          .map((r) => ({ room: r, entry: byCell.get(entryKey(slot.id, r.id)) }))
          .filter((x): x is { room: BoardRoomOut; entry: BoardEntryOut } => Boolean(x.entry));
        return (
          <div
            key={slot.id}
            className={`board-stack-slot${nowSlot ? " is-now" : ""}`}
            data-board-now={nowSlot ? "1" : undefined}
          >
            <div className="board-stack-head">
              <span className="board-stack-time">{formatSlotRange(slot, timeFmt)}</span>
              <span className="board-slot-type" style={{ color: meta.colorVar }}>
                {nowSlot ? "Now" : meta.label}
              </span>
            </div>
            <div className="board-stack-body">
              {filled.length === 0 ? (
                <div className="board-stack-cell">
                  <span className="board-cell-by">No sessions placed yet.</span>
                </div>
              ) : (
                filled.map(({ room, entry }) => (
                  <div key={room.id} className={`board-stack-cell ${meta.cellClass}`}>
                    <span className="board-stack-room">{room.name}</span>
                    <span className="board-cell-title">{entry.title}</span>
                    {entry.submitter_name && (
                      <span className="board-cell-by">{entry.submitter_name}</span>
                    )}
                    <div className="board-cell-meta">
                      <span className="board-cell-stars">★ {entry.star_count}</span>
                      {!entry.planned && (
                        <span className="board-cell-seats">◍ {entry.attendee_count}</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
