// Resolves the effective configuration for an AgendaSlot.
//
// An `AgendaSlot` is either:
//   - **Standalone** (`seriesId == null`): its own columns and `SlotRoom` /
//     `SlotSubmission` rows are the source of truth.
//   - **Series member** (`seriesId != null`): the parent `SlotSeries` and
//     its `SeriesRoom` / `SeriesSubmission` rows are the source of truth.
//     The slot's own config columns and join rows are **stale / ignored**;
//     they may be left over from when the slot was standalone or from
//     duplicate-time defaults. Never read them directly.
//
// Per-instance fields (`title`, `description`, `startsAt`, `endsAt`) always
// come from the slot row, even when it belongs to a series.
//
// `type` is treated as immutable across the lifetime of a series: when a
// sibling is created, its `type` column is set to the series's type, and
// neither side exposes a write to change it. SQL filters against
// `agenda_slots.type` therefore remain correct without going through the
// resolver — keep them that way.
//
// Every route that reads any of the resolved fields MUST include
// `SLOT_CONFIG_INCLUDE` on its slot query and pass the result through
// `effectiveSlotConfig`. Direct reads of `slot.unconf*`, `slot.mixerAvoidRepeats`,
// `slot.selectedRooms` or `slot.selectedSubmissions` are a bug for series
// members and will silently return stale data.

import type {
  AgendaSlot,
  SlotSeries,
  SlotRoom,
  SlotSubmission,
  SeriesRoom,
  SeriesSubmission,
} from "@prisma/client";

export type SlotWithConfig = AgendaSlot & {
  series:
    | (SlotSeries & {
        selectedRooms: Pick<SeriesRoom, "roomId">[];
        selectedSubmissions: Pick<SeriesSubmission, "submissionId">[];
      })
    | null;
  selectedRooms: Pick<SlotRoom, "roomId">[];
  selectedSubmissions: Pick<SlotSubmission, "submissionId">[];
};

export interface EffectiveSlotConfig {
  unconfUseAllRooms: boolean;
  unconfUseAllSubmissions: boolean;
  unconfAvoidRepeats: boolean;
  mixerAvoidRepeats: boolean | null;
  // Effective room scope. When `unconfUseAllRooms` is true, this is empty
  // and callers should treat it as "all rooms in the conference."
  roomIds: number[];
  // Effective submission scope. Same emptiness convention as above.
  submissionIds: number[];
  // Series linkage. Null for standalone slots; otherwise carries the series
  // id + sibling-level avoid-repeats toggle for cross-sibling algorithm use.
  series: { id: number; avoidRepeatsAcrossSiblings: boolean } | null;
}

export function effectiveSlotConfig(slot: SlotWithConfig): EffectiveSlotConfig {
  if (slot.series) {
    return {
      unconfUseAllRooms: slot.series.unconfUseAllRooms,
      unconfUseAllSubmissions: slot.series.unconfUseAllSubmissions,
      unconfAvoidRepeats: slot.series.unconfAvoidRepeats,
      mixerAvoidRepeats: slot.series.mixerAvoidRepeats,
      roomIds: slot.series.selectedRooms.map((r) => r.roomId),
      submissionIds: slot.series.selectedSubmissions.map((s) => s.submissionId),
      series: {
        id: slot.series.id,
        avoidRepeatsAcrossSiblings: slot.series.avoidRepeatsAcrossSiblings,
      },
    };
  }
  return {
    unconfUseAllRooms: slot.unconfUseAllRooms,
    unconfUseAllSubmissions: slot.unconfUseAllSubmissions,
    unconfAvoidRepeats: slot.unconfAvoidRepeats,
    mixerAvoidRepeats: slot.mixerAvoidRepeats,
    roomIds: slot.selectedRooms.map((r) => r.roomId),
    submissionIds: slot.selectedSubmissions.map((s) => s.submissionId),
    series: null,
  };
}

export const SLOT_CONFIG_INCLUDE = {
  series: {
    include: {
      selectedRooms: { select: { roomId: true } },
      selectedSubmissions: { select: { submissionId: true } },
    },
  },
  selectedRooms: { select: { roomId: true } },
  selectedSubmissions: { select: { submissionId: true } },
} as const;
