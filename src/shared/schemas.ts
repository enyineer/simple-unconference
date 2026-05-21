// Shared valibot schemas. Imported by both server (request validation) and
// web (form validation). Keep these the source of truth for "what is a valid
// X" — server enforces, client previews errors before submit.

import * as v from "valibot";

// ----- primitives ---------------------------------------------------------

const Email = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.email("Enter a valid email."),
);
const Password = v.pipe(
  v.string(),
  v.minLength(6, "Password must be at least 6 characters."),
);
const NonEmpty = (label: string) =>
  v.pipe(v.string(), v.trim(), v.minLength(1, `${label} is required.`));
const PosInt = v.pipe(
  v.number(),
  v.integer("Must be a whole number."),
  v.minValue(1, "Must be a positive number."),
);

// ----- auth ---------------------------------------------------------------

export const SignupSchema = v.object({
  email: Email,
  password: Password,
  name: v.optional(v.pipe(v.string(), v.trim())),
});
export type SignupInput = v.InferOutput<typeof SignupSchema>;

export const ColorModeSchema = v.picklist(["auto", "light", "dark"] as const);
export type ColorMode = v.InferOutput<typeof ColorModeSchema>;

export const LoginSchema = v.object({
  email: Email,
  password: v.pipe(v.string(), v.minLength(1, "Password is required.")),
});
export type LoginInput = v.InferOutput<typeof LoginSchema>;

// ----- conferences --------------------------------------------------------

// Accepts any string that the runtime's Intl recognizes as a valid IANA
// timezone identifier. Falls back gracefully on platforms without
// `supportedValuesOf` by trying to construct an Intl.DateTimeFormat.
const TimeZone = v.pipe(
  v.string(),
  v.minLength(1, "Timezone is required."),
  v.check((s) => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return true; }
    catch { return false; }
  }, "Unknown timezone."),
);

export const CreateConferenceSchema = v.object({
  name: NonEmpty("Conference name"),
  timezone: v.optional(TimeZone),
});
export type CreateConferenceInput = v.InferOutput<typeof CreateConferenceSchema>;

export const UpdateConferenceSchema = v.object({
  name: v.optional(NonEmpty("Conference name")),
  design_system: v.optional(v.string()),
  timezone: v.optional(TimeZone),
  // Default for new mixer slots' avoid-repeats mode. When true, exclusive mix
  // is the default; participants don't get re-paired across mixers. Slots can
  // override this individually.
  mixer_avoid_repeats_default: v.optional(v.boolean()),
  // Default cap on how many times a published submission can be placed in the
  // conference. `null` = unlimited; positive integer = the cap. Per-submission
  // overrides live on Submission.max_placements.
  submission_max_placements_default: v.optional(v.union([PosInt, v.null()])),
  // When false, only owners + moderators can submit sessions in this
  // conference. Mods/owners can still create submissions either way.
  participant_submissions_enabled: v.optional(v.boolean()),
});
export type UpdateConferenceInput = v.InferOutput<typeof UpdateConferenceSchema>;

// ----- invites + per-conference identities --------------------------------

export const InviteCreateSchema = v.object({
  email: Email,
});
export type InviteCreateInput = v.InferOutput<typeof InviteCreateSchema>;

// Bulk-invite: one email per line (the old participant CSV minus password
// columns — passwords are now set by the participant on first claim).
export const InviteImportSchema = v.object({
  csv: NonEmpty("CSV"),
});
export type InviteImportInput = v.InferOutput<typeof InviteImportSchema>;

// Invite claim: the participant clicks the email link and sets their own
// credentials. `token` is the opaque invite token from the URL.
export const InviteClaimSchema = v.object({
  token: NonEmpty("Token"),
  password: Password,
  name: v.optional(v.pipe(v.string(), v.trim())),
});
export type InviteClaimInput = v.InferOutput<typeof InviteClaimSchema>;

// Self-signup via the conference's shared join link. The link is owner-managed
// and gated by a secret token; the participant supplies their own email.
export const SignupViaLinkSchema = v.object({
  token: NonEmpty("Token"),
  email: Email,
  password: Password,
  name: v.optional(v.pipe(v.string(), v.trim())),
});
export type SignupViaLinkInput = v.InferOutput<typeof SignupViaLinkSchema>;

// Conference-scoped login. Email is unique per-conference so the slug is
// already implicit in the route input — no global lookup happens.
export const ConfLoginSchema = v.object({
  email: Email,
  password: v.pipe(v.string(), v.minLength(1, "Password is required.")),
});
export type ConfLoginInput = v.InferOutput<typeof ConfLoginSchema>;

// Owner-managed join-link configuration.
export const JoinLinkSetSchema = v.object({
  enabled: v.boolean(),
  expires_at: v.optional(v.union([PosInt, v.null()])),
  max_uses: v.optional(v.union([PosInt, v.null()])),
});
export type JoinLinkSetInput = v.InferOutput<typeof JoinLinkSetSchema>;

// Per-conference identity preferences. colorMode lives on ConferenceIdentity
// (per-conference), and a participant can also update their display name.
export const UpdateConfMeSchema = v.object({
  color_mode: v.optional(ColorModeSchema),
  name: v.optional(v.pipe(v.string(), v.trim())),
});
export type UpdateConfMeInput = v.InferOutput<typeof UpdateConfMeSchema>;

// ----- rooms --------------------------------------------------------------

// Reuse the same label rules as submission tags: trimmed, 1–40 chars, no commas.
const RoomLabel = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, "Cannot be empty."),
  v.maxLength(40, "Keep it under 40 characters."),
  v.check((s) => !s.includes(","), "No commas in tags."),
);
const RoomLabelList = v.pipe(v.array(RoomLabel), v.maxLength(20, "Too many — keep it under 20."));

