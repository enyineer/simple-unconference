// Conference-, invite-, join-link-, and identity-related schemas.

import * as v from "valibot";
import { ColorModeSchema } from "./auth";
import {
  Email,
  NonEmpty,
  Password,
  PosInt,
  TimeZone,
  TurnstileToken,
} from "./primitives";

export const CreateConferenceSchema = v.object({
  name: NonEmpty("Conference name"),
  timezone: v.optional(TimeZone),
});
export type CreateConferenceInput = v.InferOutput<typeof CreateConferenceSchema>;

// Clone a conference into a fresh one owned by the same user. `first_day` is
// the epoch-ms of the intended first conference day (a date at midnight in the
// source conference's timezone); slot + room-availability times shift by the
// day delta between it and the source's first slot.
export const DuplicateConferenceSchema = v.object({
  name: NonEmpty("Conference name"),
  first_day: PosInt,
});
export type DuplicateConferenceInput = v.InferOutput<typeof DuplicateConferenceSchema>;

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

// Hand ownership of a conference to another existing global User. Looked up
// by email since the new owner may not have a per-conference identity yet.
export const TransferOwnershipSchema = v.object({
  new_owner_email: Email,
});
export type TransferOwnershipInput = v.InferOutput<typeof TransferOwnershipSchema>;

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
  turnstile_token: TurnstileToken,
});
export type InviteClaimInput = v.InferOutput<typeof InviteClaimSchema>;

// Self-signup via the conference's shared join link. The link is owner-managed
// and gated by a secret token; the participant supplies their own email.
export const SignupViaLinkSchema = v.object({
  token: NonEmpty("Token"),
  email: Email,
  password: Password,
  name: v.optional(v.pipe(v.string(), v.trim())),
  turnstile_token: TurnstileToken,
});
export type SignupViaLinkInput = v.InferOutput<typeof SignupViaLinkSchema>;

// Owner-managed join-link configuration.
export const JoinLinkSetSchema = v.object({
  enabled: v.boolean(),
  expires_at: v.optional(v.union([PosInt, v.null()])),
  max_uses: v.optional(v.union([PosInt, v.null()])),
});
export type JoinLinkSetInput = v.InferOutput<typeof JoinLinkSetSchema>;

// Owner-managed public Live Board link. Enabling mints a token if absent;
// disabling drops it (the URL stops working).
export const BoardLinkSetSchema = v.object({
  enabled: v.boolean(),
});
export type BoardLinkSetInput = v.InferOutput<typeof BoardLinkSetSchema>;

// Per-conference identity preferences. colorMode lives on ConferenceIdentity
// (per-conference), and a participant can also update their display name.
export const UpdateConfMeSchema = v.object({
  color_mode: v.optional(ColorModeSchema),
  name: v.optional(v.pipe(v.string(), v.trim())),
});
export type UpdateConfMeInput = v.InferOutput<typeof UpdateConfMeSchema>;
