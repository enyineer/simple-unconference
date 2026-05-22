// Central wrapper for every place in the conference UI that renders a
// person's name. Turns the name into a hash-route link to that identity's
// profile page; styles are intentionally inherited so the wrapping is
// visually transparent until hover (then a subtle underline).
//
// Renders as plain text (no link) when either:
//   - `identityId` is null (e.g. an unclaimed-invite placeholder), or
//   - `linkable` is false (the target has no published profile and the
//     viewer isn't a moderator who could see it anyway).
// This avoids dead-end clicks to "Profile not found or not published."

import { useState } from "react";

interface ProfileLinkProps {
  slug: string;
  identityId: number | null;
  /** True iff the viewer can actually load the target profile —
   *  computed by the caller as `viewerIsMod || target.profile_published`. */
  linkable: boolean;
  children: React.ReactNode;
}

export function ProfileLink({ slug, identityId, linkable, children }: ProfileLinkProps) {
  const [hover, setHover] = useState(false);
  if (identityId == null || !linkable) return <>{children}</>;
  return (
    <a
      href={`#/conferences/${encodeURIComponent(slug)}/p/${identityId}`}
      style={{
        color: "inherit",
        textDecoration: hover ? "underline" : "none",
        cursor: "pointer",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
    </a>
  );
}
