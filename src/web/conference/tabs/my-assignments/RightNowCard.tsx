// The participant's day-of anchor at the top of the Me tab. A single hero
// card that answers "where am I meant to be right now, and what's next?"
// It's a pure lens over data the tab already loads (assignments + agenda +
// rooms) — no extra fetches. Shown only when a slot is currently running or
// the next slot starts within 12 hours, so it stays out of the way until the
// event is actually near.

import type { MyAssignments, Room, Slot } from "../../types";
import { fmtTimeShort } from "../../helpers";

type AssignmentRow = MyAssignments["assignments"][number];
type PlacementRow = {
  slot_id: number;
  submission_id: number;
  room_id: number;
  attendee_count: number;
  room_capacity: number;
};

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export function RightNowCard({
  slots, assignments, roomById, placements, timeZone, now, onSwitchSession,
}: {
  slots: Slot[];
  assignments: AssignmentRow[];
  roomById: Map<number, Room>;
  /** Unconference placements, used for room-fullness + switch eligibility. */
  placements: PlacementRow[];
  timeZone: string;
  /** Whole-minute "now" from the shared useNow hook. */
  now: number;
  /** Opens the session picker for a running unconference slot. */
  onSwitchSession: (slotId: number) => void;
}) {
  // The slot that contains `now`. Half-open [start, end) so a just-ended slot
  // hands off cleanly to the next.
  const runningSlot = slots.find((s) => s.starts_at <= now && now < s.ends_at) ?? null;
  const nextSlot = slots
    .filter((s) => s.starts_at > now)
    .sort((a, b) => a.starts_at - b.starts_at)[0] ?? null;

  const nextIsSoon = nextSlot !== null && nextSlot.starts_at - now <= TWELVE_HOURS_MS;
  // Nothing running and nothing near — the event isn't happening around now,
  // so the anchor would just be noise. Hide it entirely.
  if (!runningSlot && !nextIsSoon) return null;

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const accent = "var(--fgColor-accent, #2563eb)";

  const assignmentFor = (slotId: number): AssignmentRow | null =>
    assignments.find((a) => a.slot_id === slotId) ?? null;
  const placementFor = (slotId: number, submissionId: number | null): PlacementRow | null =>
    submissionId === null
      ? null
      : placements.find((p) => p.slot_id === slotId && p.submission_id === submissionId) ?? null;

  const runningAssignment = runningSlot ? assignmentFor(runningSlot.id) : null;
  const runningIsUnconf = runningSlot?.type === "unconference";
  const runningHasPlacements =
    runningSlot !== null && placements.some((p) => p.slot_id === runningSlot.id);

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 16,
      padding: 20,
      borderRadius: 12,
      border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
      borderLeft: `4px solid ${accent}`,
      background: "var(--bgColor-accent-muted, rgba(64,132,246,0.06))",
    }}>
      {runningSlot ? (
        <RightNowBlock
          slot={runningSlot}
          assignment={runningAssignment}
          room={runningAssignment?.room_id ? roomById.get(runningAssignment.room_id) ?? null : null}
          placement={placementFor(runningSlot.id, runningAssignment?.submission_id ?? null)}
          timeZone={timeZone}
          canSwitch={runningIsUnconf && runningHasPlacements}
          onSwitch={() => onSwitchSession(runningSlot.id)}
          muted={muted}
          accent={accent}
        />
      ) : (
        // No running slot but the next one is near — lead with "Up next" as the
        // hero so the card still reads as a single confident statement.
        nextSlot && (
          <UpNextBlock
            slot={nextSlot}
            assignment={assignmentFor(nextSlot.id)}
            room={(() => {
              const a = assignmentFor(nextSlot.id);
              return a?.room_id ? roomById.get(a.room_id) ?? null : null;
            })()}
            now={now}
            timeZone={timeZone}
            muted={muted}
            accent={accent}
            hero
          />
        )
      )}

      {/* When something is running, the next slot is a calm one-liner below. */}
      {runningSlot && nextSlot && nextIsSoon && (
        <>
          <div style={{
            height: 1,
            background: "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
          }} />
          <UpNextBlock
            slot={nextSlot}
            assignment={assignmentFor(nextSlot.id)}
            room={(() => {
              const a = assignmentFor(nextSlot.id);
              return a?.room_id ? roomById.get(a.room_id) ?? null : null;
            })()}
            now={now}
            timeZone={timeZone}
            muted={muted}
            accent={accent}
          />
        </>
      )}
    </div>
  );
}

