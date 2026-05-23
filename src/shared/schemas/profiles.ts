// Profile-related valibot schemas (entries, update patches, list queries,
// per-route slug-bound variants, avatar deletion).

import * as v from "valibot";
import { NonEmpty, PageInputEntries, PosInt } from "./primitives";

// A single entry on a user's profile. Two categories:
//   - link   — websites + social profiles. `value` is the handle/URL label,
//              `href` is the optional click-through target.
//   - contact — phone / email / messenger handle. `href` may be `tel:` /
//              `mailto:` or empty; the UI exposes a copy-to-clipboard.
// `kind` is a free-form label (e.g. "GitHub", "Instagram", "Email"); the
// editor offers a datalist of common values but doesn't constrain it.
export const ProfileEntryInputSchema = v.object({
  kind: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  href: v.optional(v.union([v.pipe(v.string(), v.url()), v.null()])),
  category: v.picklist(["link", "contact"] as const),
  is_public: v.boolean(),
  position: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

// Patch shape for a profile update. Every field is optional — handlers only
// touch keys that are explicitly present in the input. `entries` / `tags`
// use full-replacement semantics: when present, the server wipes and re-
// creates the rows for this identity.
export const ProfileUpdateSchema = v.object({
  profile_published: v.optional(v.boolean()),
  bio: v.optional(v.union([v.pipe(v.string(), v.maxLength(4000)), v.null()])),
  pronouns: v.optional(v.union([v.pipe(v.string(), v.maxLength(64)), v.null()])),
  title: v.optional(v.union([v.pipe(v.string(), v.maxLength(128)), v.null()])),
  company: v.optional(v.union([v.pipe(v.string(), v.maxLength(128)), v.null()])),
  // Marks the first-login completion nudge as dismissed. The UI sets this to
  // true after the user clicks the banner's "Dismiss" button.
  profile_completion_dismissed: v.optional(v.boolean()),
  entries: v.optional(v.array(ProfileEntryInputSchema)),
  tags: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(48))),
      v.maxLength(20, "Too many tags — keep it under 20."),
    ),
  ),
});

export type ProfileEntryInput = v.InferOutput<typeof ProfileEntryInputSchema>;
export type ProfileUpdateInput = v.InferOutput<typeof ProfileUpdateSchema>;

export const ProfileListQuerySchema = v.object({
  slug: NonEmpty("Slug"),
  // Single optional tag chip filter. Free-text matches go through the shared
  // `q` param defined in PageInputEntries so every paginated list uses the
  // same name.
  tag: v.optional(v.pipe(v.string(), v.maxLength(48))),
  ...PageInputEntries,
});

export const ProfileGetSchema = v.object({
  slug: NonEmpty("Slug"),
  identity_id: PosInt,
});

export const ProfileUpdateMineSchema = v.object({
  slug: NonEmpty("Slug"),
  ...ProfileUpdateSchema.entries,
});

export const ProfileUpdateAnySchema = v.object({
  slug: NonEmpty("Slug"),
  identity_id: PosInt,
  ...ProfileUpdateSchema.entries,
});

// Mod can pass `identity_id` to delete another participant's avatar;
// participants omit it and the handler defaults to the actor's own id.
export const ProfileDeleteAvatarSchema = v.object({
  slug: NonEmpty("Slug"),
  identity_id: v.optional(PosInt),
});
