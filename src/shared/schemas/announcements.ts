// Broadcast (Day-of Live Mode). A moderator sends one short message that fans
// out as an `announcement` notification to every conference identity.

import * as v from "valibot";

export const AnnouncementSendSchema = v.object({
  message: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "Write a message to send."),
    v.maxLength(300, "Keep it under 300 characters."),
  ),
});
export type AnnouncementSendInput = v.InferOutput<typeof AnnouncementSendSchema>;