function RightNowBlock({
  slot, assignment, room, placement, timeZone, canSwitch, onSwitch, muted, accent,
}: {
  slot: Slot;
  assignment: AssignmentRow | null;
  room: Room | null;
  placement: { attendee_count: number; room_capacity: number } | null;
  timeZone: string;
  canSwitch: boolean;
  onSwitch: () => void;
  muted: string;
  accent: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Eyebrow accent={accent}>Right now</Eyebrow>
      <div style={{ fontSize: 13, color: muted, fontVariantNumeric: "tabular-nums" }}>
        {fmtTimeShort(slot.starts_at, timeZone)} – {fmtTimeShort(slot.ends_at, timeZone)}
      </div>

      {assignment ? (
        <>
          <div style={{
            fontSize: 22, fontWeight: 700, lineHeight: "28px", wordBreak: "break-word",
          }}>
            {assignment.title ?? "(removed)"}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            {room && <RoomPill name={room.name} />}
            {assignment.is_submitter && (
              <span style={pillStyle(
                "var(--bgColor-success-muted, rgba(31,136,61,0.14))",
                "var(--fgColor-success, #1f883d)",
              )}>
                you host this
              </span>
            )}
            {placement && (
              <span style={{ fontSize: 12, color: muted, fontVariantNumeric: "tabular-nums" }}>
                attendees {placement.attendee_count}/{placement.room_capacity}
              </span>
            )}
          </div>
        </>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>Nothing on your plan this slot</div>
          <div style={{ fontSize: 13, color: muted }}>
            {canSwitch
              ? "Sessions are running now — pick one to join."
              : "A good moment for a coffee, or to explore the agenda."}
          </div>
        </div>
      )}

      {canSwitch && (
        <div>
          <button type="button" onClick={onSwitch} style={switchButtonStyle(accent)}>
            {assignment ? "Switch session" : "Pick a session"}
          </button>
        </div>
      )}
    </div>
  );
}

function UpNextBlock({
  slot, assignment, room, now, timeZone, muted, accent, hero,
}: {
  slot: Slot;
  assignment: AssignmentRow | null;
  room: Room | null;
  now: number;
  timeZone: string;
  muted: string;
  accent: string;
  /** When true this block is the card's lead (nothing running). */
  hero?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: hero ? 10 : 6 }}>
      <Eyebrow accent={accent}>Up next</Eyebrow>
      <div style={{
        fontSize: 13, color: muted, fontVariantNumeric: "tabular-nums",
        display: "flex", flexWrap: "wrap", gap: 6,
      }}>
        <span style={{ fontWeight: 600, color: "var(--fgColor-default, var(--uncon-fg, inherit))" }}>
          {untilLabel(slot.starts_at - now)}
        </span>
        <span>· {fmtTimeShort(slot.starts_at, timeZone)}</span>
      </div>
      {assignment ? (
        <div style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8,
        }}>
          <span style={{
            fontSize: hero ? 20 : 15, fontWeight: hero ? 700 : 600,
            lineHeight: hero ? "26px" : "20px", wordBreak: "break-word",
          }}>
            {assignment.title ?? "(removed)"}
          </span>
          {room && <RoomPill name={room.name} />}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: muted }}>
          {slot.title ?? "Nothing on your plan yet — star sessions to fill it."}
        </div>
      )}
    </div>
  );
}

// Convert a millisecond gap into a calm "in 25 min" / "in 2 h 10 min" label.
function untilLabel(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return "starting now";
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
}

function Eyebrow({ children, accent }: { children: string; accent: string }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, letterSpacing: 0.8,
      textTransform: "uppercase", color: accent,
    }}>
      {children}
    </span>
  );
}

function RoomPill({ name }: { name: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "3px 12px", borderRadius: 999,
      background: "var(--bgColor-default, var(--uncon-bg, #fff))",
      border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
      color: "var(--fgColor-default, var(--uncon-fg, inherit))",
      fontSize: 12, fontWeight: 600,
      whiteSpace: "nowrap",
    }}>
      <span style={{
        display: "inline-block", width: 6, height: 6, borderRadius: "50%",
        background: "var(--borderColor-neutral-emphasis, var(--uncon-fg-muted, #6e7781))",
      }} />
      {name}
    </span>
  );
}

function pillStyle(bg: string, fg: string): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center",
    padding: "2px 10px", borderRadius: 999,
    background: bg, color: fg,
    fontSize: 11, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.4,
    whiteSpace: "nowrap",
  };
}

function switchButtonStyle(accent: string): React.CSSProperties {
  return {
    appearance: "none",
    padding: "6px 14px",
    borderRadius: 999,
    border: `1px solid ${accent}`,
    background: "transparent",
    color: accent,
    fontFamily: "inherit",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  };
}
