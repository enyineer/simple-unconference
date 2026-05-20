// Shared types between server and web.

export type ID = number;

export interface User {
  id: ID;
  email: string;
  name: string | null;
  created_at: number;
}

export interface Conference {
  id: ID;
  name: string;
  slug: string;
  owner_id: ID;
  created_at: number;
}

export type ConferenceRole = "owner" | "moderator" | "participant";

export interface Participant {
  user_id: ID;
  conference_id: ID;
  role: ConferenceRole;
  email: string;
  name: string | null;
}

export interface Room {
  id: ID;
  conference_id: ID;
  name: string;
  capacity: number;
}

export type SessionStatus = "submitted" | "published" | "rejected";

export interface Submission {
  id: ID;
  conference_id: ID;
  submitter_id: ID;
  title: string;
  description: string;
  status: SessionStatus;
  star_count?: number;
  starred_by_me?: boolean;
  created_at: number;
}

export type SlotType = "normal" | "unconference" | "mixer";

export interface AgendaSlot {
  id: ID;
  conference_id: ID;
  type: SlotType;
  title: string | null;        // for normal slots
  description: string | null;  // for normal slots
  starts_at: number;           // epoch ms
  ends_at: number;             // epoch ms
  // For normal slots: track assignments are explicit (admin picks talks per room).
  // For unconference slots: filled by the assignment algorithm.
}

export interface TrackAssignment {
  id: ID;
  slot_id: ID;
  room_id: ID;
  submission_id: ID | null;  // present for normal-slot track entries
  title: string | null;       // ad-hoc title for normal slot if no submission
}

export interface UnconferencePlacement {
  slot_id: ID;
  submission_id: ID;
  room_id: ID;
}

// Algorithm output for unconference slots: each placed user is paired with
// a submission. The room is implied by the placement of that submission.
// Users with no fit go into `unplaced_users` instead.
export interface UserAssignment {
  slot_id: ID;
  user_id: ID;
  submission_id: ID;
}

export interface AssignmentResult {
  placements: UnconferencePlacement[];
  user_assignments: UserAssignment[];
  unplaced_users: ID[]; // users with all stars full -> hint to pick another
}

// Algorithm output for mixer slots: each placed user is paired with a room.
// No submission involved. Mirrors the AssignmentResult shape so callers can
// branch by slot type without juggling unrelated structures.
export interface RoomAssignment {
  slot_id: ID;
  user_id: ID;
  room_id: ID;
}

export interface MixerResult {
  room_assignments: RoomAssignment[];
  unplaced_users: ID[];
}
