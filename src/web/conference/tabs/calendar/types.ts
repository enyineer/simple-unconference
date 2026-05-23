// ----- data shapes the calendar needs --------------------------------------

export interface CalSlot {
  id: number;
  type: "normal" | "unconference" | "mixer";
  title: string | null;
  starts_at: number;
  ends_at: number;
}
export interface CalMixerPlacement {
  slot_id: number;
  room_id: number;
  attendee_count: number;
}
export interface CalTrack {
  id: number; slot_id: number; room_id: number;
  /** Path C: every track links to a Submission. The track display title
   *  comes from that submission. */
  submission_id: number;
  title: string;
  speakers: string | null;
  /** Number of participants who starred the linked Submission (drives the
   *  star pill on the calendar). */
  star_count: number;
  /** True when the viewer starred the linked Submission. Toggling the star
   *  hits `submissions.star` / `unstar`, not a per-track endpoint. */
  starred_by_me: boolean;
  /** Moderator-marked "required for everyone" — render a Required badge in
   * place of the star toggle. */
  mandatory: boolean;
}
export interface CalPlacement {
  slot_id: number; submission_id: number; room_id: number;
}
export interface CalRoom { id: number; name: string; capacity: number; }
export interface CalSubmission {
  id: number;
  title: string;
  submitter_name: string | null;
  star_count: number;
  starred_by_me: boolean;
}

export interface CalendarProps {
  slots: CalSlot[];
  tracks: CalTrack[];
  placements: CalPlacement[];
  mixerPlacements: CalMixerPlacement[];
  rooms: CalRoom[];
  subs: CalSubmission[];
  isMod: boolean;
  /** IANA timezone the calendar's wall-clock times are in. */
  timeZone: string;
  /** Selected slot id (shown highlighted). */
  selectedSlotId?: number | null;
  /** Called when a slot is clicked. */
  onSelectSlot?: (id: number) => void;
  /** Called when a slot is dragged or resized — receives new times in ms. */
  onMoveSlot: (id: number, starts_at: number, ends_at: number) => Promise<void>;
  /** Star/unstar a static track. If omitted, star buttons are hidden. */
  onToggleStaticStar?: (track: CalTrack) => Promise<void>;
  /** Star/unstar a submission (unconference placements). */
  onToggleSubmissionStar?: (sub: CalSubmission) => Promise<void>;
}

// For each slot, decide which sub-column index it gets within its overlap
// cluster, and how many sub-columns the cluster has total.
export interface SlotLayout {
  slot: CalSlot;
  col: number;
  cols: number;
}

export interface DragState {
  slotId: number;
  mode: "move" | "resize-top" | "resize-bottom";
  startY: number;
  origStart: number;
  origEnd: number;
  liveStart: number;
  liveEnd: number;
}
