// Shared oRPC contract output types and small input primitives.
// Split out of `contract.ts` for readability. The contract object itself
// lives in `../contract.ts` and re-exports everything here via
// `export * from "./contract/types"` — so consumers still
// `import { ... } from "../../shared/contract"` unchanged.

import * as v from "valibot";

// ----- shared input helpers -----------------------------------------------

export const Slug = v.pipe(v.string(), v.minLength(1));
export const Id = v.pipe(v.number(), v.integer(), v.minValue(1));

export const InConf = v.object({ slug: Slug });

// ----- shared output types ------------------------------------------------

export type Ok = { ok: true };

/**
 * Generic paginated list envelope returned by every server-paginated
 * `list` procedure. `next_cursor` is an opaque token to pass back as
 * `cursor` on the next call; `null` when the current page is the last.
 * `total` is the count of rows matching the same filters (sans paging)
 * so the UI can render "Showing X-Y of N" and a numeric page bar.
 */
export interface Page<T> {
  items: T[];
  total: number;
  next_cursor: string | null;
}
export type ColorMode = "auto" | "light" | "dark";

export interface UserOut {
  id: number;
  email: string;
  name: string | null;
}

export interface CalendarOut { token: string; path: string }

export interface ConfSummary {
  id: number; name: string; slug: string;
  owner_id: number; role: "owner" | "moderator" | "participant";
  timezone: string; created_at: number;
}
export interface ConfCreated {
  id: number; name: string; slug: string;
  owner_id: number; timezone: string; created_at: number;
}
// Live counters versus their configured caps. Each entry carries `null`
// for `limit` when the corresponding env var is 0 (unlimited) so the UI
// can skip rendering a progress bar in that case.
export interface ConfUsage {
  participants:    { current: number; limit: number | null };
  pending_invites: { current: number; limit: number | null };
  rooms:           { current: number; limit: number | null };
  // Per-user cap, so no per-conference limit to render — just the total
  // count for visibility. limit is always null here.
  total_sessions:  { current: number; limit: null };
}

