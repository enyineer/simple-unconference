// Effective-speaker resolution — the single source of the "default to the
// submitter" rule.
//
// A session's presenters are decoupled from its author (`Submission.submitterId`).
// A session may carry zero or more `SubmissionSpeaker` rows, each either a
// registered conference identity or a free-form typed name. When a session has
// NO speaker rows, its effective speaker is its submitter (preserving the
// pre-feature behavior exactly, including the scheduler's parallel-speaker key).
//
// Everything that needs "who presents this session" — the per-slot scheduler's
// collision key, the busy-attendee set, the displayed presenter list, and the
// manual-placement warning — derives it from here so the default rule can never
// drift between call sites.

// The minimal shape a loaded submission needs for speaker resolution. The
// `identity` / `submitter` relations are optional so callers that only need
// collision keys (which never look at display names) can skip loading them.
export interface SpeakerRowShape {
  identityId: number | null;
  name: string | null;
  identity?: { name: string | null; profilePublished?: boolean } | null;
}

export interface SubmissionSpeakerShape {
  submitterId: number;
  submitter?: { name: string | null; profilePublished?: boolean } | null;
  speakers: SpeakerRowShape[];
}

// One resolved presenter. `key` is the scheduler collision key
// (`identity:<id>` for a registered speaker, `name:<normalized>` for a
// free-form one). `identityId` is null for free-form speakers (they aren't
// attendees). `name` is the display name (`""` when unknown / not loaded).
export interface EffectiveSpeaker {
  key: string;
  identityId: number | null;
  name: string;
  profilePublished: boolean;
}

// Normalize a free-form speaker name for the collision key + dedupe:
// lowercase, trim, collapse internal whitespace. NOT used for display.
export function normalizeSpeakerName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// The aligned list of effective speakers (key + identity id + display name),
// in `position` order for explicit rows. All the other exports derive from
// this so keys, identity ids, and names always agree.
export function effectiveSpeakers(sub: SubmissionSpeakerShape): EffectiveSpeaker[] {
  if (sub.speakers.length > 0) {
    const out: EffectiveSpeaker[] = [];
    for (const s of sub.speakers) {
      if (s.identityId !== null) {
        out.push({
          key: `identity:${s.identityId}`,
          identityId: s.identityId,
          name: s.identity?.name ?? "",
          profilePublished: s.identity?.profilePublished ?? false,
        });
      } else if (s.name !== null) {
        out.push({
          key: `name:${normalizeSpeakerName(s.name)}`,
          identityId: null,
          name: s.name,
          profilePublished: false,
        });
      }
    }
    if (out.length > 0) return out;
  }
  // Default: the submitter is the sole speaker.
  return [{
    key: `identity:${sub.submitterId}`,
    identityId: sub.submitterId,
    name: sub.submitter?.name ?? "",
    profilePublished: sub.submitter?.profilePublished ?? false,
  }];
}

// The scheduler collision key set: two sessions "share a speaker" when their
// key sets intersect. Deduped by construction (Set).
export function effectiveSpeakerKeys(sub: SubmissionSpeakerShape): Set<string> {
  return new Set(effectiveSpeakers(sub).map((s) => s.key));
}

// Identity ids of the effective speakers (registered only; free-form names are
// not attendees). Deduped. Defaults to `[submitterId]`.
export function effectiveSpeakerIdentityIds(sub: SubmissionSpeakerShape): number[] {
  const ids = new Set<number>();
  for (const s of effectiveSpeakers(sub)) {
    if (s.identityId !== null) ids.add(s.identityId);
  }
  return [...ids];
}

// Display names of the effective speakers, in order. Defaults to the
// submitter's name.
export function effectiveSpeakerNames(sub: SubmissionSpeakerShape): string[] {
  return effectiveSpeakers(sub).map((s) => s.name);
}
