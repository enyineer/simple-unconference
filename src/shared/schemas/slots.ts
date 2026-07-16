// Agenda slot + slot-series valibot schemas (create/update/duplicate, track
// assignment, schedule submission).

import * as v from "valibot";
import { LabelList, PosInt } from "./primitives";

export const SlotTypeSchema = v.picklist(["normal", "unconference", "mixer"] as const);

export const CreateSlotSchema = v.pipe(
  v.object({
    type: SlotTypeSchema,
    title: v.optional(v.union([v.string(), v.null()])),
    description: v.optional(v.union([v.string(), v.null()])),
    starts_at: PosInt,
    ends_at: PosInt,
    // Mixer-only at creation time. `null`/omitted = inherit conference default;
    // `true`/`false` set the slot's override immediately. Ignored for non-mixer
    // slot types.
    mixer_avoid_repeats: v.optional(v.union([v.boolean(), v.null()])),
  }),
  v.forward(
    v.check((input) => input.ends_at > input.starts_at, "End time must be after start time."),
    ["ends_at"],
  ),
);
export type CreateSlotInput = v.InferOutput<typeof CreateSlotSchema>;

export const TrackAssignmentSchema = v.object({
  room_id: PosInt,
  // Required: every planned track is anchored to a Submission. For invited
  // speakers without participant accounts, the mod first creates a
  // Submission for them on the Sessions tab, then schedules it here.
  submission_id: PosInt,
  // Optional addendum text appended to the submitter's name when listing
  // speakers (for co-presenters or guest names). null/empty clears.
  speakers: v.optional(v.union([v.string(), v.null()])),
  // Per-track prerequisites (e.g. "laptop", "github account"). Same label
  // shape as submission requirements; replaces the track's set on save.
  requirements: v.optional(LabelList),
  // When true, the track is force-attended for every participant (keynotes,
  // welcome/closing). Mods set this from the track editor.
  mandatory: v.optional(v.boolean()),
});
export type TrackAssignmentInput = v.InferOutput<typeof TrackAssignmentSchema>;

// `agenda.scheduleSubmission`: like `setTrack`, but the server picks the
// room. Honors `Submission.preAssignedRoomId` (hard pin) and
// `Submission.roomRequirements` (tag constraints); picks the largest free
// matching room otherwise. Returns a structured conflict when no room fits.
export const ScheduleSubmissionSchema = v.object({
  submission_id: PosInt,
  speakers: v.optional(v.union([v.string(), v.null()])),
  requirements: v.optional(LabelList),
  mandatory: v.optional(v.boolean()),
});
export type ScheduleSubmissionInput = v.InferOutput<typeof ScheduleSubmissionSchema>;

// `agenda.placeSubmission`: moderator authors an unconference occurrence —
// a session running in a specific slot + room. `room_id` is optional; when
// omitted the server auto-picks (honoring the submission's pin / room
// requirements / largest free room, like `scheduleSubmission`). The global
// attendee router then assigns participants over these placements.
export const PlacementPinSchema = v.object({
  submission_id: PosInt,
  room_id: v.optional(PosInt),
});
export type PlacementPinInput = v.InferOutput<typeof PlacementPinSchema>;

// PATCH /agenda/:id — moderators can tweak time, title, and the per-slot
// unconference configuration (which rooms / which submissions participate).
export const UpdateSlotSchema = v.pipe(
  v.object({
    title:       v.optional(v.union([v.string(), v.null()])),
    description: v.optional(v.union([v.string(), v.null()])),
    starts_at:   v.optional(PosInt),
    ends_at:     v.optional(PosInt),
    unconf_use_all_rooms:       v.optional(v.boolean()),
    unconf_use_all_submissions: v.optional(v.boolean()),
    unconf_avoid_repeats:       v.optional(v.boolean()),
    // Mixer-only per-slot override of the conference's default avoid-repeats
    // mode. `null` = inherit conference default; `true` = exclusive mix;
    // `false` = fresh shuffle ignoring prior mixers.
    mixer_avoid_repeats:        v.optional(v.union([v.boolean(), v.null()])),
    unconf_room_ids:       v.optional(v.array(PosInt)),
    unconf_submission_ids: v.optional(v.array(PosInt)),
  }),
  v.forward(
    v.check(
      (input) =>
        input.starts_at === undefined ||
        input.ends_at === undefined ||
        input.ends_at > input.starts_at,
      "End time must be after start time.",
    ),
    ["ends_at"],
  ),
);
export type UpdateSlotInput = v.InferOutput<typeof UpdateSlotSchema>;

// ----- slot series --------------------------------------------------------

// Mods duplicate an existing slot to create a "linked offering" of it. The
// new sibling shares the source slot's series (creating one if needed) and
// gets its own time window. `title` is optional per-instance override; if
// omitted the new sibling inherits the source's title.
export const DuplicateSlotSchema = v.pipe(
  v.object({
    new_starts_at: PosInt,
    new_ends_at: PosInt,
    title: v.optional(v.union([v.string(), v.null()])),
  }),
  v.forward(
    v.check((input) => input.new_ends_at > input.new_starts_at, "End time must be after start time."),
    ["new_ends_at"],
  ),
);
export type DuplicateSlotInput = v.InferOutput<typeof DuplicateSlotSchema>;

// Series-level edit. All fields are series-owned (mirroring UpdateSlotSchema
// but without per-instance time/title/description). If the edit would
// orphan track assignments or unconference placements in any sibling, the
// server returns a "needs_confirmation" response; the client re-submits
// with `confirm: true` to cascade-delete the orphans.
export const UpdateSlotSeriesSchema = v.object({
  title:       v.optional(v.union([v.string(), v.null()])),
  description: v.optional(v.union([v.string(), v.null()])),
  unconf_use_all_rooms:       v.optional(v.boolean()),
  unconf_use_all_submissions: v.optional(v.boolean()),
  unconf_avoid_repeats:       v.optional(v.boolean()),
  mixer_avoid_repeats:        v.optional(v.union([v.boolean(), v.null()])),
  avoid_repeats_across_siblings: v.optional(v.boolean()),
  unconf_room_ids:       v.optional(v.array(PosInt)),
  unconf_submission_ids: v.optional(v.array(PosInt)),
  confirm: v.optional(v.boolean()),
});
export type UpdateSlotSeriesInput = v.InferOutput<typeof UpdateSlotSeriesSchema>;

// Pitch Mode: set (or clear) the conference's spotlight session for the Live
// Board. `submission_id: null` ends the spotlight. Mod-only server-side.
export const SpotlightSchema = v.object({
  submission_id: v.union([PosInt, v.null()]),
});
export type SpotlightInput = v.InferOutput<typeof SpotlightSchema>;
