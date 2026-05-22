// Shared oRPC contract — single source of truth for every API operation.
// The server implementation MUST match these inputs/outputs; the frontend
// client is derived from the same shape. Drift between client and server
// surfaces as a TypeScript error at build time.
//
// Inputs are validated at runtime via the existing valibot schemas in
// `./schemas.ts`. Outputs are declared with oRPC's type-only `type<T>()`
// helper — no runtime validation (we trust our own server), but full
// TypeScript inference both directions: handlers must return the declared
// shape (compile error otherwise), and clients see exact return types.

import { oc, type } from "@orpc/contract";
import * as v from "valibot";
import {
  BookExpertSchema,
  ConfLoginSchema,
  CreateConferenceSchema,
  CreateExpertPoolSchema,
  CreateExpertTimeframeSchema,
  CreateRoomSchema,
  CreateSlotSchema,
  CreateSubmissionSchema,
  DuplicateSlotSchema,
  InviteClaimSchema,
  InviteCreateSchema,
  InviteImportSchema,
  JoinLinkSetSchema,
  LoginSchema,
  PromoteExpertSchema,
  SignupSchema,
  SignupViaLinkSchema,
  SlotTypeSchema,
  ScheduleSubmissionSchema,
  TrackAssignmentSchema,
  TransferOwnershipSchema,
  UpdateConferenceSchema,
  UpdateConfMeSchema,
  UpdateExpertPoolSchema,
  UpdateExpertSchema,
  UpdateRoomSchema,
  UpdateSlotSchema,
  UpdateSlotSeriesSchema,
  UpdateSubmissionSchema,
} from "./schemas";

// ----- shared input helpers -----------------------------------------------

const Slug = v.pipe(v.string(), v.minLength(1));
const Id = v.pipe(v.number(), v.integer(), v.minValue(1));

const InConf = v.object({ slug: Slug });

// ----- shared output types ------------------------------------------------

type Ok = { ok: true };
type ColorMode = "auto" | "light" | "dark";

interface UserOut {
  id: number;
  email: string;
  name: string | null;
}

interface CalendarOut { token: string; path: string }

interface ConfSummary {
  id: number; name: string; slug: string;
  owner_id: number; role: "owner" | "moderator" | "participant";
  timezone: string; created_at: number;
}
interface ConfCreated {
  id: number; name: string; slug: string;
  owner_id: number; timezone: string; created_at: number;
}
// Live counters versus their configured caps. Each entry carries `null`
// for `limit` when the corresponding env var is 0 (unlimited) so the UI
// can skip rendering a progress bar in that case.
interface ConfUsage {
  participants:    { current: number; limit: number | null };
  pending_invites: { current: number; limit: number | null };
  rooms:           { current: number; limit: number | null };
  // Per-user cap, so no per-conference limit to render — just the total
  // count for visibility. limit is always null here.
  total_sessions:  { current: number; limit: null };
}

interface ConfDetail extends ConfCreated {
  design_system: string;
  my_role: "owner" | "moderator" | "participant";
  // Total submissions in this conference attributed to the calling identity,
  // counting every status (submitted, published, rejected, finished). Mirrors
  // exactly what the server's per-user-per-conference quota checks against,
  // so the Sessions tab can render "X / N" without filtering a list the
  // caller may not see in full (rejected/finished submissions are hidden
  // from non-mod viewers in `submissions.list`).
  my_session_count: number;
  // Default avoid-repeats mode applied to new mixer slots. Mods can flip this
  // per slot via `agenda.updateSlot` (`mixer_avoid_repeats`).
  mixer_avoid_repeats_default: boolean;
  // Default cap on how many times a published submission can be placed across
  // static tracks + unconference placements. `null` = unlimited; `1` = once
  // (the default). Mods/owners override per submission via Submission.max_placements.
  submission_max_placements_default: number | null;
  // When false, only owners + moderators can create new submissions. The
  // participant-facing submit UI hides itself; the server rejects
  // `submissions.create` from participants with a 403.
  participant_submissions_enabled: boolean;
  // Mod-only quota visibility. `null` for participants; populated only when
  // the caller is moderator or owner. Surfaces in the Settings tab's Usage
  // card.
  usage: ConfUsage | null;
}

