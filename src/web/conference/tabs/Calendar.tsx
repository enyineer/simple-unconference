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

import { useMemo } from "react";
import type { ReactNode } from "react";
import { DayCalendar } from "./calendar/DayCalendar";
import { startOfDay } from "./calendar/helpers";
import type { CalendarProps, CalSlot } from "./calendar/types";

export type {
  CalMixerPlacement,
  CalPlacement,
  CalRoom,
  CalSlot,
  CalSubmission,
  CalTrack,
} from "./calendar/types";

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

// ----- legend --------------------------------------------------------------

export function CalendarLegend({ children }: { children?: ReactNode }) {
  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 16,
      fontSize: 12, color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
    }}>
      <span><span style={{ display: "inline-block", width: 10, height: 10, marginRight: 6, background: "var(--borderColor-neutral-emphasis, #6e7781)", verticalAlign: "middle" }} /> Planned</span>
      <span><span style={{ display: "inline-block", width: 10, height: 10, marginRight: 6, background: "var(--borderColor-accent-emphasis, #0969da)", verticalAlign: "middle" }} /> Unconference</span>
      <span><span style={{ display: "inline-block", width: 10, height: 10, marginRight: 6, background: "var(--borderColor-success-emphasis, #1a7f37)", verticalAlign: "middle" }} /> Mixer</span>
      {children}
    </div>
  );
}
