// Types shared across the conference page and its tab modules. These describe
// the wire format the server actually returns — never the Prisma model shape
// directly. When the server route changes, this file is the single source of
// truth for the new shape.

export type Role = "owner" | "moderator" | "participant";

export type Tab =
  | "people" | "rooms" | "sessions" | "agenda" | "experts"
  | "directory" | "chat" | "me" | "settings";

const ALL_TABS: ReadonlySet<Tab> = new Set<Tab>([
  "people", "rooms", "sessions", "agenda", "experts",
  "directory", "chat", "me", "settings",
]);

export function isTab(value: string | undefined): value is Tab {
  return value !== undefined && ALL_TABS.has(value as Tab);
}

export interface ConferenceUsage {
  participants:    { current: number; limit: number | null };
  pending_invites: { current: number; limit: number | null };
  rooms:           { current: number; limit: number | null };
  total_sessions:  { current: number; limit: null };
}

export interface ConferenceDetail {
  id: number;
  name: string;
  slug: string;
  owner_id: number;
  created_at: number;
  design_system: string;
  timezone: string;
  /** Default avoid-repeats mode applied to new mixer slots. When true,
   * "exclusive mix" is the default and the assignment tries not to put two
   * participants in the same room across mixers. Mods can override per slot. */
  mixer_avoid_repeats_default: boolean;
  /** Default cap on how many times a published submission can be placed
   * across static tracks + unconference placements. `null` = unlimited;
   * `1` = "assign once" (the default). Mods/owners override per submission. */
  submission_max_placements_default: number | null;
  /** When false, only owners + moderators can submit sessions. The Sessions
   *  tab hides the "Submit a session" button for participants and shows a
   *  short notice; the server rejects `submissions.create` with 403. */
  participant_submissions_enabled: boolean;
  my_role: Role;
  /** Submissions in this conference owned by the calling identity, counting
   *  every status. Mirrors the server's per-user-per-conference cap exactly,
   *  so the Sessions tab can render "X / N" honestly even for participants
   *  who don't see their own rejected/finished sessions in submissions.list. */
  my_session_count: number;
  /** Mod-only quota snapshot. Null when the caller is a participant. */
  usage: ConferenceUsage | null;
}

export interface Participant {
  user_id: number;
  email: string;
  name: string | null;
  role: Role;
}

export interface Room {
  id: number;
  name: string;
  capacity: number;
  description: string | null;
  tags: string[];
}

// Re-exported from the contract — `Submission` is the wire shape for
// `submissions.list` / `submissions.update` etc. Duplicating it client-side
// just creates drift, so we take the contract type directly.
import type { SubmissionOut } from "../../shared/contract";
export type Submission = SubmissionOut;

// Re-export the contract types directly — these are pure data shapes the
// server returns, so duplicating them client-side just creates drift risk.
// (The other types in this file should follow this pattern over time; not
// touching them in this PR to keep the diff focused on slot series + Path C.)
import type {
  SlotOut, SlotSeriesOut, TrackOut, UpdateSeriesResult,
} from "../../shared/contract";
export type Slot = SlotOut;
export type SlotSeries = SlotSeriesOut;
export type Track = TrackOut;
export type { UpdateSeriesResult };

export interface AgendaData {
  slots: Slot[];
  /** Every series in the conference. The client uses this to render the
   *  series-level edit form and to count siblings without re-deriving from
   *  `slots`. */
  slot_series: SlotSeries[];
  tracks: Track[];
  /** Unconference placements; `attendee_count` is the number of users
   * currently assigned to that submission in that slot (used to compute
   * remaining capacity for manual session-switching). `star_count` and
   * `room_capacity` power the "Room may be full" warning — when stars
   * exceed capacity, demand outstripped the room. */
  placements: {
    slot_id: number;
    submission_id: number;
    room_id: number;
    attendee_count: number;
    star_count: number;
    room_capacity: number;
  }[];
  /** For mixer slots: per-room headcount after assignment. Privacy-safe
   * aggregate (no user identities). */
  mixer_placements: { slot_id: number; room_id: number; attendee_count: number }[];
}

import type { MyAssignmentsOut } from "../../shared/contract";
export type MyAssignments = MyAssignmentsOut;
