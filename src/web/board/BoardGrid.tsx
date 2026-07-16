// The room x slot board grid. Two layouts from the same grouped data: a true
// matrix (rooms = columns, slots = rows) for the projector, and a stacked
// fallback (slot cards with room sub-rows) for phones. The layout is chosen by
// a matchMedia hook so neither is ever rendered off-screen.
//
// A cell's INNER content is keyed by submission id, so when the session in a
// cell changes the entry animation replays; an unchanged cell updates in place
// (calm — no flicker on every refetch). The slot in progress right now carries
// `data-board-now` so the page can scroll it into view.

import { useEffect, useState } from "react";
import type {
  BoardEntryOut,
  BoardPayloadOut,
  BoardRoomOut,
  BoardSlotOut,
} from "../../shared/contract/types";
import { formatSlotRange, isSlotNow, slotKindMeta } from "./boardFormat";

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
}: {
  payload: BoardPayloadOut;
  now: number;
  timeFmt: Intl.DateTimeFormat;
}) {
  const narrow = useNarrow();
  const { rooms, slots, entries } = payload;

  const byCell = new Map<string, BoardEntryOut>();
  for (const e of entries) byCell.set(entryKey(e.slot_id, e.room_id), e);

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

  // A FIXED first track (a single clamp length, not a content-sized minmax) so
  // the sticky head grid and the body rows — two separate grids — resolve their
  // columns to identical widths and stay aligned.
  const template = `clamp(150px, 16vw, 210px) repeat(${rooms.length}, minmax(210px, 1fr))`;

  return (
    <div className="board-scroll">
      <div className="board-grid-head" style={{ gridTemplateColumns: template }}>
        <div className="board-corner">Rooms →</div>
        {rooms.map((r) => (
          <div key={r.id} className="board-room-head">
            <span className="board-room-name">{r.name}</span>
            <span className="board-room-cap">{r.capacity} seats</span>
          </div>
        ))}
      </div>
      <div className="board-grid" style={{ gridAutoRows: "minmax(84px, auto)" }}>
        {slots.map((slot) => {
          const nowSlot = isSlotNow(slot, now);
          const meta = slotKindMeta(slot.type);
          return (
            <div
              key={slot.id}
              className={`board-row${nowSlot ? " is-now" : ""}`}
              style={{ gridTemplateColumns: template }}
              data-board-now={nowSlot ? "1" : undefined}
            >
              <div className="board-slot-rail">
                <span className="board-slot-time">{formatSlotRange(slot, timeFmt)}</span>
                {slot.title && <span className="board-slot-title">{slot.title}</span>}
                <span className="board-slot-type" style={{ color: meta.colorVar }}>
                  {meta.label}
                </span>
                {nowSlot && <span className="board-now-tag">Now</span>}
              </div>
              {rooms.map((r) => (
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