export interface ConfDetail extends ConfCreated {
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

export interface ParticipantOut {
  user_id: number; email: string; name: string | null;
  role: "owner" | "moderator" | "participant";
}

// ----- invites + join link ------------------------------------------------

export interface InviteOut {
  id: number;
  email: string;
  token: string;
  url: string;
  role: "moderator" | "participant";
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
}
export interface InviteImportOut {
  added: number; skipped: number;
  errors: { email: string; reason: string }[];
  invites: InviteOut[];
}
export interface InvitePreviewOut {
  conference_name: string;
  conference_slug: string;
  email: string;
  expires_at: number;
}
export interface JoinLinkOut {
  enabled: boolean;
  token: string | null;
  url: string | null;
  expires_at: number | null;
  max_uses: number | null;
  used_count: number;
}
export interface ConfMeOut {
  id: number;
  email: string;
  name: string | null;
  role: "owner" | "moderator" | "participant";
  color_mode: ColorMode;
  // Profile state carried alongside the standard identity payload so the
  // first-login completion nudge can render without a second round-trip.
  // `profile_published` mirrors `ConferenceIdentity.profilePublished` and
  // `profile_completion_dismissed` mirrors the matching column; the nudge
  // banner shows when both are false.
  profile_published: boolean;
  profile_completion_dismissed: boolean;
}

export interface RoomOut {
  id: number; name: string; capacity: number;
  description: string | null; tags: string[];
}

export type SubmissionStatus = "submitted" | "published" | "rejected";
export interface SubmissionOut {
  id: number;
  conference_id: number;
  submitter_id: number;
  submitter_name: string | null;
  submitter_email: string | null;
  // Whether the submitter has opted into a public profile page. Drives the
  // ProfileLink rendering: non-mods can only click the submitter's name when
  // there's actually a profile to land on. Mods/owners can navigate to any
  // identity's profile regardless (the profiles.get endpoint allows it).
  submitter_profile_published: boolean;
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
export interface SubmissionCreated { id: number; status: SubmissionStatus }

export type SlotKind = "normal" | "unconference" | "mixer";
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
export interface PlacementOut {
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
  /** True when a moderator placed this session by hand; false when the
   *  per-slot star-ranked auto-fill created it. Lets the UI distinguish a
   *  deliberate "placed by you" occurrence from a "by stars" one. */
  manual: boolean;
}
export interface MixerPlacementOut {
  slot_id: number; room_id: number; attendee_count: number;
}
export interface AgendaOut {
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

export interface AssignmentOut {
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
export type PreAssignmentConflict =
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
export interface OverlapExclusions {
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

export type AssignResult =
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

// Result of `agenda.assignAll`: the global attendee router routed participants
// across every unconference slot's placements at once. `assigned` is the total
// number of (user, session) seats filled; `unplaced_user_ids` are participants
// who starred something but got no seat; `slot_ids` are the unconference slots
// that were (re)computed.
export interface AssignAllResult {
  assigned: number;
  unplaced_user_ids: number[];
  slot_ids: number[];
}

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
export type ScheduleSubmissionResult =
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

// ----- expert booking output types ---------------------------------------

export interface ExpertPoolOut {
  id: number;
  name: string;
  room_ids: number[];
  expert_count: number;
}

// Slot derived from an ExpertTimeframe. `booking_id` is null when free;
// for non-mod viewers `booker_name`/`booker_email` are always null unless
// it's their own booking (the booker sees themselves).
export interface ExpertSlotOut {
  starts_at: number;
  ends_at: number;
  timeframe_id: number;
  booking_id: number | null;
  booker_name: string | null;
  booker_email: string | null;
  room_id: number | null;
  is_mine: boolean;
}

export interface ExpertTimeframeOut {
  id: number;
  starts_at: number;
  ends_at: number;
  slot_duration_minutes: number;
}

export interface ExpertOut {
  id: number;
  identity_id: number;
  name: string | null;
  email: string | null;          // null for non-mods (and non-self)
  // Whether the expert's profile is published. The ExpertsTab uses this plus
  // the viewer's mod status to decide whether to wrap the name in ProfileLink.
  profile_published: boolean;
  bio: string | null;
  pool_id: number | null;
  pool_name: string | null;
  room_ids: number[];            // explicit per-expert rooms (empty if pool-based)
  timeframes: ExpertTimeframeOut[];
  slots: ExpertSlotOut[];        // derived from timeframes, sorted by start
}

export interface ExpertBookingCreatedOut {
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
export type NotificationKind =
  | "submission_published"
  | "submission_rejected"
  | "submission_received"
  | "unconf_assigned"
  | "mixer_assigned"
  | "expert_booked"
  | "expert_booking_cancelled"
  | "quota_threshold"
  | "chat_message"
  | "chat_report"
  | "chat_warning";

export interface NotificationOut {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string | null;
  cta_label: string | null;
  cta_href: string | null;
  read_at: number | null;
  created_at: number;
  // Number of underlying events represented by this row. > 1 means it has
  // been coalesced (e.g. via dedupeKey="conv:<id>" for chat messages).
  // Always >= 1 for unread rows; 0 once marked read.
  unread_count: number;
  // Coalescing key, NULL for one-shot notifications. UI can use this to
  // route clicks (e.g. "conv:42" -> open conversation 42).
  dedupe_key: string | null;
}

export interface NotificationListOut {
  items: NotificationOut[];
  unread_count: number;
}

// ----- profiles -----------------------------------------------------------

// Single row in a user's profile (link or contact). For non-mod viewers the
// server only returns rows with `is_public=true`; mods + the row's owner
// see all rows. `position` is the explicit display order in the editor.
export interface ProfileEntryOut {
  id: number;
  kind: string;
  value: string;
  href: string | null;
  category: "link" | "contact";
  is_public: boolean;
  position: number;
}

// Full profile payload returned by `profiles.get` and the update mutations.
// `email` is null for non-mod, non-self viewers — the canonical identity
// email is never leaked through this surface. Public contact emails live in
// a `ProfileEntry` row with `kind="Email"` and `is_public=true`.
export interface ProfileOut {
  identity_id: number;
  conference_id: number;
  name: string | null;
  email: string | null;
  role: "participant" | "moderator" | "owner";
  profile_published: boolean;
  bio: string | null;
  pronouns: string | null;
  title: string | null;
  company: string | null;
  // Content hash of the current avatar webp (first 16 hex of sha256), or null
  // when no avatar is set. Clients compose the cacheable URL as
  // `/api/avatars/<slug>/<identity_id>/<avatar_hash>` so a hash change busts
  // the CDN cache. When null, fall back to `/api/avatars/<slug>/<id>` which
  // serves the deterministic initials SVG.
  avatar_hash: string | null;
  entries: ProfileEntryOut[];
  tags: string[];
  is_expert: boolean;
  is_me: boolean;
  can_edit: boolean;
  // Always false unless `is_me === true`. Drives the first-login nudge state.
  profile_completion_dismissed: boolean;
}

// Compact row for the Directory tab. No email under any role. Non-mods only
// see published identities; mods see everyone.
export interface ProfileSummaryOut {
  identity_id: number;
  name: string | null;
  title: string | null;
  company: string | null;
  pronouns: string | null;
  avatar_hash: string | null;
  tags: string[];
  is_expert: boolean;
}

// ----- public config (anonymous) -----------------------------------------

// Returned to anyone (no auth). Used by the login screen to know which
// affordances to show before any session exists. `turnstile_site_key` is
// null when Cloudflare Turnstile is disabled on this instance; non-null
// means the client must render the widget and submit a token with
// signup / login / signupViaLink. `max_conferences_per_user` is null when
// the cap is disabled; the Conferences overview surfaces it as a quota
// hint alongside the count the user already owns.
export interface PublicConfigOut {
  signup_enabled: boolean;
  turnstile_site_key: string | null;
  max_conferences_per_user: number | null;
  // Per-user cap on submissions within a single conference. Surfaced so the
  // Sessions tab can show "X of N submitted" before the user tries to add
  // their (N+1)th one.
  max_sessions_per_user_per_conference: number | null;
}

// ----- chat (see plans/chat.md) ------------------------------------------

// One conversation row in the user's inbox. `accepted=false` means the row
// belongs in the "Requests" bucket (first message from a stranger; receiver
// hasn't replied or explicitly accepted). The `i_blocked` / `they_blocked`
// flags drive the conversation-header affordances (Unblock vs disabled
// composer with reason).
export interface ConversationOut {
  id: number;
  conference_id: number;
  other_identity_id: number;
  other_name: string | null;
  other_profile_published: boolean;
  accepted: boolean;
  last_message_at: number | null;
  // First ~80 chars of the latest message body. `null` when the latest
  // message has been soft-deleted (any deleted_reason). Lets the inbox
  // render a "[message removed]" placeholder without a second fetch.
  last_message_preview: string | null;
  unread_count: number;
  i_blocked: boolean;
  they_blocked: boolean;
  created_at: number;
}

export interface MessageOut {
  id: number;
  conversation_id: number;
  sender_identity_id: number;
  // null when deleted_at is set (the sender / receiver still sees a placeholder
  // in their UI; mods see the original via the report-review payload).
  body: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  // "user" | "moderator" | "account_deleted" | "conference_deleted"
  deleted_reason: string | null;
  // Present on the SENDER's view only when the RECEIVER has
  // chatReadReceiptsEnabled=true. The receiver always sees their own read
  // state locally for unread badging — that's not driven by this field.
  read_at: number | null;
}

// Compact row for the paginated chat-reports list view. Just enough to
// render the inbox row + sort/filter; the surrounding-message window and
// edit revisions live on `MessageReportOut` and are fetched lazily when
// the moderator opens the report sheet.
export interface MessageReportSummaryOut {
  id: number;
  message_id: number;
  conversation_id: number;
  reason: string;
  reporter_identity_id: number;
  reporter_name: string | null;
  reported_sender_identity_id: number;
  reported_sender_name: string | null;
  // First ~120 chars of the reported message body, or null when the message
  // has been soft-deleted (the sheet still loads the original via `getChatReport`).
  message_preview: string | null;
  created_at: number;
  resolved_at: number | null;
  action: "dismiss" | "warn" | "ban" | null;
}

// Mod-only report payload. Carries the reported message + its full edit
// history + a small surrounding window so the moderator can judge intent
// without paging through the conversation manually.
export interface MessageReportOut {
  id: number;
  message_id: number;
  conversation_id: number;
  reason: string;
  reporter_identity_id: number;
  reporter_name: string | null;
  reported_sender_identity_id: number;
  reported_sender_name: string | null;
  created_at: number;
  resolved_at: number | null;
  resolved_by_user_id: number | null;
  action: "dismiss" | "warn" | "ban" | null;
  message: MessageOut;
  revisions: Array<{ body: string; created_at: number }>;
  surrounding_messages: MessageOut[];
}

// Banned-identity row for the mod surface. `banned_by` resolves to a
// display name (owner User name or email fallback).
export interface ChatBanOut {
  identity_id: number;
  name: string | null;
  reason: string | null;
  banned_at: number;
  banned_by: string | null;
}

// Self chat settings. Returned by chat.settings.get so the editor doesn't
// need to derive them from a profile fetch.
export interface ChatSettingsOut {
  chat_enabled: boolean;
  read_receipts_enabled: boolean;
  chat_banned: boolean;
  chat_ban_reason: string | null;
}
