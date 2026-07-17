// Session takeaways (Harvest & Wrap-up, F3). Anyone in a conference can capture
// a short learning / link against a published session; the note is visible to
// every member of the conference.

import * as v from "valibot";
import { PosInt } from "./primitives";

// An optional http(s) link. valibot's `url()` accepts any scheme (mailto:,
// javascript:, …), so we additionally require http/https to keep takeaway
// links web-safe.
const HttpUrl = v.pipe(
  v.string(),
  v.trim(),
  v.url("Enter a valid URL."),
  v.check((s) => /^https?:\/\//i.test(s), "Links must start with http:// or https://."),
  v.maxLength(2000, "Keep the link under 2000 characters."),
);

export const TakeawayAddSchema = v.object({
  submission_id: PosInt,
  text: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "Write a takeaway."),
    v.maxLength(500, "Keep it under 500 characters."),
  ),
  url: v.optional(v.union([HttpUrl, v.null()])),
});
export type TakeawayAddInput = v.InferOutput<typeof TakeawayAddSchema>;
