// Shared valibot primitives. Used by every domain schema.
// Re-exported (with `export *`) through `../schemas.ts` for backward
// compatibility, but kept in their own module to declutter the per-domain
// files.

import * as v from "valibot";

export const Email = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.email("Enter a valid email."),
);
export const Password = v.pipe(
  v.string(),
  v.minLength(6, "Password must be at least 6 characters."),
);
export const NonEmpty = (label: string) =>
  v.pipe(v.string(), v.trim(), v.minLength(1, `${label} is required.`));
export const PosInt = v.pipe(
  v.number(),
  v.integer("Must be a whole number."),
  v.minValue(1, "Must be a positive number."),
);

// Optional Cloudflare Turnstile response token. The frontend attaches it when
// TURNSTILE_SITE_KEY is configured on the backend; the server validates it
// against challenges.cloudflare.com/turnstile/v0/siteverify. Always optional
// at the schema level — backend decides whether to require it based on whether
// TURNSTILE_SECRET_KEY is set.
export const TurnstileToken = v.optional(v.pipe(v.string(), v.maxLength(4096)));

// Accepts any string that the runtime's Intl recognizes as a valid IANA
// timezone identifier. Falls back gracefully on platforms without
// `supportedValuesOf` by trying to construct an Intl.DateTimeFormat.
export const TimeZone = v.pipe(
  v.string(),
  v.minLength(1, "Timezone is required."),
  v.check((s) => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return true; }
    catch { return false; }
  }, "Unknown timezone."),
);

// Reuse the same label rules as submission tags: trimmed, 1–40 chars, no commas.
export const RoomLabel = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, "Cannot be empty."),
  v.maxLength(40, "Keep it under 40 characters."),
  v.check((s) => !s.includes(","), "No commas in tags."),
);
export const RoomLabelList = v.pipe(v.array(RoomLabel), v.maxLength(20, "Too many — keep it under 20."));

// A label-like value (tag or requirement). Normalized: trimmed, max 40 chars,
// no commas (commas are the UI delimiter so we forbid them here too).
export const LabelValue = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, "Cannot be empty."),
  v.maxLength(40, "Keep it under 40 characters."),
  v.check((s) => !s.includes(","), "No commas in labels."),
);
export const LabelList = v.pipe(
  v.array(LabelValue),
  v.maxLength(20, "Too many — keep it under 20."),
);

export const ExpertBio = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(2000, "Keep the bio under 2000 characters."),
);