interface ParticipantOut {
  user_id: number; email: string; name: string | null;
  role: "owner" | "moderator" | "participant";
}

// ----- invites + join link ------------------------------------------------

interface InviteOut {
  id: number;
  email: string;
  token: string;
  url: string;
  role: "moderator" | "participant";
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
}
interface InviteImportOut {
  added: number; skipped: number;
  errors: { email: string; reason: string }[];
  invites: InviteOut[];
}
interface InvitePreviewOut {
  conference_name: string;
  conference_slug: string;
  email: string;
  expires_at: number;
}
interface JoinLinkOut {
  enabled: boolean;
  token: string | null;
  url: string | null;
  expires_at: number | null;
  max_uses: number | null;
  used_count: number;
}
interface ConfMeOut {
  id: number;
  email: string;
  name: string | null;
  role: "owner" | "moderator" | "participant";
  color_mode: ColorMode;
}

interface RoomOut {
  id: number; name: string; capacity: number;
  description: string | null; tags: string[];
}

type SubmissionStatus = "submitted" | "published" | "rejected";
export interface SubmissionOut {
  id: number;
  conference_id: number;
  submitter_id: number;
  submitter_name: string | null;
  submitter_email: string | null;
  title: string;
  description: string;
  status: SubmissionStatus;
  created_at: number;
  star_count: number;
  starred_by_me: boolean;
  tags: string[];
  requirements: string[];
  // Required room features. The unconference assignment algorithm filters
  // candidate rooms to those whose tag set is a superset of these values.
  // Frozen once the session is published (submitters can't edit; mods can).
  // Empty array means "any room is fine."
  room_requirements: string[];
  // Per-submission cap override; null = inherit conference default.
  max_placements: number | null;
  // Manual moderator override that forces the session to "finished" status.
  manually_finished: boolean;
  // Moderator-set pre-assignment to a specific room. When set, the
  // unconference assignment algorithm pins this submission to this room for
  // every slot it's placed in, overriding the star-based ranking. `null`
  // means "auto-place". Visible to everyone (no privacy risk: the room
  // name is already public information in the conference).
  pre_assigned_room_id: number | null;
  // Moderator opt-in to allow this session to be placed (or its submitter
  // to host) in multiple overlapping slots. Default false enforces a
  // strict no-overlap policy at assignment time.
  allow_overlapping_placements: boolean;
  // Number of times this submission has been placed (static tracks + unconf
  // placements). UI shows this as `placement_count / effective_cap`.
  placement_count: number;
  // Resolved against the conference default. When true, the session is
  // excluded from future unconference assignment pools. Surfaced to users
  // as an informational badge ("Fully scheduled" / "Marked complete") —
  // it does NOT hide the session or disable starring under Path C.
  is_finished: boolean;
  /** Planned-slot TrackAssignments this submission is scheduled in.
   *  The Sessions tab uses this for the "Scheduled at: 10:00 Hall · 14:00
   *  Hall" inline hint with jump-links to the calendar. Empty when the
   *  submission isn't on the planned agenda. */
  scheduled_in: {
    slot_id: number;
    starts_at: number;
    ends_at: number;
    room_id: number;
    room_name: string;
  }[];
}
interface SubmissionCreated { id: number; status: SubmissionStatus }

