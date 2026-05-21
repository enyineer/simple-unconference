// Outlook-style calendar.
//
// Vertical time axis per day. Slots positioned absolutely by start/end and
// laid out *side-by-side* when they overlap. Inside each slot, the tracks
// (static) or placements (unconference) render as side-by-side sub-columns
// so a multi-track keynote is immediately legible.
//
// Moderators can:
//   - drag the slot body to move it (start + end shift together)
//   - drag the top/bottom edge to resize, snapping to 15 min
// Attendees (and moderators) can star a static track right in the calendar.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { formatInTz, instantToWallClock, wallClockToInstant } from "../../../shared/tz";
import { DragScrollRow } from "../ui/DragScrollRow";

// ----- data shapes the calendar needs --------------------------------------

export interface CalSlot {
  id: number;
  type: "normal" | "unconference" | "mixer";
  title: string | null;
  starts_at: number;
  ends_at: number;
}
export interface CalMixerPlacement {
  slot_id: number;
  room_id: number;
  attendee_count: number;
}
export interface CalTrack {
  id: number; slot_id: number; room_id: number;
  submission_id: number | null;
  title: string | null;
  speakers: string | null;
  star_count: number;
  starred_by_me: boolean;
  /** Moderator-marked "required for everyone" — render a Required badge in
   * place of the star toggle. */
  mandatory: boolean;
}
export interface CalPlacement {
  slot_id: number; submission_id: number; room_id: number;
}
export interface CalRoom { id: number; name: string; capacity: number; }
export interface CalSubmission {
  id: number;
  title: string;
  submitter_name: string | null;
  star_count: number;
  starred_by_me: boolean;
}

interface CalendarProps {
  slots: CalSlot[];
  tracks: CalTrack[];
  placements: CalPlacement[];
  mixerPlacements: CalMixerPlacement[];
  rooms: CalRoom[];
  subs: CalSubmission[];
  isMod: boolean;
  /** IANA timezone the calendar's wall-clock times are in. */
  timeZone: string;
  /** Selected slot id (shown highlighted). */
  selectedSlotId?: number | null;
  /** Called when a slot is clicked. */
  onSelectSlot?: (id: number) => void;
  /** Called when a slot is dragged or resized — receives new times in ms. */
  onMoveSlot: (id: number, starts_at: number, ends_at: number) => Promise<void>;
  /** Star/unstar a static track. If omitted, star buttons are hidden. */
  onToggleStaticStar?: (track: CalTrack) => Promise<void>;
  /** Star/unstar a submission (unconference placements). */
  onToggleSubmissionStar?: (sub: CalSubmission) => Promise<void>;
}

const PX_PER_MIN = 1;          // 60 px per hour
const SNAP_MIN = 15;           // snap drags to 15 minutes
const AXIS_WIDTH = 56;
const HEADER_BORDER_RADIUS = 6;
const MIN_SLOT_COL_WIDTH = 200;   // min width of a slot column (mobile-friendly)
const MIN_TRACK_SUBCOL_WIDTH = 140; // min width of a track sub-column inside a slot

// ----- time helpers --------------------------------------------------------

// `startOfDay` / `endOfDay` operate **in the conference timezone**, not the
// viewer's local. Two slots scheduled "the same conference day" might span
// different UTC days from another locale, so we resolve via the wall clock.
function startOfDay(ms: number, timeZone: string): number {
  const wall = instantToWallClock(ms, timeZone); // "YYYY-MM-DDTHH:MM"
  const datePart = wall.slice(0, 10); // YYYY-MM-DD
  // wallClockToInstant inverts back precisely: local midnight in `timeZone`
  // → the corresponding absolute ms.
  return wallClockToInstant(`${datePart}T00:00`, timeZone);
}
function endOfDay(ms: number, timeZone: string): number {
  return startOfDay(ms, timeZone) + 24 * 60 * 60 * 1000;
}
function snapToMinutes(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}
function fmtTime(ms: number, timeZone: string): string {
  return formatInTz(ms, timeZone, { hour: "2-digit", minute: "2-digit" });
}

// ----- overlap layout ------------------------------------------------------

