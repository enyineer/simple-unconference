// Types shared across the conference page and its tab modules. These describe
// the wire format the server actually returns — never the Prisma model shape
// directly. When the server route changes, this file is the single source of
// truth for the new shape.

export type Role = "owner" | "moderator" | "participant";

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

export interface Submission {
  id: number;
  submitter_id: number;
  submitter_name: string | null;
  /** Only mods/owners see this; participants get null. */
  submitter_email: string | null;
  title: string;
  description: string;
  status: "submitted" | "published" | "rejected";
  star_count: number;
  starred_by_me: boolean;
  created_at: number;
  tags: string[];
  requirements: string[];
  /** Required room features. The assignment algorithm filters candidate
   * rooms to those whose tag set is a superset of these values. Frozen
   * once the session is published (submitters can no longer edit; mods can).
   * Empty array means "any room is fine." */
  room_requirements: string[];
  /** Per-submission override of the conference's max placements cap.
   * `null` means "inherit". Mods/owners can set this from the Sessions tab. */
  max_placements: number | null;
  /** Moderator override — true treats this session as finished regardless of
   * placement count. */
  manually_finished: boolean;
  /** Moderator-set pre-assignment to a specific room. When set, the
   * unconference algorithm pins this submission to this room (overriding
   * star-based placement). `null` means "auto-place". */
  pre_assigned_room_id: number | null;
  /** Moderator-set: when true, this session can be placed (or its
   * submitter can host) in multiple overlapping slots. Default false
   * enforces the no-overlap rule. */
  allow_overlapping_placements: boolean;
  /** Static TrackAssignment + UnconferencePlacement total for this session. */
  placement_count: number;
  /** Resolved against the conference default. Finished sessions are excluded
   * from future unconference assignment pools; participants don't see them
   * on the Sessions overview. */
  is_finished: boolean;
}

export interface Slot {
  id: number;
  type: "normal" | "unconference" | "mixer";
  title: string | null;
  description: string | null;
  starts_at: number;
  ends_at: number;
  unconf_use_all_rooms: boolean;
  unconf_use_all_submissions: boolean;
  unconf_avoid_repeats: boolean;
  /** Mixer-only override of the conference's default avoid-repeats mode.
   * `null` = inherit; `true` = exclusive mix; `false` = fresh shuffle. */
  mixer_avoid_repeats: boolean | null;
  /** Resolved (override → conference default) avoid-repeats mode. The
   * algorithm uses this on the server; the UI shows it for display. */
  mixer_avoid_repeats_effective: boolean;
  unconf_room_ids: number[];
  unconf_submission_ids: number[];
}

export interface Track {
  id: number;
  slot_id: number;
  room_id: number;
  submission_id: number | null;
  title: string | null;
  speakers: string | null;
  star_count: number;
  starred_by_me: boolean;
  /** Per-track prerequisites (e.g. "laptop"). Set by mods in the
   *  TrackEditor; independent of any linked submission's requirements. */
  requirements: string[];
  /** Moderator flag: when true, the track is force-attended for every
   *  participant. The UI hides/disables the star toggle and renders a
   *  "Required" badge. */
  mandatory: boolean;
}

export interface AgendaData {
  slots: Slot[];
  tracks: Track[];
  /** Unconference placements; `attendee_count` is the number of users
   * currently assigned to that submission in that slot (used to compute
   * remaining capacity for manual session-switching). */
  placements: {
    slot_id: number;
    submission_id: number;
    room_id: number;
    attendee_count: number;
  }[];
  /** For mixer slots: per-room headcount after assignment. Privacy-safe
   * aggregate (no user identities). */
  mixer_placements: { slot_id: number; room_id: number; attendee_count: number }[];
}

export interface MyAssignments {
  assignments: {
    source: "unconference" | "static" | "mixer" | "expert";
    /** Null for expert bookings (no AgendaSlot backs them). */
    slot_id: number | null;
    submission_id: number | null;
    room_id: number | null;
    /** Denormalized event window — present on every row. */
    starts_at: number;
    ends_at: number;
    title: string | null;
    /** Only set on unconference + mixer rows. True when the user picked this
     * session themselves; false when the algorithm placed them. */
    manual?: boolean;
    /** Present on expert-source rows so the UI can offer cancellation. */
    booking_id?: number;
    /** Expert rows only: "booker" when the user reserved an expert,
     * "expert" when someone booked this user as an expert. */
    expert_role?: "booker" | "expert";
    /** Static rows only: true when the track is moderator-marked mandatory. */
    mandatory?: boolean;
  }[];
  unplaced_slots: number[];
}
