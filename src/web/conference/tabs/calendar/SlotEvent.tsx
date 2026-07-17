import { DragScrollRow } from "../../ui/DragScrollRow";
import { MICRO_MAX_HEIGHT_PX } from "./constants";
import type { CalMixerPlacement, CalPlacement, CalRoom, CalSlot, CalSubmission, CalTrack } from "./types";
import { fmtTime } from "./helpers";
import { speakerLabel } from "../../helpers";
import { SubEventCard } from "./SubEventCard";

// ----- a single slot block on the calendar --------------------------------

export function SlotEvent({
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
          // The "speaker" line is the session's effective presenter(s) —
          // defaults to the submitter, but a mod may have set explicit speakers.
          speakers: sub ? speakerLabel(sub) : null,
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

  // Below MICRO_MAX_HEIGHT_PX there's no room even for the compact sub-event
  // strip — drop into a single-line "micro" variant that shows only the slot
  // label and its time range. Details stay in the click-to-open sheet.
  const micro = heightPx < MICRO_MAX_HEIGHT_PX;
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
        flexDirection: micro || compact ? "row" : "column",
        alignItems: micro || compact ? "center" : undefined,
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

      {micro ? (
        // ---- Micro single-line layout for very short slots (<28 px) ----
        // Only the slot title + time range fit; everything else lives in the
        // click-to-open sheet. NO sub-event strip so a 15 px block stays legible.
        <>
          <div
            onPointerDown={isMod ? onPointerDownBody : undefined}
            style={{
              flex: 1, minWidth: 0,
              padding: "0 8px",
              fontSize: 11, fontWeight: 600,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}
            title={title}
          >
            {title}
          </div>
          <span style={{
            flex: "0 0 auto",
            padding: "0 8px",
            fontSize: 10, color: muted, whiteSpace: "nowrap",
          }}>
            {fmtTime(liveStart, timeZone)}–{fmtTime(liveEnd, timeZone)}
          </span>
        </>
      ) : compact ? (
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