type SlotKind = "normal" | "unconference" | "mixer";
export interface SlotOut {
  id: number; type: SlotKind;
  title: string | null; description: string | null;
  starts_at: number; ends_at: number;
  // All of the below are the *effective* values — resolved via
  // `effectiveSlotConfig` on the server. When the slot belongs to a series,
  // they reflect the series; when standalone, the slot's own columns.
  unconf_use_all_rooms: boolean;
  unconf_use_all_submissions: boolean;
  unconf_avoid_repeats: boolean;
  // Per-slot override of the conference's mixer default. `null` means inherit;
  // otherwise this slot's mode is fixed regardless of the conference toggle.
  mixer_avoid_repeats: boolean | null;
  // Effective avoid-repeats mode for this slot (the override resolved against
  // the conference default). UI shows this for display; mods change behavior
  // by writing `mixer_avoid_repeats` via `agenda.updateSlot` (standalone) or
  // `agenda.updateSeries` (series member).
  mixer_avoid_repeats_effective: boolean;
  unconf_room_ids: number[];
  unconf_submission_ids: number[];
  // Series linkage. `null` when this is a standalone slot. When set, the UI
  // shows a "linked offering" indicator and routes config edits through the
  // series-level form.
  series_id: number | null;
  // 1-based index of this offering within its series, ordered by `starts_at`.
  // Null for standalone slots.
  series_offering_index: number | null;
  // Total siblings in this series (including this slot). Null for standalone.
  series_total_offerings: number | null;
}

export interface SlotSeriesOut {
  id: number;
  type: SlotKind;
  title: string | null;
  description: string | null;
  unconf_use_all_rooms: boolean;
  unconf_use_all_submissions: boolean;
  unconf_avoid_repeats: boolean;
  mixer_avoid_repeats: boolean | null;
  avoid_repeats_across_siblings: boolean;
  unconf_room_ids: number[];
  unconf_submission_ids: number[];
  slot_ids: number[];           // siblings, ordered by starts_at
}
export interface TrackOut {
  id: number; slot_id: number; room_id: number;
  /** Every planned track is anchored to a Submission (Path C). The track
   *  display name and submitter credit come from there. */
  submission_id: number;
  /** Display name resolved from the linked Submission. Always present. */
  title: string;
  /** Optional addendum text appended to the submitter's name when listing
   *  speakers (e.g. for co-presenters). Null/empty = just show the
   *  submission's submitter. */
  speakers: string | null;
  /** Number of participants who starred the linked Submission. */
  star_count: number;
  /** True when the viewer starred the linked Submission. The Track itself
   *  has no per-user opt-in any more — Path C unifies the signal. */
  starred_by_me: boolean;
  requirements: string[];
  /** When true, force-attended for every participant — lands on every
   *  schedule regardless of `starred_by_me`. Only meaningful for normal
   *  slots. */
  mandatory: boolean;
}
interface PlacementOut {
  slot_id: number; submission_id: number; room_id: number;
  /** Number of users actually assigned to this placement after capacity
   *  clipping. ≤ `room_capacity`. */
  attendee_count: number;
  /** Total stars on the linked Submission across the whole conference —
   *  the "demand signal." When `star_count > room_capacity`, more people
   *  wanted in than the room can fit; the mod sees a soft warning. */
  star_count: number;
  /** Capacity of the assigned room, denormalized so the client can compute
   *  `star_count > room_capacity` without a join. */
  room_capacity: number;
}
interface MixerPlacementOut {
  slot_id: number; room_id: number; attendee_count: number;
}
interface AgendaOut {
  slots: SlotOut[];
  slot_series: SlotSeriesOut[];
  tracks: TrackOut[];
  placements: PlacementOut[];
  mixer_placements: MixerPlacementOut[];
}

// Response of `agenda.updateSeries`. When the requested patch would orphan
// existing track assignments or placements, the server short-circuits with
// `kind: "needs_confirmation"` describing exactly what will be removed.
// The client re-submits the same patch with `confirm: true` to apply it
// and cascade-delete the orphans.
export type UpdateSeriesResult =
  | { kind: "ok" }
  | {
      kind: "needs_confirmation";
      removed_track_assignments: number;
      removed_unconference_placements: number;
      removed_user_assignments: number;
      // Rooms/submissions that would be dropped from the pool; surface in
      // the confirm dialog so the mod knows what they're removing.
      removed_room_ids: number[];
      removed_submission_ids: number[];
    };

