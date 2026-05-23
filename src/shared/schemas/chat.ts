// Chat-related valibot schemas (message body, report reason, settings patch).
// See plans/chat.md for the full eligibility / privacy / rate-limit rules.
//
// Body byte cap is enforced server-side via LIMITS.chatMessageMaxBytes in
// limits.ts (env-overridable). The 4096-char check here is a UI-friendly
// upper bound used to fail fast on the client; the server is authoritative.

import * as v from "valibot";

export const MessageBody = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, "message_required"),
  v.maxLength(4096, "message_too_long"),
);

export const ReportReason = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, "reason_required"),
  v.maxLength(500, "reason_too_long"),
);

// Settings patch: both fields are optional so the editor can flip them
// independently.
export const ChatSettingsUpdateSchema = v.object({
  chat_enabled: v.optional(v.boolean()),
  read_receipts_enabled: v.optional(v.boolean()),
});

// Resolve-report action enum. `mod_reason` is the moderator's own free-form
// note: for `warn` it lands in the chat_warning notification body, for `ban`
// it lands in ConferenceIdentity.chatBannedReason. Falls back to the
// reporter's reason on the server when omitted.
export const ChatResolveReportSchema = v.object({
  action: v.picklist(["dismiss", "warn", "ban"] as const),
  mod_reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
});
