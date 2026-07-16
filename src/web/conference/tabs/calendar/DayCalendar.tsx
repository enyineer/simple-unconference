import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatInTz } from "../../../../shared/tz";
import {
  AXIS_WIDTH,
  HEADER_BORDER_RADIUS,
  MIN_SLOT_COL_WIDTH,
  MIN_SLOT_HEIGHT_PX,
  PX_PER_MIN,
  SNAP_MIN,
} from "./constants";
import { endOfDay, snapToMinutes, startOfDay } from "./helpers";
import { layoutSlots } from "./layoutSlots";
import { NowIndicator } from "./NowIndicator";
import { SlotEvent } from "./SlotEvent";
import type {
  CalMixerPlacement,
  CalPlacement,
  CalRoom,
  CalSlot,
  CalSubmission,
  CalTrack,
  DragState,
} from "./types";

export function DayCalendar({
  dayMs, windowStartMin, windowEndMin, slots, tracks, placements, mixerPlacements,
  rooms, subs, isMod, timeZone,
  selectedSlotId, onSelectSlot, onMoveSlot, onToggleStaticStar, onToggleSubmissionStar,
}: {
  dayMs: number; windowStartMin: number; windowEndMin: number;
  slots: CalSlot[]; tracks: CalTrack[]; placements: CalPlacement[];
  mixerPlacements: CalMixerPlacement[];
  rooms: CalRoom[]; subs: CalSubmission[]; isMod: boolean;
  timeZone: string;
  selectedSlotId: number | null;
  onSelectSlot?: (id: number) => void;
  onMoveSlot: (id: number, s: number, e: number) => Promise<void>;
  onToggleStaticStar?: (track: CalTrack) => Promise<void>;
  onToggleSubmissionStar?: (sub: CalSubmission) => Promise<void>;
}) {
  const totalMinutes = windowEndMin - windowStartMin;
  const totalHeight = totalMinutes * PX_PER_MIN;
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Set briefly after a drag actually moves the slot — the synthetic click
  // event that fires right after pointerup would otherwise open the sheet.
  const justDraggedRef = useRef(false);

  const layout = useMemo(() => layoutSlots(slots), [slots]);
  // Max columns across all clusters in this day → determines width of the
  // events area. We multiply by min slot width to enable horizontal scroll
  // when there are many overlapping slots (mobile friendliness).
  const maxCols = layout.reduce((m, l) => Math.max(m, l.cols), 1);
  const eventsAreaWidth = maxCols * MIN_SLOT_COL_WIDTH;

  const dayLabel = useMemo(() => formatInTz(dayMs, timeZone, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  }), [dayMs, timeZone]);

  // ---- drag pointer handling ----
  const beginDrag = useCallback((slot: CalSlot, mode: DragState["mode"], e: React.PointerEvent) => {
    if (!isMod) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({
      slotId: slot.id, mode,
      startY: e.clientY,
      origStart: slot.starts_at, origEnd: slot.ends_at,
      liveStart: slot.starts_at, liveEnd: slot.ends_at,
    });
  }, [isMod]);

  const moveDrag = useCallback((e: React.PointerEvent) => {
    if (!drag) return;
    const dyPx = e.clientY - drag.startY;
    const dyMin = snapToMinutes(dyPx / PX_PER_MIN);
    const deltaMs = dyMin * 60 * 1000;
    const dayStart = startOfDay(drag.origStart, timeZone);
    const dayEnd = endOfDay(drag.origStart, timeZone);
    let liveStart = drag.origStart;
    let liveEnd = drag.origEnd;
    if (drag.mode === "move") {
      liveStart = drag.origStart + deltaMs;
      liveEnd = drag.origEnd + deltaMs;
      if (liveStart < dayStart) { liveEnd += dayStart - liveStart; liveStart = dayStart; }
      if (liveEnd > dayEnd)     { liveStart -= liveEnd - dayEnd;   liveEnd = dayEnd; }
    } else if (drag.mode === "resize-top") {
      liveStart = drag.origStart + deltaMs;
      if (liveStart > drag.origEnd - SNAP_MIN * 60 * 1000) liveStart = drag.origEnd - SNAP_MIN * 60 * 1000;
      if (liveStart < dayStart) liveStart = dayStart;
    } else if (drag.mode === "resize-bottom") {
      liveEnd = drag.origEnd + deltaMs;
      if (liveEnd < drag.origStart + SNAP_MIN * 60 * 1000) liveEnd = drag.origStart + SNAP_MIN * 60 * 1000;
      if (liveEnd > dayEnd) liveEnd = dayEnd;
    }
    setDrag({ ...drag, liveStart, liveEnd });
  }, [drag, timeZone]);

  const endDrag = useCallback(async () => {
    if (!drag) return;
    const { slotId, liveStart, liveEnd, origStart, origEnd } = drag;
    setDrag(null);
    if (liveStart !== origStart || liveEnd !== origEnd) {
      // Block the synthetic click that follows pointerup so the user doesn't
      // get the sheet popped open every time they finish a drag. Cleared on
      // the next tick — the click event fires before any user-initiated one.
      justDraggedRef.current = true;
      setTimeout(() => { justDraggedRef.current = false; }, 0);
      await onMoveSlot(slotId, liveStart, liveEnd);
    }
  }, [drag, onMoveSlot]);

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrag(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag]);

  const hours: number[] = [];
  for (let m = windowStartMin; m <= windowEndMin; m += 60) hours.push(m);

  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{dayLabel}</div>
      <div
        style={{
          border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
          borderRadius: HEADER_BORDER_RADIUS,
          overflow: "auto", // mobile: horizontal scroll for crowded clusters
          userSelect: drag ? "none" : undefined,
        }}
      >
        <div
          ref={gridRef}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{
            position: "relative",
            display: "flex",
            alignItems: "stretch",
            minWidth: AXIS_WIDTH + eventsAreaWidth,
          }}
        >
          {/* time axis */}
          <div
            style={{
              width: AXIS_WIDTH, flex: `0 0 ${AXIS_WIDTH}px`,
              position: "sticky", left: 0, zIndex: 3,
              background: "var(--bgColor-default, var(--uncon-bg, #fff))",
              borderRight: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
              height: totalHeight,
            }}
          >
            {hours.map((m) => (
              <div key={m} style={{
                position: "absolute",
                top: (m - windowStartMin) * PX_PER_MIN,
                left: 0, right: 0,
                borderTop: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
                fontSize: 11, color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                paddingLeft: 6, paddingTop: 2,
              }}>
                {String(Math.floor(m / 60)).padStart(2, "0")}:{String(m % 60).padStart(2, "0")}
              </div>
            ))}
          </div>

          {/* events column */}
          <div style={{ position: "relative", flex: "1 0 auto", width: eventsAreaWidth, height: totalHeight }}>
            {/* current-time indicator — only on today's column */}
            <NowIndicator dayMs={dayMs} windowStartMin={windowStartMin} windowEndMin={windowEndMin} timeZone={timeZone} />

            {/* background hour lines */}
            {hours.map((m) => (
              <div key={m} style={{
                position: "absolute",
                top: (m - windowStartMin) * PX_PER_MIN,
                left: 0, right: 0,
                borderTop: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
                pointerEvents: "none",
              }} />
            ))}
            {hours.flatMap((m) => m + 30 < windowEndMin ? [m + 30] : []).map((m) => (
              <div key={`half-${m}`} style={{
                position: "absolute",
                top: (m - windowStartMin) * PX_PER_MIN,
                left: 0, right: 0,
                borderTop: "1px dashed var(--borderColor-muted, var(--uncon-border-muted, #eef0f3))",
                opacity: 0.5,
                pointerEvents: "none",
              }} />
            ))}

            {layout.map(({ slot, col, cols }) => {
              const isDragged = drag?.slotId === slot.id;
              const startMs = isDragged ? drag!.liveStart : slot.starts_at;
              const endMs   = isDragged ? drag!.liveEnd   : slot.ends_at;
              const topPx = ((startMs - dayMs) / 60000 - windowStartMin) * PX_PER_MIN;
              const heightPx = Math.max(MIN_SLOT_HEIGHT_PX, ((endMs - startMs) / 60000) * PX_PER_MIN);
              const colWidthPct = 100 / cols;
              const leftPct = col * colWidthPct;
              const slotTracks = tracks.filter((t) => t.slot_id === slot.id);
              const slotPlacements = placements.filter((p) => p.slot_id === slot.id);
              const slotMixerPlacements = mixerPlacements.filter((m) => m.slot_id === slot.id);

              return (
                <SlotEvent
                  key={slot.id}
                  slot={slot}
                  topPx={topPx}
                  heightPx={heightPx}
                  leftPct={leftPct}
                  widthPct={colWidthPct}
                  liveStart={startMs}
                  liveEnd={endMs}
                  tracks={slotTracks}
                  placements={slotPlacements}
                  mixerPlacements={slotMixerPlacements}
                  rooms={rooms}
                  subs={subs}
                  isMod={isMod}
                  timeZone={timeZone}
                  selected={selectedSlotId === slot.id}
                  dragging={isDragged}
                  onPointerDownBody={(e) => beginDrag(slot, "move", e)}
                  onPointerDownTop={(e) => beginDrag(slot, "resize-top", e)}
                  onPointerDownBottom={(e) => beginDrag(slot, "resize-bottom", e)}
                  onClick={() => {
                    if (justDraggedRef.current) return;
                    onSelectSlot?.(slot.id);
                  }}
                  onToggleStaticStar={onToggleStaticStar}
                  onToggleSubmissionStar={onToggleSubmissionStar}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