interface AssignmentOut {
  source: "unconference" | "static" | "mixer" | "expert";
  /** Null for expert bookings (no AgendaSlot backs them). */
  slot_id: number | null;
  submission_id: number | null;
  room_id: number | null;
  /** Denormalized event window so the schedule renders without a separate
   * slot lookup (expert bookings don't have a slot). Always present. */
  starts_at: number;
  ends_at: number;
  title: string | null;
  manual: boolean;
  /** Present on expert-source rows so the UI can let the user cancel. */
  booking_id?: number;
  /** Expert rows only: "booker" when the user reserved an expert,
   * "expert" when someone booked this user as an expert. */
  expert_role?: "booker" | "expert";
  /** Static rows only: true when the track is moderator-marked mandatory
   * (the row is in the schedule regardless of the user's star choice). */
  mandatory?: boolean;
  /** Static rows only: true when the viewer is the linked submission's
   *  submitter (so they're speaking, not attending). UI shows a "You're
   *  speaking" badge to distinguish from "you're attending." */
  is_submitter?: boolean;
  /** Static rows only: total star count on the linked submission, used as a
   *  rough expected-attendance estimate. Surfaced as a soft warning to the
   *  participant when it exceeds the room's capacity. Null for non-static
   *  sources (where attendance is bounded by the assignment algorithm). */
  expected_attendance?: number | null;
  /** Static rows only: capacity of the assigned room, denormalized so the
   *  client can compare against `expected_attendance` without a second
   *  lookup. Null when the row has no `room_id`. */
  room_capacity?: number | null;
}
export interface MyAssignmentsOut {
  assignments: AssignmentOut[];
  unplaced_slots: number[];
}

// A pre-assignment conflict detected before an unconference slot is run.
// `kind` discriminates the two failure modes:
//   - "duplicate_room": two or more eligible submissions in this slot share
//     the same `pre_assigned_room_id`; the mod must change one's pinned room.
//   - "out_of_scope": a pre-assigned submission's room isn't in the slot's
//     effective room set (only fires when `unconf_use_all_rooms = false`);
//     the mod must either add the room to the slot or clear the pin.
// Both shapes carry enough detail for the UI to deep-link to the offending
// submission(s) without an extra round-trip.
// Discriminated union of pre-assignment conflict shapes surfaced by the
// route gate before any DB writes happen.
//
//   - "duplicate_room": two or more top-N pinned sessions target the same
//     room. The mod must move/skip/unpin one.
//   - "out_of_scope": a top-N pinned room isn't in the slot's effective
//     room set. The mod must clear/skip the pin or add the room to the slot.
//   - "unsatisfiable_requirements": a top-N session has approved room
//     requirements (tags) but no room in the slot's scope satisfies them
//     (either no room has the tags at all, or every matching room was
//     reserved by an earlier pin / earlier matching session). The
//     `candidate_room_names` list, when empty, means "no room in the slot
//     matches these tags." When non-empty, the matching rooms exist but
//     were already claimed by a higher-priority session.
type PreAssignmentConflict =
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

// Sessions / rooms / users excluded from this slot's assignment because of
// overlapping agenda slots. Reported informationally on success — the mod
// sees exactly what the algorithm filtered out and why (so they don't have
// to guess why a popular session didn't get a placement, etc).
interface OverlapExclusions {
  rooms: { id: number; name: string }[];
  submissions: {
    id: number; title: string;
    // Why this session was filtered:
    //   - "same_session": the session is already placed in an overlapping
    //     slot AND its allow_overlapping_placements flag is false.
    //   - "busy_submitter": a *different* session by the same submitter is
    //     placed in an overlapping slot.
    reason: "same_session" | "busy_submitter";
  }[];
  // User identity IDs assigned to an overlapping slot in this conference.
  // The UI shows just a count by default; the array is here for diagnostics.
  user_ids: number[];
}

