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
  /** When true, the <a> uses `display: contents` so its children participate
   *  directly in the parent's layout (grid, flex). Use when the link wraps
   *  multiple grid cells AND the row also has sibling content (e.g. action
   *  buttons) that must stay outside the link's hover/decoration scope. */
  asContents?: boolean;
  children: React.ReactNode;
}

export function ProfileLink({ slug, identityId, linkable, asContents, children }: ProfileLinkProps) {
  const [hover, setHover] = useState(false);
  if (identityId == null || !linkable) return <>{children}</>;
  return (
    <a
      href={`#/conferences/${encodeURIComponent(slug)}/p/${identityId}`}
      style={{
        color: "inherit",
        textDecoration: hover ? "underline" : "none",
        cursor: "pointer",
        // display:contents lets the <a> hand its children directly to the
        // parent grid/flex, so siblings (e.g. action buttons) can live
        // outside the link's hover scope. Hover state is still tracked via
        // mouseover on the children (events bubble up to the <a>).
        ...(asContents ? { display: "contents" } : null),
      }}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {children}
    </a>
  );
}
