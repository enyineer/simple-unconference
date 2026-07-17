// Renders a session's EFFECTIVE presenters (the `speakers` list on
// `SubmissionOut`, which always defaults to the submitter when no explicit
// speakers are set). Registered speakers link to their profile via
// `ProfileLink` (when the viewer can load it); free-form speakers render as
// plain text. Names are joined with ", ". Returns null when there's no named
// presenter to show, so callers can guard their surrounding chrome.
//
// This is "who presents". Authorship ("Submitted by X") stays on the
// submitter — see `submitterLabel` in helpers.ts.

import { ProfileLink } from "./ProfileLink";

interface SpeakerListProps {
  slug: string;
  speakers: { identity_id: number | null; name: string; profile_published: boolean }[];
  /** Mods can always navigate to any identity's profile; non-mods only when
   *  the target has a published profile. Matches the ProfileLink contract. */
  isMod: boolean;
}

export function SpeakerList({ slug, speakers, isMod }: SpeakerListProps) {
  const shown = speakers.filter((sp) => sp.name.trim().length > 0);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((sp, i) => (
        <span key={`${sp.identity_id ?? "free"}:${i}`}>
          {i > 0 ? ", " : ""}
          <ProfileLink
            slug={slug}
            identityId={sp.identity_id}
            linkable={isMod || sp.profile_published}
          >
            {sp.name}
          </ProfileLink>
        </span>
      ))}
    </>
  );
}
