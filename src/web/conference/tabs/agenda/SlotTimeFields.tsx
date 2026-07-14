import { DateTime } from "../../../design-system";
import {
  LONG_SLOT_MS,
  SLOT_TIMES_ERROR,
  formatDuration,
  slotTimesValid,
} from "./slotTimes";

// Shared start/end pickers for the slot forms (new / edit / duplicate).
//
// Deliberately NO cross min/max between the two inputs: the native constraint
// made it impossible to move the start into the future without first moving
// the end (and vice versa). Instead an invalid order surfaces as an inline
// error on the end field, and the owning form disables its submit button via
// `slotTimesValid`. The server + shared schema still enforce the same rule.
export function SlotTimeFields({
  startsAt,
  endsAt,
  onStartsAtChange,
  onEndsAtChange,
  timeZone,
}: {
  startsAt: number;
  endsAt: number;
  onStartsAtChange: (ms: number) => void;
  onEndsAtChange: (ms: number) => void;
  timeZone: string;
}) {
  const valid = slotTimesValid(startsAt, endsAt);
  const durationMs = endsAt - startsAt;
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const attention = "var(--fgColor-attention, var(--uncon-fg-attention, #9a6700))";

  return (
    <>
      <DateTime
        label="Starts at"
        value={startsAt}
        onChange={onStartsAtChange}
        timeZone={timeZone}
      />
      <DateTime
        label="Ends at"
        value={endsAt}
        onChange={onEndsAtChange}
        timeZone={timeZone}
        error={valid ? undefined : SLOT_TIMES_ERROR}
      />
      {valid && (
        <span style={{ fontSize: 12, color: muted }}>
          Duration: <strong>{formatDuration(durationMs)}</strong>
          {durationMs >= LONG_SLOT_MS && (
            <span style={{ display: "block", color: attention, marginTop: 2 }}>
              That&apos;s unusually long. A slot is one block on the agenda - a
              talks round, a mixer, lunch - not the whole day. Build a full day
              out of several slots.
            </span>
          )}
        </span>
      )}
    </>
  );
}