type AssignResult =
  | {
      kind: "unconference";
      placements: { slot_id: number; submission_id: number; room_id: number }[];
      user_assignments: { slot_id: number; user_id: number; submission_id: number }[];
      unplaced_users: number[];
      overlap_exclusions: OverlapExclusions;
    }
  | {
      kind: "mixer";
      room_assignments: { slot_id: number; user_id: number; room_id: number }[];
      unplaced_users: number[];
      overlap_exclusions: OverlapExclusions;
    }
  | {
      kind: "conflict";
      conflicts: PreAssignmentConflict[];
    };

// Result shape for `agenda.scheduleSubmission`. On success, returns the
// auto-picked room (or the Submission's pinned room when set). On failure,
// `reason` explains exactly why no room could be assigned:
//   - "pin_room_taken": Submission.preAssignedRoomId is set, but another
//     track in this slot already occupies that room.
//   - "pin_room_out_of_scope": pinned room isn't in the slot's effective
//     room set (series-restricted or removed).
//   - "unsatisfiable_requirements": the submission's room_requirements
//     can't be satisfied by any free room in scope. `candidate_room_names`
//     lists rooms whose tag set matches; when empty, no room matches at all;
//     when non-empty, every matching room is already taken.
//   - "no_free_room": neither pin nor tag constraints apply, but every
//     room in scope is already occupied by another track.
type ScheduleSubmissionResult =
  | {
      kind: "ok";
      track_id: number;
      room_id: number;
      room_name: string;
    }
  | {
      kind: "conflict";
      reason:
        | "pin_room_taken"
        | "pin_room_out_of_scope"
        | "unsatisfiable_requirements"
        | "no_free_room";
      pinned_room: { id: number; name: string } | null;
      required_tags: string[];
      candidate_room_names: string[];
    };

// ----- contract ------------------------------------------------------------

// ----- expert booking output types ---------------------------------------

interface ExpertPoolOut {
  id: number;
  name: string;
  room_ids: number[];
  expert_count: number;
}

// Slot derived from an ExpertTimeframe. `booking_id` is null when free;
// for non-mod viewers `booker_name`/`booker_email` are always null unless
// it's their own booking (the booker sees themselves).
interface ExpertSlotOut {
  starts_at: number;
  ends_at: number;
  timeframe_id: number;
  booking_id: number | null;
  booker_name: string | null;
  booker_email: string | null;
  room_id: number | null;
  is_mine: boolean;
}

interface ExpertTimeframeOut {
  id: number;
  starts_at: number;
  ends_at: number;
  slot_duration_minutes: number;
}

interface ExpertOut {
  id: number;
  identity_id: number;
  name: string | null;
  email: string | null;          // null for non-mods (and non-self)
  bio: string | null;
  pool_id: number | null;
  pool_name: string | null;
  room_ids: number[];            // explicit per-expert rooms (empty if pool-based)
  timeframes: ExpertTimeframeOut[];
  slots: ExpertSlotOut[];        // derived from timeframes, sorted by start
}

interface ExpertBookingCreatedOut {
  booking_id: number;
  room_id: number;
  starts_at: number;
  ends_at: number;
}

// ----- notifications ------------------------------------------------------

// Lightweight in-app notification. Targeted at the viewer's per-conference
// identity (so a user gets a separate inbox per conference). `cta_href` uses
// the `tab:<key>` form to switch tabs within the current conference page;
// `null` means there's no CTA button.
type NotificationKind =
  | "submission_published"
  | "submission_rejected"
  | "submission_received"
  | "unconf_assigned"
  | "mixer_assigned"
  | "expert_booked"
  | "expert_booking_cancelled"
  | "quota_threshold";