// For each slot, decide which sub-column index it gets within its overlap
// cluster, and how many sub-columns the cluster has total.
interface SlotLayout {
  slot: CalSlot;
  col: number;
  cols: number;
}
function layoutSlots(slots: CalSlot[]): SlotLayout[] {
  const sorted = [...slots].sort((a, b) => a.starts_at - b.starts_at);
  const out: SlotLayout[] = [];

  let cluster: { slot: CalSlot; col: number }[] = [];
  let clusterEnd = -Infinity;
  let colEnds: number[] = []; // colEnds[i] = latest end of slots placed in col i (within cluster)

  const flush = () => {
    const cols = Math.max(1, colEnds.length);
    for (const c of cluster) out.push({ slot: c.slot, col: c.col, cols });
    cluster = [];
    colEnds = [];
    clusterEnd = -Infinity;
  };

  for (const s of sorted) {
    if (s.starts_at >= clusterEnd) flush();
    // pick the first column whose last slot ended by the time this one starts
    let col = colEnds.findIndex((end) => end <= s.starts_at);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(s.ends_at);
    } else {
      colEnds[col] = s.ends_at;
    }
    cluster.push({ slot: s, col });
    clusterEnd = Math.max(clusterEnd, s.ends_at);
  }
  flush();
  return out;
}

// Group slots by day (in the conference's timezone); for each day pick a
// visible window snapping to the hour before the first slot and after the last.
function buildDays(slots: CalSlot[], timeZone: string): {
  dayMs: number; windowStartMin: number; windowEndMin: number; slots: CalSlot[];
}[] {
  if (slots.length === 0) return [];
  const groups = new Map<number, CalSlot[]>();
  for (const s of slots) {
    const d = startOfDay(s.starts_at, timeZone);
    const arr = groups.get(d) ?? [];
    arr.push(s);
    groups.set(d, arr);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayMs, daySlots]) => {
      let minStart = Number.POSITIVE_INFINITY;
      let maxEnd = Number.NEGATIVE_INFINITY;
      for (const s of daySlots) {
        const startMin = (s.starts_at - dayMs) / 60000;
        const endMin = (s.ends_at - dayMs) / 60000;
        if (startMin < minStart) minStart = startMin;
        if (endMin > maxEnd) maxEnd = endMin;
      }
      const windowStartMin = Math.max(0, Math.floor(minStart / 60) * 60 - 60);
      const windowEndMin = Math.min(24 * 60, Math.ceil(maxEnd / 60) * 60 + 60);
      return { dayMs, windowStartMin, windowEndMin, slots: daySlots };
    });
}

export function Calendar(props: CalendarProps) {
  const days = useMemo(() => buildDays(props.slots, props.timeZone), [props.slots, props.timeZone]);

  if (props.slots.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {days.map((d) => (
        <DayCalendar
          key={d.dayMs}
          dayMs={d.dayMs}
          windowStartMin={d.windowStartMin}
          windowEndMin={d.windowEndMin}
          slots={d.slots}
          tracks={props.tracks}
          placements={props.placements}
          mixerPlacements={props.mixerPlacements}
          rooms={props.rooms}
          subs={props.subs}
          isMod={props.isMod}
          timeZone={props.timeZone}
          selectedSlotId={props.selectedSlotId ?? null}
          onSelectSlot={props.onSelectSlot}
          onMoveSlot={props.onMoveSlot}
          onToggleStaticStar={props.onToggleStaticStar}
          onToggleSubmissionStar={props.onToggleSubmissionStar}
        />
      ))}
    </div>
  );
}

// ----- one day -------------------------------------------------------------

interface DragState {
  slotId: number;
  mode: "move" | "resize-top" | "resize-bottom";
  startY: number;
  origStart: number;
  origEnd: number;
  liveStart: number;
  liveEnd: number;
}

