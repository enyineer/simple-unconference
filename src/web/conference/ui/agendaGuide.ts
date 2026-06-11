// Single source of truth for the plain-language copy that teaches moderators
// how the agenda + assignment works. Tips, the slot-type chooser, the help
// modal, empty states, and the onboarding checklist all import from here so
// the wording (and the terminology) never drifts between surfaces.
//
// Terminology decisions baked into this copy:
//   - "session"  — the user-facing word for a talk/proposal. The data model
//     calls it a "submission"; the UI should always say "session".
//   - "slot"     — a time block on the agenda.
//   - "track"    — one session scheduled into one room inside a Planned slot.
//   - "place"    — putting a session into a slot+room on an unconference slot.
//   - "star"     — "add to my schedule + signal interest".

import type { SlotKind } from "../tabs/agenda/types";

export interface SlotTypeGuide {
  key: SlotKind;
  label: string;
  /** One-line "what it is". */
  tagline: string;
  /** One-line "use it when…". */
  whenToUse: string;
  /** Emoji glyph for the chooser card (kept simple + theme-agnostic). */
  glyph: string;
  /** CSS var driving the accent, matched to the calendar legend colors. */
  accentVar: string;
}

// Ordered simplest → most advanced, so the chooser reads top-to-bottom from
// "I know exactly what runs" to "let attendees decide".
export const SLOT_TYPE_GUIDES: SlotTypeGuide[] = [
  {
    key: "normal",
    label: "Planned",
    tagline: "You schedule each session into a room yourself.",
    whenToUse: "Use for keynotes, talks, and any fixed program you control.",
    glyph: "📋",
    accentVar: "var(--fgColor-done, #8250df)",
  },
  {
    key: "unconference",
    label: "Unconference",
    tagline: "Attendees star sessions; the app fills the rooms and seats people.",
    whenToUse: "Use when the crowd decides what runs and you want auto-assignment.",
    glyph: "✨",
    accentVar: "var(--fgColor-accent, #2563eb)",
  },
  {
    key: "mixer",
    label: "Mixer",
    tagline: "Everyone is shuffled evenly across rooms to meet new people.",
    whenToUse: "Use for networking, lunch tables, or icebreaker breaks.",
    glyph: "🔀",
    accentVar: "var(--fgColor-success, #1a7f37)",
  },
];

export const SLOT_TYPE_GUIDE_BY_KEY: Record<SlotKind, SlotTypeGuide> =
  // `Object.fromEntries` widens its key type to `string`; the cast restores the
  // known `SlotKind` keys (every SlotKind has exactly one guide above).
  Object.fromEntries(SLOT_TYPE_GUIDES.map((g) => [g.key, g])) as Record<SlotKind, SlotTypeGuide>;

// Longer behavioral description shown once a type is chosen (replaces the old
// SLOT_KIND_TIP strings). Kept to 2 short sentences each.
export const SLOT_TYPE_DETAIL: Record<SlotKind, string> = {
  normal:
    "You pick which session runs in each room. Attendees star a session to add it to their " +
    "schedule; mark one \"required\" to put it on everyone's schedule (keynotes, opening, closing).",
  unconference:
    "The app ranks sessions by how many people starred them, places the top ones into your rooms, " +
    "and seats each attendee in one of their starred sessions. Re-run anytime as stars change.",
  mixer:
    "No sessions — everyone is split evenly across the rooms you pick. \"Exclusive\" avoids re-pairing " +
    "people across mixers; \"fresh shuffle\" ignores past mixers. The default is set in Settings.",
};

// The 4-step path from a brand-new conference to a working agenda. Drives the
// onboarding checklist and the "Start here" block in the help modal.
export interface BuildStep {
  key: "rooms" | "sessions" | "slots" | "assign";
  title: string;
  blurb: string;
}

export const BUILD_STEPS: BuildStep[] = [
  {
    key: "rooms",
    title: "Add your rooms",
    blurb: "Rooms are the spaces sessions run in. Their capacity drives auto-assignment.",
  },
  {
    key: "sessions",
    title: "Add & publish sessions",
    blurb: "Create sessions (or let attendees submit them). Only published sessions can be scheduled or starred.",
  },
  {
    key: "slots",
    title: "Build your agenda",
    blurb: "Add time slots to the day. Each slot is Planned, Unconference, or Mixer.",
  },
  {
    key: "assign",
    title: "Place your sessions",
    blurb: "On each unconference slot, place sessions into rooms (or auto-fill from stars). Then seat everyone with the Assign panel.",
  },
];

// The two-step framing for unconference assignment, used by the agenda header
// and the help modal so the mod always sees the same model.
export const ASSIGN_STEPS = {
  place: {
    title: "1 · Place sessions",
    blurb:
      "Decide which session runs in which room, on each unconference slot. Place the same session " +
      "on more than one slot to make it recurring. (You can also let a single slot auto-fill from stars.)",
  },
  assign: {
    title: "2 · Assign attendees",
    blurb:
      "Seat everyone across all unconference slots at once. Recurring sessions are split evenly across " +
      "their times, and the app avoids double-booking. Your manual placements and people's own picks are kept.",
  },
} as const;

// Plain-language glossary. Surfaced in the help modal and reusable as tooltip
// copy. Definitions are deliberately one sentence.
export interface GlossaryTerm {
  term: string;
  definition: string;
}

export const GLOSSARY: GlossaryTerm[] = [
  { term: "Slot", definition: "A block of time on the agenda. Every slot is one of three types: Planned, Unconference, or Mixer." },
  { term: "Session", definition: "A talk or topic someone proposes. Attendees star sessions; moderators schedule or place them." },
  { term: "Planned slot", definition: "A slot where you, the moderator, hand-pick which session runs in each room." },
  { term: "Unconference slot", definition: "A slot where sessions are ranked by stars and the app auto-assigns rooms and attendees." },
  { term: "Mixer slot", definition: "A slot with no sessions — everyone is shuffled evenly across rooms to meet people." },
  { term: "Track", definition: "On a Planned slot, one session scheduled into one room. A slot can have several tracks running in parallel." },
  { term: "Place / placement", definition: "On an Unconference slot, putting a session into a specific room. Place the same session on several slots to make it recurring." },
  { term: "Star", definition: "An attendee marking a session \"I want this\". One star both signals interest for the unconference ranking and adds the session to their schedule." },
  { term: "Required", definition: "A session flagged to land on everyone's schedule regardless of stars — for keynotes, opening, and closing." },
  { term: "Reserved room (pinning)", definition: "Holding a specific room for a session so assignment always puts it there, ignoring stars and features. Set on the Sessions tab." },
  { term: "Room scope", definition: "Which rooms (and which sessions) a single unconference slot is allowed to use. Defaults to all of them." },
  { term: "Recurring session", definition: "The same session placed on more than one slot, so it runs more than once. Attendees are split across the times." },
];
