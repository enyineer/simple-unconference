import type { Participant, Room, Submission } from "../../types";

// Status filter values used by the Sessions tab. Participants only ever see
// `published`, so the filter chips are mod-only.
export type SessionFilter = "all" | "submitted" | "published" | "rejected";

export type SessionFormProps =
  | (SessionFormCommonProps & { mode: "create"; submission?: undefined })
  | (SessionFormCommonProps & { mode: "edit"; submission: Submission });

export interface SessionFormCommonProps {
  slug: string;
  isMod: boolean;
  conferenceDefaultMaxPlacements: number | null;
  /** Conference rooms — used by the mod-only pre-assignment picker and the
   * "required room features" tag picker. Empty for participants. */
  rooms: Room[];
  /** Conference roster — feeds the mod-only "submitter" picker so a mod
   * who submits on someone else's behalf can attribute the session to the
   * actual speaker. Empty for participants. */
  participants: Participant[];
  /** Distinct tag values across all conference rooms. The "required room
   * features" picker offers exactly these — no free text. */
  availableRoomTags: string[];
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
}
