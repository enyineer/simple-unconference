// Room CRUD valibot schemas.

import * as v from "valibot";
import { NonEmpty, PosInt, RoomLabelList } from "./primitives";

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
