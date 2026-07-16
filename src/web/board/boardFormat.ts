// Formatting helpers for the board, all in the CONFERENCE timezone (the board
// is projected at the venue, so times must read in local venue time no matter
// where the browser is). `Intl.DateTimeFormat` with an explicit `timeZone`
// keeps that correct without pulling in a date lib.

import type { BoardSlotOut } from "../../shared/contract/types";

export function makeTimeFmt(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  });
}

export function makeClockFmt(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: timezone,
  });
}

// Short timezone label ("CEST", "PDT") for the clock caption.
export function timezoneLabel(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timezone;
  } catch {
    return timezone;
  }
}

export function formatSlotRange(slot: BoardSlotOut, fmt: Intl.DateTimeFormat): string {
  return `${fmt.format(slot.starts_at)} – ${fmt.format(slot.ends_at)}`;
}

export type SlotKindMeta = { label: string; cellClass: string; colorVar: string };

export function slotKindMeta(type: BoardSlotOut["type"]): SlotKindMeta {
  switch (type) {
    case "unconference":
      return { label: "Unconference", cellClass: "kind-unconf", colorVar: "var(--bd-unconf)" };
    case "mixer":
      return { label: "Mixer", cellClass: "kind-mixer", colorVar: "var(--bd-mixer)" };
    default:
      return { label: "Planned", cellClass: "kind-planned", colorVar: "var(--bd-planned)" };
  }
}

export function isSlotNow(slot: BoardSlotOut, now: number): boolean {
  return now >= slot.starts_at && now < slot.ends_at;
}
