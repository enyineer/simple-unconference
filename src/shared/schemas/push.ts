// Web Push subscription schemas. The browser produces the endpoint + keys when
// the participant opts into OS-level notifications (see
// `pushManager.subscribe`); we persist them per conference identity so
// `createNotification` can fan a push out to every registered device.

import * as v from "valibot";

// Push-service endpoint URL. Bounded generously — FCM/Mozilla/Apple endpoints
// are well under 1KB but the spec sets no hard limit.
const PushEndpoint = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, "Missing push endpoint."),
  v.maxLength(2048, "Push endpoint too long."),
);

// URL-safe base64 keys handed to us by the browser subscription. `p256dh` is
// the client's public key, `auth` the shared auth secret — both required to
// encrypt the payload.
const PushKey = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, "Missing push key."),
  v.maxLength(512, "Push key too long."),
);

export const PushSubscribeSchema = v.object({
  endpoint: PushEndpoint,
  keys: v.object({ p256dh: PushKey, auth: PushKey }),
  // Optional UA string so a mod could later tell devices apart; never shown to
  // other users.
  user_agent: v.optional(v.union([v.pipe(v.string(), v.maxLength(512)), v.null()])),
});
export type PushSubscribeInput = v.InferOutput<typeof PushSubscribeSchema>;

export const PushUnsubscribeSchema = v.object({
  endpoint: PushEndpoint,
});
export type PushUnsubscribeInput = v.InferOutput<typeof PushUnsubscribeSchema>;
