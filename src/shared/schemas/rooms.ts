// Room CRUD valibot schemas.

import * as v from "valibot";
import { NonEmpty, PosInt, RoomLabelList } from "./primitives";

// One availability window. Epoch-ms bounds; the end must be strictly after the
// start (mirrors CreateExpertTimeframeSchema's forward/check precedent).
const AvailabilityWindow = v.pipe(
  v.object({ starts_at: PosInt, ends_at: PosInt }),
  v.forward(
    v.check((w) => w.ends_at > w.starts_at, "End time must be after start time."),
    ["ends_at"],
  ),
);

// Optional list of availability windows. Omitted = leave unchanged (update) /
// none (create). An explicit empty array clears all windows → always available.
export const RoomAvailabilityList = v.optional(v.array(AvailabilityWindow));

export const CreateRoomSchema = v.object({
  name: NonEmpty("Room name"),
  capacity: PosInt,
  description: v.optional(v.union([v.string(), v.null()])),
  tags: v.optional(RoomLabelList),
  availability: RoomAvailabilityList,
});
export type CreateRoomInput = v.InferOutput<typeof CreateRoomSchema>;

export const UpdateRoomSchema = v.object({
  name: v.optional(NonEmpty("Room name")),
  capacity: v.optional(PosInt),
  description: v.optional(v.union([v.string(), v.null()])),
  tags: v.optional(RoomLabelList),
  availability: RoomAvailabilityList,
});
export type UpdateRoomInput = v.InferOutput<typeof UpdateRoomSchema>;