export const CreateRoomSchema = v.object({
  name: NonEmpty("Room name"),
  capacity: PosInt,
  description: v.optional(v.union([v.string(), v.null()])),
  tags: v.optional(RoomLabelList),
});
export type CreateRoomInput = v.InferOutput<typeof CreateRoomSchema>;

export const UpdateRoomSchema = v.object({
  name: v.optional(NonEmpty("Room name")),
  capacity: v.optional(PosInt),
  description: v.optional(v.union([v.string(), v.null()])),
  tags: v.optional(RoomLabelList),
});
export type UpdateRoomInput = v.InferOutput<typeof UpdateRoomSchema>;

// ----- submissions --------------------------------------------------------

// A label-like value (tag or requirement). Normalized: trimmed, max 40 chars,
// no commas (commas are the UI delimiter so we forbid them here too).
const LabelValue = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, "Cannot be empty."),
  v.maxLength(40, "Keep it under 40 characters."),
  v.check((s) => !s.includes(","), "No commas in labels."),
);
const LabelList = v.pipe(
  v.array(LabelValue),
  v.maxLength(20, "Too many — keep it under 20."),
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
});
export type UpdateSubmissionInput = v.InferOutput<typeof UpdateSubmissionSchema>;

// ----- agenda -------------------------------------------------------------

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
  submission_id: v.optional(v.union([v.number(), v.null()])),
  title: v.optional(v.union([v.string(), v.null()])),
  // Free-text speakers, e.g. "Alice, Bob". null/empty clears.
  speakers: v.optional(v.union([v.string(), v.null()])),
  // Per-track prerequisites (e.g. "laptop", "github account"). Same label
  // shape as submission requirements; replaces the track's set on save.
  requirements: v.optional(LabelList),
  // When true, the track is force-attended for every participant (keynotes,
  // welcome/closing). Mods set this from the track editor.
  mandatory: v.optional(v.boolean()),
});
export type TrackAssignmentInput = v.InferOutput<typeof TrackAssignmentSchema>;

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

// ----- experts ------------------------------------------------------------

const ExpertBio = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(2000, "Keep the bio under 2000 characters."),
);

export const CreateExpertPoolSchema = v.object({
  name: v.pipe(NonEmpty("Pool name"), v.maxLength(60, "Keep it under 60 characters.")),
  room_ids: v.optional(v.array(PosInt)),
});
export type CreateExpertPoolInput = v.InferOutput<typeof CreateExpertPoolSchema>;

export const UpdateExpertPoolSchema = v.object({
  name: v.optional(v.pipe(NonEmpty("Pool name"), v.maxLength(60, "Keep it under 60 characters."))),
  room_ids: v.optional(v.array(PosInt)),
});
export type UpdateExpertPoolInput = v.InferOutput<typeof UpdateExpertPoolSchema>;

export const PromoteExpertSchema = v.object({
  identity_id: PosInt,
  bio: v.optional(ExpertBio),
  pool_id: v.optional(v.union([PosInt, v.null()])),
  room_ids: v.optional(v.array(PosInt)),
});
export type PromoteExpertInput = v.InferOutput<typeof PromoteExpertSchema>;

export const UpdateExpertSchema = v.object({
  bio: v.optional(v.union([ExpertBio, v.null()])),
  pool_id: v.optional(v.union([PosInt, v.null()])),
  room_ids: v.optional(v.array(PosInt)),
});
export type UpdateExpertInput = v.InferOutput<typeof UpdateExpertSchema>;

// Bookable timeframe. Slot duration is in minutes, 5..480 (8 hours max).
const SlotMinutes = v.pipe(
  v.number(),
  v.integer("Must be a whole number."),
  v.minValue(5, "At least 5 minutes."),
  v.maxValue(480, "Keep it under 8 hours."),
);

export const CreateExpertTimeframeSchema = v.pipe(
  v.object({
    starts_at: PosInt,
    ends_at: PosInt,
    slot_duration_minutes: SlotMinutes,
  }),
  v.forward(
    v.check((i) => i.ends_at > i.starts_at, "End time must be after start time."),
    ["ends_at"],
  ),
  v.forward(
    v.check(
      (i) => (i.ends_at - i.starts_at) >= i.slot_duration_minutes * 60_000,
      "Timeframe must fit at least one slot.",
    ),
    ["slot_duration_minutes"],
  ),
);
export type CreateExpertTimeframeInput = v.InferOutput<typeof CreateExpertTimeframeSchema>;

// Participant books a specific slot of an expert by `starts_at` epoch ms.
export const BookExpertSchema = v.object({
  expert_id: PosInt,
  starts_at: PosInt,
});
export type BookExpertInput = v.InferOutput<typeof BookExpertSchema>;

// ----- helpers ------------------------------------------------------------

/**
 * Field-level error map produced by valibot, keyed by dotted path.
 * Server returns this on 400; client renders inline next to inputs.
 */
export interface FieldErrors {
  [path: string]: string;
}

export function toFieldErrors(issues: v.BaseIssue<unknown>[]): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const path = (issue.path ?? [])
      .map((p) => String((p as { key: PropertyKey }).key))
      .join(".") || "_";
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

/**
 * Server-side helper: parse with valibot, returning either { ok: true, data }
 * or { ok: false, errors } in a structured shape suitable for `c.json(...)`.
 */
export function safeParse<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
): { ok: true; data: v.InferOutput<TSchema> }
  | { ok: false; errors: FieldErrors } {
  const result = v.safeParse(schema, input);
  if (result.success) return { ok: true, data: result.output };
  return { ok: false, errors: toFieldErrors(result.issues) };
}
