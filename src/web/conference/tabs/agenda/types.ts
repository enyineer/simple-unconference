// Shared types and constants extracted from AgendaTab.tsx.

import type { Slot } from "../../types";

export type SlotKind = "normal" | "unconference" | "mixer";

export const SLOT_KIND_LABEL: Record<SlotKind, string> = {
  normal: "Planned",
  unconference: "Unconference",
  mixer: "Mixer",
};

export function slotSheetTitle(s: Slot): string {
  if (s.type === "unconference") return "Unconference slot";
  if (s.type === "mixer") return s.title ?? "Mixer slot";
  return s.title ?? "Planned slot";
}

// Pre-assignment conflict surfaced by `agenda.assign`. Three shapes:
//   - duplicate_room: two pinned sessions compete for the same room.
//   - out_of_scope:   a pinned room isn't in the slot's effective scope.
//   - unsatisfiable_requirements: a top-N session has required room tags
//     that can't be satisfied — either no room in scope carries the tags,
//     or every matching room was already claimed by a higher-priority
//     session in this slot.
export type PreConflict =
  | {
      kind: "duplicate_room" | "out_of_scope";
      room_id: number;
      room_name: string;
      submissions: { id: number; title: string }[];
    }
  | {
      kind: "unsatisfiable_requirements";
      submission: { id: number; title: string };
      required_tags: string[];
      candidate_room_names: string[];
    };

export type ResolveAction =
  | { kind: "keep" }
  | { kind: "skip" }
  | { kind: "move"; roomId: number }
  | { kind: "clear" };
