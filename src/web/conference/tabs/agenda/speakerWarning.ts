// Formats the non-blocking `speaker_warning` heads-up returned alongside a
// successful manual placement (scheduleSubmission / placeSubmission / setTrack)
// when one of the placed session's effective speakers is already presenting in
// a time-overlapping slot. The placement already committed — this is surfaced
// as a warning toast, never an error. Mirrors the room-overlap holder note.

import type { SpeakerOverlapHolder } from "../../../../shared/contract";

export function speakerWarningMessage(w: SpeakerOverlapHolder): string {
  const where = w.room_name ? ` in ${w.room_name}` : "";
  return `Heads up: ${w.speaker_name} is also presenting "${w.session_title}" at ${w.slot_label}${where}.`;
}
