// Expert-pool, expert, timeframe, and booking valibot schemas.

import * as v from "valibot";
import { ExpertBio, NonEmpty, PosInt } from "./primitives";

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