function DayCalendar({
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
              const heightPx = Math.max(28, ((endMs - startMs) / 60000) * PX_PER_MIN);
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

// ----- a single slot block on the calendar --------------------------------

function SlotEvent({
  slot, topPx, heightPx, leftPct, widthPct, liveStart, liveEnd,
  tracks, placements, mixerPlacements, rooms, subs,
  isMod, timeZone, selected, dragging,
  onPointerDownBody, onPointerDownTop, onPointerDownBottom, onClick,
  onToggleStaticStar, onToggleSubmissionStar,
}: {
  slot: CalSlot;
  topPx: number; heightPx: number;
  leftPct: number; widthPct: number;
  liveStart: number; liveEnd: number;
  tracks: CalTrack[];
  placements: CalPlacement[];
  mixerPlacements: CalMixerPlacement[];
  rooms: CalRoom[];
  subs: CalSubmission[];
  isMod: boolean;
  timeZone: string;
  selected: boolean;
  dragging: boolean;
  onPointerDownBody: (e: React.PointerEvent) => void;
  onPointerDownTop: (e: React.PointerEvent) => void;
  onPointerDownBottom: (e: React.PointerEvent) => void;
  onClick: () => void;
  onToggleStaticStar?: (track: CalTrack) => Promise<void>;
  onToggleSubmissionStar?: (sub: CalSubmission) => Promise<void>;
}) {
  const isUnconf = slot.type === "unconference";
  const isMixer = slot.type === "mixer";
  const title = slot.title ?? (isUnconf ? "Unconference" : isMixer ? "Mixer" : "Planned slot");
  const cardBg = isUnconf
    ? "var(--bgColor-accent-muted, rgba(64, 132, 246, 0.12))"
    : isMixer
      ? "var(--bgColor-success-muted, rgba(26,127,55,0.12))"
      : "var(--bgColor-muted, rgba(0, 0, 0, 0.04))";
  const accent = isUnconf
    ? "var(--borderColor-accent-emphasis, #0969da)"
    : isMixer
      ? "var(--borderColor-success-emphasis, #1a7f37)"
      : "var(--borderColor-neutral-emphasis, #6e7781)";
  const borderColor = selected
    ? "var(--borderColor-accent-emphasis, #0969da)"
    : "var(--borderColor-default, rgba(0, 0, 0, 0.15))";

  const subById = new Map(subs.map((s) => [s.id, s]));
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  // Build the list of "sub-events" to render side-by-side. For static slots
  // that's one card per track (one per room). For unconference slots that's
  // one card per placement after assignment.
  //
  // The `star` field unifies the two kinds of stars: StaticStar for tracks
  // (set/added by attendees to attend a specific talk) and Star for
  // submissions (used by the assignment algorithm). Both render the same
  // pill in the calendar.
  type StarInfo = {
    count: number;
    starredByMe: boolean;
    toggle: () => Promise<void>;
    /** When true, render a static "Required" badge instead of the toggle. */
    required?: boolean;
  };
  type SubEvent = {
    key: string;
    roomName: string;
    title: string | null;
    speakers: string | null;
    star: StarInfo | null;
  };
  const subEvents: SubEvent[] = isUnconf
    ? placements.map((p) => {
        const sub = subById.get(p.submission_id);
        const room = roomById.get(p.room_id);
        return {
          key: `p-${p.submission_id}`,
          roomName: room?.name ?? "?",
          title: sub?.title ?? `#${p.submission_id}`,
          // For unconference placements the "speaker" is the proposer of the
          // submission — that's the user the room is hosting.
          speakers: sub?.submitter_name ?? null,
          star: sub && onToggleSubmissionStar
            ? {
                count: sub.star_count,
                starredByMe: sub.starred_by_me,
                toggle: () => onToggleSubmissionStar(sub),
              }
            : sub
              ? { count: sub.star_count, starredByMe: sub.starred_by_me, toggle: async () => {} }
              : null,
        };
      })
    : isMixer
      ? mixerPlacements.map((m) => {
          const room = roomById.get(m.room_id);
          return {
            key: `m-${m.room_id}`,
            roomName: room?.name ?? "?",
            title: room ? `${room.name}` : `Room #${m.room_id}`,
            // For mixer slots the "speaker" line is an attendee headcount.
            speakers: `${m.attendee_count} attendee${m.attendee_count === 1 ? "" : "s"}`,
            star: null,
          };
        })
      : tracks.map((t) => {
          const room = roomById.get(t.room_id);
          const titleStr = t.submission_id
            ? (subById.get(t.submission_id)?.title ?? `#${t.submission_id}`)
            : (t.title ?? null);
          return {
            key: `t-${t.id}`,
            roomName: room?.name ?? "?",
            title: titleStr,
            speakers: t.speakers,
            star: onToggleStaticStar
              ? {
                  count: t.star_count,
                  starredByMe: t.starred_by_me,
                  toggle: () => onToggleStaticStar(t),
                  required: t.mandatory,
                }
              : { count: t.star_count, starredByMe: t.starred_by_me, toggle: async () => {}, required: t.mandatory },
          };
        });

  // For slots shorter than ~44 px we can't afford a separate header row
  // (the header alone is ~20 px and the body needs ~18 px to show anything).
  // Drop into a "compact" mode that puts the slot label, sub-events, and
  // time on a single horizontal row.
  const compact = heightPx < 44;
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  return (
    <div
      onClick={onClick}
      style={{
        position: "absolute",
        top: topPx, height: heightPx,
        left: `calc(${leftPct}% + 4px)`,
        width: `calc(${widthPct}% - 8px)`,
        background: cardBg,
        border: `1px solid ${borderColor}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: 6,
        boxShadow: selected ? "0 0 0 1px var(--borderColor-accent-emphasis, #0969da)" : undefined,
        opacity: dragging ? 0.85 : 1,
        cursor: isMod ? "grab" : "pointer",
        display: "flex",
        flexDirection: compact ? "row" : "column",
        alignItems: compact ? "center" : undefined,
        overflow: "hidden",
      }}
    >
      {/* top resize handle */}
      {isMod && (
        <div
          onPointerDown={onPointerDownTop}
          style={{
            position: "absolute", top: 0, left: 0, right: 0, height: 6,
            cursor: "ns-resize", zIndex: 2,
          }}
          title="Drag to change start time"
        />
      )}

      {compact ? (
        // ---- Compact single-row layout for short slots ----
        // Header label (title) on the left, sub-events in the middle, time
        // on the right — everything on one row.
        <>
          <div
            onPointerDown={isMod ? onPointerDownBody : undefined}
            style={{
              padding: "0 8px",
              fontSize: 12, fontWeight: 600,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              flex: "0 0 auto", maxWidth: "30%",
              borderRight: `1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))`,
              alignSelf: "stretch",
              display: "flex", alignItems: "center",
              background: "rgba(0,0,0,0.06)",
            }}
            title={title}
          >
            {title}
          </div>
          <DragScrollRow
            style={{
              flex: 1, minWidth: 0,
              display: "flex", flexDirection: "row",
              gap: 4, padding: 3,
              overflowX: "auto", overflowY: "hidden",
              alignItems: "stretch",
            }}
          >
            {subEvents.length === 0 ? (
              <div
                onClick={onClick}
                style={{
                  flex: 1, display: "flex", alignItems: "center",
                  color: muted, fontSize: 11, paddingLeft: 4,
                  cursor: "pointer",
                }}
              >
                {isUnconf || isMixer ? "Not assigned yet" : "No tracks"}
              </div>
            ) : (
              subEvents.map((ev) => (
                <SubEventCard
                  key={ev.key}
                  roomName={ev.roomName}
                  title={ev.title}
                  speakers={ev.speakers}
                  star={ev.star}
                  cardHeight={heightPx}
                  onClick={onClick}
                />
              ))
            )}
          </DragScrollRow>
          <span style={{
            flex: "0 0 auto",
            padding: "0 8px",
            fontSize: 10, color: muted, whiteSpace: "nowrap",
          }}>
            {fmtTime(liveStart, timeZone)}–{fmtTime(liveEnd, timeZone)}
          </span>
        </>
      ) : (
        // ---- Tall slot: separate header + sub-events area ----
        <>
          <div
            onPointerDown={isMod ? onPointerDownBody : undefined}
            style={{
              padding: "3px 8px",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              gap: 8, flex: "0 0 auto",
              background: "rgba(0,0,0,0.06)",
              minHeight: 20,
            }}
          >
            <strong style={{ fontSize: 12, lineHeight: "16px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {title}
            </strong>
            <span style={{
              fontSize: 10, color: muted,
              whiteSpace: "nowrap",
            }}>
              {fmtTime(liveStart, timeZone)}–{fmtTime(liveEnd, timeZone)}
            </span>
          </div>

          <DragScrollRow
            style={{
              flex: 1,
              display: "flex", flexDirection: "row",
              gap: 4, padding: 3,
              overflowX: "auto", overflowY: "hidden",
              alignItems: "stretch",
              minHeight: 0,
            }}
          >
            {subEvents.length === 0 ? (
              <div
                onClick={onClick}
                style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                  color: muted, fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {isUnconf || isMixer ? "Not assigned yet" : "No tracks"}
              </div>
            ) : (
              subEvents.map((ev) => (
                <SubEventCard
                  key={ev.key}
                  roomName={ev.roomName}
                  title={ev.title}
                  speakers={ev.speakers}
                  star={ev.star}
                  cardHeight={heightPx}
                  onClick={onClick}
                />
              ))
            )}
          </DragScrollRow>
        </>
      )}

      {/* bottom resize handle */}
      {isMod && (
        <div
          onPointerDown={onPointerDownBottom}
          style={{
            position: "absolute", bottom: 0, left: 0, right: 0, height: 6,
            cursor: "ns-resize", zIndex: 2,
          }}
          title="Drag to change end time"
        />
      )}
    </div>
  );
}

function SubEventCard({
  roomName, title, speakers, star, onClick,
}: {
  roomName: string;
  title: string | null;
  speakers: string | null;
  /** Star indicator + toggle. Same shape for static and unconference;
   *  `toggle` is a no-op when the parent didn't pass a callback. */
  star: {
    count: number;
    starredByMe: boolean;
    toggle: () => Promise<void>;
    /** When true, render a non-interactive "Required" badge in place of the
     *  toggle (mandatory static tracks). */
    required?: boolean;
  } | null;
  cardHeight: number; // kept for API compat; layout is now single-line
  onClick: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  // Everything fits on a single row: title (bold) · speakers (muted) · room
  // (muted) · star (right edge, if it's a starrable static track). Each
  // segment is its own flex child with `min-width: 0` so any of them can
  // ellipsis when the column is narrow — the title gets priority because it
  // grows fastest (`flex: 2 1 …`) while speakers/room shrink first.

  const tip = [title, speakers, roomName].filter(Boolean).join(" · ");

  return (
    <div
      onClick={onClick}
      title={tip}
      style={{
        flex: "1 0 auto",
        minWidth: MIN_TRACK_SUBCOL_WIDTH,
        maxWidth: "100%",
        background: "var(--bgColor-default, var(--uncon-bg, #fff))",
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        borderRadius: 4,
        padding: "2px 6px",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        lineHeight: "14px",
        overflow: "hidden",
        cursor: "pointer",
        // The card is one line tall regardless of slot height — that keeps
        // multi-track slots compact and avoids the previous overlap problem.
        height: 20,
      }}
    >
      {/* Title — the only element that grows. Anything else takes its own
          content width (and shrinks via ellipsis when the column is narrow),
          which keeps title-speakers-room visually adjacent instead of having
          a big void between the title and the room label. */}
      <strong
        style={{
          flex: "1 1 0", minWidth: 0,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
      >
        {title && title.length > 0
          ? title
          : <span style={{ color: muted, fontStyle: "italic", fontWeight: 400 }}>(no talk)</span>}
      </strong>

      {/* speakers — muted; content width, shrinkable */}
      {speakers && (
        <span
          style={{
            flex: "0 1 auto", minWidth: 0,
            color: muted, fontSize: 10,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {speakers}
        </span>
      )}

      {/* room — small muted suffix with a dot marker so it reads as metadata */}
      <span
        style={{
          flex: "0 1 auto", minWidth: 0,
          color: muted, fontSize: 10,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        <span style={{
          display: "inline-block", width: 5, height: 5,
          borderRadius: "50%",
          background: "var(--borderColor-neutral-emphasis, var(--uncon-fg-muted, #6e7781))",
          flex: "0 0 auto",
        }} />
        {roomName}
      </span>

      {/* Star — same pill for static tracks and unconference submissions.
          Mandatory tracks render a non-interactive Required badge instead. */}
      {star && star.required && (
        <span
          title="Required — every participant is auto-attending."
          style={{
            flex: "0 0 auto",
            border: "1px solid var(--borderColor-attention-emphasis, #d4a72c)",
            background: "var(--bgColor-attention-muted, rgba(212,167,44,0.18))",
            color: "var(--fgColor-attention, #9a6700)",
            borderRadius: 10,
            padding: "0 6px",
            fontSize: 10,
            lineHeight: "14px",
            fontWeight: 600,
          }}
        >
          ★ Required
        </span>
      )}
      {star && !star.required && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void star.toggle(); }}
          style={{
            flex: "0 0 auto",
            border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
            background: star.starredByMe
              ? "var(--bgColor-accent-muted, var(--uncon-primary, #2563eb))"
              : "transparent",
            color: star.starredByMe
              ? "var(--fgColor-onEmphasis, white)"
              : "var(--fgColor-default, inherit)",
            borderRadius: 10,
            padding: "0 6px",
            fontSize: 10,
            lineHeight: "14px",
            cursor: "pointer",
          }}
          title={star.starredByMe ? "Unstar" : "Star this talk"}
        >
          {star.starredByMe ? "★" : "☆"} {star.count}
        </button>
      )}
    </div>
  );
}

// ----- now indicator -------------------------------------------------------

// A themed horizontal bar at the current time, visible only when the day
// being rendered is today. Ticks every minute so it slides down the column.
function NowIndicator({
  dayMs, windowStartMin, windowEndMin, timeZone,
}: { dayMs: number; windowStartMin: number; windowEndMin: number; timeZone: string }) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    // Align ticks to the next whole minute so the bar moves predictably.
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    let interval: ReturnType<typeof setInterval> | null = null;
    const timeout = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 60_000);
    }, msToNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  // Only show on today's column (where "today" is *in the conference TZ*).
  if (startOfDay(now, timeZone) !== dayMs) return null;

  const nowMin = (now - dayMs) / 60_000;
  if (nowMin < windowStartMin || nowMin > windowEndMin) return null;

  const topPx = (nowMin - windowStartMin) * PX_PER_MIN;

  return (
    <div
      aria-label="Current time"
      style={{
        position: "absolute",
        left: 0, right: 0,
        top: topPx,
        height: 0,
        borderTop: "2px solid var(--fgColor-danger, var(--uncon-danger, #d1242f))",
        zIndex: 4,
        pointerEvents: "none",
      }}
    >
      {/* round nub on the left edge */}
      <div
        style={{
          position: "absolute",
          left: -5, top: -6,
          width: 10, height: 10,
          borderRadius: "50%",
          background: "var(--fgColor-danger, var(--uncon-danger, #d1242f))",
        }}
      />
      {/* time label */}
      <div
        style={{
          position: "absolute",
          right: 4, top: -18,
          fontSize: 10, fontWeight: 600,
          padding: "1px 6px",
          borderRadius: 10,
          background: "var(--fgColor-danger, var(--uncon-danger, #d1242f))",
          color: "var(--fgColor-onEmphasis, #fff)",
          whiteSpace: "nowrap",
        }}
      >
        {fmtTime(now, timeZone)}
      </div>
    </div>
  );
}

// ----- legend --------------------------------------------------------------

export function CalendarLegend({ children }: { children?: ReactNode }) {
  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 16,
      fontSize: 12, color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
    }}>
      <span><span style={{ display: "inline-block", width: 10, height: 10, marginRight: 6, background: "var(--borderColor-accent-emphasis, #0969da)", verticalAlign: "middle" }} /> unconference</span>
      <span><span style={{ display: "inline-block", width: 10, height: 10, marginRight: 6, background: "var(--borderColor-success-emphasis, #1a7f37)", verticalAlign: "middle" }} /> mixer</span>
      <span><span style={{ display: "inline-block", width: 10, height: 10, marginRight: 6, background: "var(--borderColor-neutral-emphasis, #6e7781)", verticalAlign: "middle" }} /> planned</span>
      {children}
    </div>
  );
}
