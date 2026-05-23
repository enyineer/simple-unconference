import { Button } from "../../../design-system";
import type { Room } from "../../types";
import { useNow } from "../../../useNow";
import { fmtTime } from "./helpers";
import type { ExpertSlot } from "./types";

export function SlotChip({
  slot: s, rooms, canBook, timeZone, isMod, onBook, onCancel,
}: {
  slot: ExpertSlot;
  rooms: Room[];
  canBook: boolean;
  timeZone: string;
  isMod: boolean;
  onBook: () => void;
  onCancel: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const now = useNow();
  const isPast = s.starts_at <= now;
  const isBooked = s.booking_id !== null;

  const bg = s.is_mine
    ? "var(--bgColor-success-muted, rgba(46,160,67,0.10))"
    : isBooked
      ? "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.04)))"
      : "var(--bgColor-default, var(--uncon-bg, transparent))";
  const border = s.is_mine
    ? "1px solid var(--borderColor-success-muted, rgba(46,160,67,0.4))"
    : "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";

  return (
    <div style={{
      padding: 8, borderRadius: 6, border, background: bg,
      display: "flex", flexDirection: "column", gap: 4,
      opacity: isPast && !s.is_mine ? 0.5 : 1,
    }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>
        {fmtTime(s.starts_at, timeZone)} – {fmtTime(s.ends_at, timeZone)}
      </div>
      {isBooked ? (
        <>
          <div style={{ fontSize: 11, color: muted }}>
            {s.is_mine
              ? "You — "
              : isMod
                ? `${s.booker_name || s.booker_email || "Booked"} — `
                : "Booked"}
            {s.room_id !== null && (
              <span>{rooms.find((r) => r.id === s.room_id)?.name ?? "room"}</span>
            )}
          </div>
          {(s.is_mine || isMod) && !isPast && (
            <Button size="small" variant="invisible" onClick={onCancel}>Cancel</Button>
          )}
        </>
      ) : isPast ? (
        <div style={{ fontSize: 11, color: muted }}>Past</div>
      ) : (
        <Button
          size="small"
          variant="primary"
          disabled={!canBook}
          onClick={onBook}
        >
          Book
        </Button>
      )}
    </div>
  );
}