interface NotificationOut {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string | null;
  cta_label: string | null;
  cta_href: string | null;
  read_at: number | null;
  created_at: number;
}

interface NotificationListOut {
  items: NotificationOut[];
  unread_count: number;
}

// ----- public config (anonymous) -----------------------------------------

// Returned to anyone (no auth). Used by the login screen to know which
// affordances to show before any session exists. `turnstile_site_key` is
// null when Cloudflare Turnstile is disabled on this instance; non-null
// means the client must render the widget and submit a token with
// signup / login / signupViaLink. `max_conferences_per_user` is null when
// the cap is disabled; the Conferences overview surfaces it as a quota
// hint alongside the count the user already owns.
interface PublicConfigOut {
  signup_enabled: boolean;
  turnstile_site_key: string | null;
  max_conferences_per_user: number | null;
  // Per-user cap on submissions within a single conference. Surfaced so the
  // Sessions tab can show "X of N submitted" before the user tries to add
  // their (N+1)th one.
  max_sessions_per_user_per_conference: number | null;
}

export const contract = {
  config: {
    get: oc.output(type<PublicConfigOut>()),
  },
  auth: {
    signup: oc.input(SignupSchema).output(type<UserOut>()),
    login: oc.input(LoginSchema).output(type<UserOut>()),
    logout: oc.output(type<Ok>()),
    me: oc.output(type<UserOut>()),
    // Self-service account deletion. Removes the calling owner's User row;
    // any conferences they still own become orphaned (ownerUserId -> null
    // per the schema's SetNull rule). Cookies are cleared. Used by the
    // loadtest teardown to leave instances clean after runs.
    deleteSelf: oc.output(type<Ok>()),
  },
  conferences: {
    list: oc.output(type<ConfSummary[]>()),
    create: oc.input(CreateConferenceSchema).output(type<ConfCreated>()),
    get: oc.input(InConf).output(type<ConfDetail>()),
    update: oc
      .input(v.object({ slug: Slug, ...UpdateConferenceSchema.entries }))
      .output(type<Ok>()),
    delete: oc.input(InConf).output(type<Ok>()),
    listParticipants: oc.input(InConf).output(type<ParticipantOut[]>()),
    removeParticipant: oc
      .input(v.object({ slug: Slug, user_id: Id }))
      .output(type<Ok>()),
    addModerator: oc
      .input(v.object({ slug: Slug, user_id: Id }))
      .output(type<Ok>()),
    removeModerator: oc
      .input(v.object({ slug: Slug, user_id: Id }))
      .output(type<Ok>()),

    // Hand ownership over to another existing global User. Owner-only.
    // The previous owner loses owner-level access; the new owner gets an
    // auto-minted ConferenceIdentity on their next visit.
    transferOwnership: oc
      .input(v.object({ slug: Slug, ...TransferOwnershipSchema.entries }))
      .output(type<Ok>()),

    // ----- invites (moderator+) -------------------------------------------
    createInvite: oc
      .input(v.object({ slug: Slug, ...InviteCreateSchema.entries }))
      .output(type<InviteOut>()),
    importInvites: oc
      .input(v.object({ slug: Slug, ...InviteImportSchema.entries }))
      .output(type<InviteImportOut>()),
    listInvites: oc.input(InConf).output(type<InviteOut[]>()),
    revokeInvite: oc
      .input(v.object({ slug: Slug, id: Id }))
      .output(type<Ok>()),

    // ----- join link (owner-only) -----------------------------------------
    getJoinLink: oc.input(InConf).output(type<JoinLinkOut>()),
    setJoinLink: oc
      .input(v.object({ slug: Slug, ...JoinLinkSetSchema.entries }))
      .output(type<JoinLinkOut>()),
    rotateJoinLink: oc.input(InConf).output(type<JoinLinkOut>()),

    // ----- anonymous onboarding -------------------------------------------
    // No auth required; the token in the input is the secret.
    previewInvite: oc
      .input(v.object({ slug: Slug, token: v.pipe(v.string(), v.minLength(1)) }))
      .output(type<InvitePreviewOut>()),
    claimInvite: oc
      .input(v.object({ slug: Slug, ...InviteClaimSchema.entries }))
      .output(type<ConfMeOut>()),
    signupViaLink: oc
      .input(v.object({ slug: Slug, ...SignupViaLinkSchema.entries }))
      .output(type<ConfMeOut>()),

    // ----- per-conference identity session ---------------------------------
    login: oc
      .input(v.object({ slug: Slug, ...ConfLoginSchema.entries }))
      .output(type<ConfMeOut>()),
    logout: oc.input(InConf).output(type<Ok>()),
    me: oc.input(InConf).output(type<ConfMeOut>()),
    updateConfMe: oc
      .input(v.object({ slug: Slug, ...UpdateConfMeSchema.entries }))
      .output(type<ConfMeOut>()),

    // ----- per-identity calendar feed (one token per conference identity) --
    getCalendar: oc.input(InConf).output(type<CalendarOut>()),
    resetCalendar: oc.input(InConf).output(type<CalendarOut>()),
  },
  rooms: {
    list: oc.input(InConf).output(type<RoomOut[]>()),
    create: oc.input(v.object({ slug: Slug, ...CreateRoomSchema.entries })).output(type<RoomOut>()),
    update: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateRoomSchema.entries }))
      .output(type<Ok>()),
    delete: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
  },
  submissions: {
    list: oc
      .input(v.object({
        slug: Slug,
        status: v.optional(v.picklist(["submitted", "published", "rejected"] as const)),
      }))
      .output(type<SubmissionOut[]>()),
    create: oc
      .input(v.object({ slug: Slug, ...CreateSubmissionSchema.entries }))
      .output(type<SubmissionCreated>()),
    update: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateSubmissionSchema.entries }))
      .output(type<Ok>()),
    // Submitter can delete their own session while it's still `submitted`
    // (i.e. before a moderator has decided on it). Mods/owners can delete
    // any session in their conference.
    delete: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    publish: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    unpublish: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    reject: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    star: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    unstar: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
  },
  agenda: {
    get: oc.input(InConf).output(type<AgendaOut>()),
    createSlot: oc
      .input(v.object({ slug: Slug, ...CreateSlotSchema.pipe[0].entries }))
      .output(type<{ id: number }>()),
    updateSlot: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateSlotSchema.pipe[0].entries }))
      .output(type<Ok>()),
    deleteSlot: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),
    // Duplicate an existing slot as a linked offering. If the source is
    // standalone, a new SlotSeries is created with the source + the new
    // sibling as members. If the source is already in a series, the new
    // sibling joins that series.
    duplicateSlot: oc
      .input(v.object({ slug: Slug, id: Id, ...DuplicateSlotSchema.pipe[0].entries }))
      .output(type<{ slot_id: number; series_id: number }>()),
    // Series-level config edit. Returns `needs_confirmation` when the patch
    // would orphan track assignments / placements; resubmit with `confirm: true`.
    updateSeries: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateSlotSeriesSchema.entries }))
      .output(type<UpdateSeriesResult>()),
    // Promote a series member back to a standalone slot. Snapshots the
    // current series config onto the slot's own columns and clears
    // `series_id`. The series stays around for its remaining members.
    detachSeries: oc
      .input(v.object({ slug: Slug, slot_id: Id }))
      .output(type<Ok>()),
    // Delete a series. `mode = "series_only"` detaches all members first
    // (snapshotting config onto each). `mode = "with_slots"` cascade-deletes
    // every sibling slot too.
    deleteSeries: oc
      .input(v.object({
        slug: Slug, id: Id,
        mode: v.picklist(["series_only", "with_slots"] as const),
      }))
      .output(type<Ok>()),
    setTrack: oc
      .input(v.object({ slug: Slug, slot_id: Id, ...TrackAssignmentSchema.entries }))
      .output(type<Ok>()),
    // Same intent as `setTrack`, but the server picks the room based on the
    // Submission's pin (`preAssignedRoomId`), its `roomRequirements`, and
    // the largest free room in the slot's effective scope. Conflicts come
    // back as a structured payload — see `ScheduleSubmissionResult`.
    scheduleSubmission: oc
      .input(v.object({ slug: Slug, slot_id: Id, ...ScheduleSubmissionSchema.entries }))
      .output(type<ScheduleSubmissionResult>()),
    clearTrack: oc
      .input(v.object({ slug: Slug, slot_id: Id, room_id: Id }))
      .output(type<Ok>()),
    // Path C: per-track stars no longer exist. Participants star the
    // underlying Submission via `submissions.star` / `submissions.unstar`,
    // and every linked TrackAssignment derives onto their schedule. The
    // old `agenda.starTrack` / `agenda.unstarTrack` endpoints were removed.
    assign: oc
      .input(v.object({
        slug: Slug, slot_id: Id,
        // One-shot exclusion: drop these submissions from the slot's eligible
        // pool just for this assignment run (no persistent change to slot
        // config or to the submissions). The resolve panel uses this to
        // "skip" a conflicting pre-assigned session so its next-most-starred
        // alternative takes the room instead.
        exclude_submission_ids: v.optional(v.array(Id)),
      }))
      .output(type<AssignResult>()),
    myAssignments: oc.input(InConf).output(type<MyAssignmentsOut>()),
    pickAssignment: oc
      .input(v.object({ slug: Slug, slot_id: Id, submission_id: Id }))
      .output(type<Ok>()),
    unpickAssignment: oc
      .input(v.object({ slug: Slug, slot_id: Id }))
      .output(type<Ok>()),
  },
  experts: {
    // ----- room pools (mod+) ---------------------------------------------
    listPools: oc.input(InConf).output(type<ExpertPoolOut[]>()),
    createPool: oc
      .input(v.object({ slug: Slug, ...CreateExpertPoolSchema.entries }))
      .output(type<ExpertPoolOut>()),
    updatePool: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateExpertPoolSchema.entries }))
      .output(type<Ok>()),
    deletePool: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),

    // ----- experts list (everyone) + management (mod+) -------------------
    list: oc.input(InConf).output(type<ExpertOut[]>()),
    promote: oc
      .input(v.object({ slug: Slug, ...PromoteExpertSchema.entries }))
      .output(type<{ id: number }>()),
    update: oc
      .input(v.object({ slug: Slug, id: Id, ...UpdateExpertSchema.entries }))
      .output(type<Ok>()),
    demote: oc.input(v.object({ slug: Slug, id: Id })).output(type<Ok>()),

    // ----- timeframes (mod+) ---------------------------------------------
    createTimeframe: oc
      .input(v.object({
        slug: Slug, expert_id: Id, ...CreateExpertTimeframeSchema.pipe[0].entries,
      }))
      .output(type<{ id: number }>()),
    deleteTimeframe: oc
      .input(v.object({ slug: Slug, expert_id: Id, id: Id }))
      .output(type<Ok>()),

    // ----- bookings ------------------------------------------------------
    book: oc
      .input(v.object({ slug: Slug, ...BookExpertSchema.entries }))
      .output(type<ExpertBookingCreatedOut>()),
    cancelBooking: oc
      .input(v.object({ slug: Slug, booking_id: Id }))
      .output(type<Ok>()),
  },
  notifications: {
    list: oc.input(InConf).output(type<NotificationListOut>()),
    markRead: oc
      .input(v.object({ slug: Slug, id: Id }))
      .output(type<Ok>()),
    markAllRead: oc.input(InConf).output(type<Ok>()),
  },
};

export type Contract = typeof contract;

export { SlotTypeSchema };
