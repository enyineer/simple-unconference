// Shared types and constants extracted from AgendaTab.tsx.

import type { Slot } from "../../types";

export type SlotKind = "normal" | "unconference" | "mixer";

export const SLOT_KIND_LABEL: Record<SlotKind, string> = {
  normal: "Planned",
  unconference: "Unconference",
  mixer: "Mixer",
};

// Shown in the "Add slot" sheet so moderators see exactly what the selected
// slot kind will do before they create it.
export const SLOT_KIND_TIP: Record<SlotKind, string> = {
  normal:
    "Planned slots run a fixed agenda — you pick which published Submission runs in each room. " +
    "Attendees star the underlying Submission (here on the Agenda, or on the Sessions tab) " +
    "to add this offering to their personal schedule. Mark a track as \"required\" to force it onto " +
    "every attendee's schedule regardless of their stars.",
  unconference:
    "Unconference slots are auto-assigned. The algorithm places the most-starred published Submissions " +
    "in your rooms and balances attendees across them based on their stars. " +
    "Star counts come from the same Star button participants click on the Sessions tab and the Agenda — " +
    "one star drives both unconference ranking and planned-track schedule visibility. " +
    "Re-run anytime as people star or unstar.",
  mixer:
    "Mixer slots split every conference member evenly across the rooms you select — no Submissions involved. " +
    'By default mixers are "exclusive": the algorithm tries not to put two participants in the same room across mixers, ' +
    'so repeated "meet each other" slots actually meet new people. Switch a mixer to "fresh shuffle" if you want it ' +
    "to ignore prior mixers. The default is owner-configurable in Settings.",
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
