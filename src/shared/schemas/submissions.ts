// Submission create/update valibot schemas.

import * as v from "valibot";
import { LabelList, NonEmpty, PosInt } from "./primitives";

// One speaker row for the mod-only Speakers editor. EXACTLY ONE of `identity_id`
// (a registered conference identity) or `name` (a free-form typed name) must be
// set — the server rejects a row with neither or both. Modeled with both keys
// optional (rather than a union) so the "both set" case survives validation and
// can be rejected explicitly. Free-form names are trimmed + length-bounded here.
export const SpeakerInputSchema = v.object({
  identity_id: v.optional(PosInt),
  name: v.optional(v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "Speaker name is required."),
    v.maxLength(80, "Keep speaker names under 80 characters."),
  )),
});
export type SpeakerInput = v.InferOutput<typeof SpeakerInputSchema>;

// The effective-speaker list a mod sets on a session. Capped at 10. Empty /
// omitted means "default to the submitter" (the server clears explicit rows).
export const SpeakerList = v.pipe(
  v.array(SpeakerInputSchema),
  v.maxLength(10, "Too many speakers — keep it under 10."),
);

export const CreateSubmissionSchema = v.object({
  title: NonEmpty("Title"),
  description: v.optional(v.string()),
  tags: v.optional(LabelList),
  requirements: v.optional(LabelList),
  // Required room features (tag values that the assigned room must carry).
  // The server filters to tags that actually exist on a room in this
  // conference and silently drops anything else.
  room_requirements: v.optional(LabelList),
  // Moderator-only fields available at create time so a mod can fully
  // configure a session in one step instead of create-then-edit. Same
  // semantics as their counterparts on UpdateSubmissionSchema; the server
  // enforces role.
  max_placements: v.optional(v.union([PosInt, v.null()])),
  manually_finished: v.optional(v.boolean()),
  pre_assigned_room_id: v.optional(v.union([PosInt, v.null()])),
  allow_overlapping_placements: v.optional(v.boolean()),
  priority: v.optional(v.picklist(["low", "normal", "high"])),
  /** ConferenceIdentity.id to attribute the submission to. Defaults to the
   * actor when omitted. Mods use this when they submit on someone else's
   * behalf so the speaker appears as the author from day one. */
  submitter_id: v.optional(PosInt),
  /** Mod-only effective-speaker list. When provided, REPLACES the session's
   * speaker rows (registered identities and/or free-form names). Omitted =
   * leave unchanged; empty array = clear back to "default to the submitter". */
  speakers: v.optional(SpeakerList),
});
export type CreateSubmissionInput = v.InferOutput<typeof CreateSubmissionSchema>;

export const UpdateSubmissionSchema = v.object({
  title: v.optional(NonEmpty("Title")),
  description: v.optional(v.string()),
  tags: v.optional(LabelList),
  requirements: v.optional(LabelList),
  room_requirements: v.optional(LabelList),
  // Moderator-only fields. The server enforces role; the schema just shapes
  // them. `max_placements`: null = inherit conference default; integer = cap.
  // `manually_finished`: true forces the session out of the pool / hidden
  // from participants regardless of placement count.
  max_placements: v.optional(v.union([PosInt, v.null()])),
  manually_finished: v.optional(v.boolean()),
  // Moderator-only pre-assignment to a specific room id. `null` clears the
  // pre-assignment; positive integer pins this submission to that room in
  // every unconference slot it lands in. The server validates the room
  // belongs to the same conference; it also refuses to run an assignment
  // for a slot in which two pre-assigned submissions would compete for the
  // same room.
  pre_assigned_room_id: v.optional(v.union([PosInt, v.null()])),
  // Moderator-only: when true, this session can run in multiple
  // overlapping slots (its submitter can also be the host of overlapping
  // placements). Default false enforces the no-overlap rule.
  allow_overlapping_placements: v.optional(v.boolean()),
  // Moderator-only assignment fill priority. high = place & fill first,
  // low = last; default normal.
  priority: v.optional(v.picklist(["low", "normal", "high"])),
  // Moderator-only: reassign the submitter to another conference identity
  // (ConferenceIdentity.id). Used when a mod creates a submission on
  // someone else's behalf so the actual speaker is shown instead of the
  // mod. The server validates the target identity belongs to this
  // conference.
  submitter_id: v.optional(PosInt),
  // Mod-only effective-speaker list. When provided, REPLACES the session's
  // speaker rows. Omitted = leave unchanged; empty array = clear back to
  // "default to the submitter".
  speakers: v.optional(SpeakerList),
});
export type UpdateSubmissionInput = v.InferOutput<typeof UpdateSubmissionSchema>;
