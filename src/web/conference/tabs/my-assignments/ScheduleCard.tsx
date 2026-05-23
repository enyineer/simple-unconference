import {
  fmtTimeMaybeDay,
  fmtTimeShort,
  spansMultipleDays,
} from "../../helpers";
import type { Room } from "../../types";
import { Pill } from "../../ui/Pill";
import { SOURCE_LABEL, type ScheduleSource } from "./types";

export function ScheduleCard({
  title, source, manual, mandatory, isSubmitter,
  expectedAttendance, roomCapacity,
  startsAt, endsAt, room, timeZone,
  alternates, conflicts, onRoomClick, onChangeSession,
}: {
  title: string;
  source: ScheduleSource;
  /** True if the user manually picked this session (vs algorithm placement). */
  manual: boolean;
  /** Static rows: moderator marked this session as required for everyone. */
  mandatory: boolean;
  /** Static rows: true when the viewer is the linked submission's submitter
   *  (so they're speaking, not attending). Drives a "You're speaking" badge
   *  so the row reads correctly. */
  isSubmitter: boolean;
  /** Static rows only: how many people starred the linked submission
   *  (rough attendance estimate). Null for non-static sources. */
  expectedAttendance: number | null;
  /** Static rows only: capacity of the assigned room. Null when not applicable. */
  roomCapacity: number | null;
  startsAt: number;
  endsAt: number;
  room: Room | null | undefined;
  timeZone: string;
  /** Other times the same submission is scheduled. Path C surfaces these so
   *  the user understands sibling/repeat offerings are one session, not many. */
  alternates: { starts_at: number; title: string | null }[];
  /** Titles of other starred rows whose time window overlaps this one.
   *  Empty when there's no conflict. */
  conflicts: string[];
  /** Opens the room info sheet. When omitted the chip is non-interactive. */
  onRoomClick?: (room: Room) => void;
  /** Opens the session-switch picker. Only set for unconference sources. */
  onChangeSession?: () => void;
}) {
  // Soft capacity warning: only shown for non-mandatory planned tracks where
  // more participants starred the session than the room can hold. Advisory
  // only — the assignment algorithm never enforces a hard cap on stars.
  const showCapacityWarning =
    source === "static" && !mandatory
    && expectedAttendance !== null && roomCapacity !== null
    && expectedAttendance > roomCapacity;
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  // Accent stripe per source: unconference = accent (blue), mixer = success
  // (green), expert = done (purple), planned = neutral.
  const accent = source === "unconference"
    ? "var(--borderColor-accent-emphasis, #0969da)"
    : source === "mixer"
      ? "var(--borderColor-success-emphasis, #1a7f37)"
      : source === "expert"
        ? "var(--borderColor-done-emphasis, #8250df)"
        : "var(--borderColor-neutral-emphasis, #6e7781)";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      gap: 16,
      alignItems: "center",
      padding: "12px 16px",
      borderRadius: 8,
      border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
      borderLeft: `4px solid ${accent}`,
      background: "var(--bgColor-default, var(--uncon-bg, transparent))",
    }}>
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start",
        minWidth: 72,
        fontVariantNumeric: "tabular-nums",
      }}>
        <div style={{ fontSize: 18, fontWeight: 600, lineHeight: "22px" }}>
          {fmtTimeShort(startsAt, timeZone)}
        </div>
        <div style={{ fontSize: 12, color: muted, lineHeight: "16px" }}>
          → {fmtTimeShort(endsAt, timeZone)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <div style={{
          fontSize: 15, fontWeight: 600, lineHeight: "20px",
          wordBreak: "break-word",
        }}>
          {title}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <Pill variant={
            source === "unconference" ? "primary"
              : source === "mixer" ? "success"
              : source === "expert" ? "primary"
              : "default"
          }>
            {SOURCE_LABEL[source]}
          </Pill>
          {mandatory && <Pill variant="attention">required</Pill>}
          {manual && <Pill variant="primary">manual pick</Pill>}
          {isSubmitter && <Pill variant="success">you&apos;re speaking</Pill>}
          {showCapacityWarning && (
            <Pill variant="attention">
              room may be crowded ({expectedAttendance}/{roomCapacity})
            </Pill>
          )}
          {conflicts.length > 0 && (
            <Pill variant="attention">
              conflicts with {conflicts[0]}{conflicts.length > 1 ? ` (+${conflicts.length - 1})` : ""}
            </Pill>
          )}
          {onChangeSession && (
            <button
              type="button"
              onClick={onChangeSession}
              style={{
                background: "transparent", border: "none", padding: 0,
                color: "var(--fgColor-accent, #2563eb)",
                fontFamily: "inherit", fontSize: 12,
                cursor: "pointer", textDecoration: "underline",
              }}
            >
              Change session
            </button>
          )}
        </div>
        {alternates.length > 0 && (() => {
          // Path C: same Submission scheduled in multiple offerings (e.g.
          // sibling slots of a series). One star → many rows; this caption
          // tells the user they're the same content so they can decide
          // which one to actually attend.
          //
          // When any alternate sits on a different conference-local day than
          // this row, prefix every alternate with the short day so the user
          // can tell "20:07" tomorrow from "20:07" today.
          const sortedAlts = [...alternates].sort((a, b) => a.starts_at - b.starts_at);
          const multiDay = spansMultipleDays(
            [startsAt, ...sortedAlts.map((a) => a.starts_at)],
            timeZone,
          );
          return (
            <div style={{ fontSize: 12, color: muted }}>
              Same session{alternates.length > 1 ? "s" : ""} also at{" "}
              {sortedAlts.map((alt, i) => (
                <span key={i} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {i > 0 ? ", " : ""}
                  {fmtTimeMaybeDay(alt.starts_at, timeZone, multiDay)}
                </span>
              ))}
            </div>
          );
        })()}
      </div>

      {room && (
        onRoomClick ? (
          <button
            type="button"
            onClick={() => onRoomClick(room)}
            title={`View info for ${room.name}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "2px 10px", borderRadius: 999,
              background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
              color: muted,
              fontSize: 11, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: 0.4,
              whiteSpace: "nowrap",
              border: "1px solid transparent",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--borderColor-default, var(--uncon-border, #d0d7de))";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "transparent";
            }}
          >
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              background: "var(--borderColor-neutral-emphasis, var(--uncon-fg-muted, #6e7781))",
            }} />
            {room.name}
            <span style={{ opacity: 0.55, fontWeight: 400, fontSize: 10 }}>›</span>
          </button>
        ) : (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "2px 10px", borderRadius: 999,
            background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
            color: muted,
            fontSize: 11, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: 0.4,
            whiteSpace: "nowrap",
          }}>
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              background: "var(--borderColor-neutral-emphasis, var(--uncon-fg-muted, #6e7781))",
            }} />
            {room.name}
          </span>
        )
      )}
    </div>
  );
}
