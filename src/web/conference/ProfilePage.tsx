// Profile viewer. Loaded by the hash route `/conferences/:slug/p/:identityId`.
//
// Shows the published profile of an identity to anyone allowed to see it
// (the server enforces the visibility rules; non-mod, non-self viewers can't
// even load an unpublished profile — the RPC returns NOT_FOUND for them).
// The page also hosts the "Edit profile" button which opens `ProfileEditor`
// in a sheet, both for self-edit and for mod-edit-other.

import { useCallback, useEffect, useInsertionEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  Heading,
  PageLayout,
  Spinner,
  Stack,
  Text,
} from "../design-system";
import { api, errorCode } from "../api";
import { useRoute } from "../router";
import { ProfileEditor } from "./ProfileEditor";
import { CopyButton } from "./ui/CopyButton";
import { submitterLabel } from "./helpers";
import type { ProfileOut, ProfileEntryOut } from "../../shared/contract";

interface ProfilePageProps {
  slug: string;
  identityId: number;
}

function avatarUrl(slug: string, identityId: number, hash: string | null): string {
  if (hash) return `/api/avatars/${encodeURIComponent(slug)}/${identityId}/${hash}`;
  return `/api/avatars/${encodeURIComponent(slug)}/${identityId}`;
}

// Layout CSS for the profile page. Two responsive concerns are expressed
// here that pure inline styles can't handle:
//   1. The header card switches from "avatar left, text right" on wide
//      screens to "small avatar + text in a row, both compact" on narrow
//      screens. The avatar shrinks from 160 → 88 so it doesn't dominate
//      the mobile viewport (it used to be a fixed 256px square).
//   2. Each entry row (link or contact) stacks label-above-value on narrow
//      screens, where the 120px label column was wasteful or cramped.
const PROFILE_STYLE_ID = "uncon-profile-page";
const profileCss = `
.uncon-profile-avatar {
  width: 160px;
  height: 160px;
  border-radius: 16px;
  object-fit: cover;
  background: var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)));
  border: 1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb));
  flex-shrink: 0;
  cursor: zoom-in;
  display: block;
}
.uncon-profile-entry {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb));
  background: var(--bgColor-default, var(--uncon-bg, transparent));
}
.uncon-profile-entry__kind {
  color: var(--fgColor-muted, var(--uncon-fg-muted, #6e7781));
  font-size: 13px;
  font-weight: 500;
}
.uncon-profile-entry__value {
  font-size: 14px;
  min-width: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .uncon-profile-avatar {
    width: 88px;
    height: 88px;
    border-radius: 12px;
  }
  .uncon-profile-entry {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "kind copy" "value value";
    row-gap: 4px;
    column-gap: 8px;
  }
  .uncon-profile-entry__kind { grid-area: kind; }
  .uncon-profile-entry__value { grid-area: value; }
  .uncon-profile-entry__copy { grid-area: copy; }
}
.uncon-lightbox-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.82);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  cursor: zoom-out;
  animation: uncon-lightbox-fade-in 140ms ease-out;
}
.uncon-lightbox-img {
  max-width: 100%;
  max-height: 100%;
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0,0,0,0.5);
  object-fit: contain;
  cursor: zoom-out;
}
@keyframes uncon-lightbox-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

function useProfileStyles() {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(PROFILE_STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = PROFILE_STYLE_ID;
    el.textContent = profileCss;
    document.head.appendChild(el);
  }, []);
}

export function ProfilePage({ slug, identityId }: ProfilePageProps) {
  useProfileStyles();
  const { navigate } = useRoute();
  const [profile, setProfile] = useState<ProfileOut | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await api.profiles.get({ slug, identity_id: identityId });
      setProfile(p);
      setError(null);
    } catch (e) {
      const code = errorCode(e);
      setError(code === "NOT_FOUND" ? "not_found" : code);
      setProfile(null);
    }
  }, [slug, identityId]);

  useEffect(() => {
    let cancelled = false;
    api.profiles
      .get({ slug, identity_id: identityId })
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const code = errorCode(e);
        setError(code === "NOT_FOUND" ? "not_found" : code);
        setProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, identityId]);

  if (profile === undefined) {
    return (
      <PageLayout>
        <Spinner label="Loading…" />
      </PageLayout>
    );
  }

  if (profile === null) {
    return (
      <PageLayout>
        <Stack gap="spacious">
          <Banner variant="critical">
            {error === "not_found"
              ? "Profile not found or not published."
              : `Could not load profile: ${error ?? "error"}`}
          </Banner>
          <Stack direction="row" gap="condensed">
            <Button onClick={() => navigate(`/conferences/${slug}`)}>
              Back to conference
            </Button>
          </Stack>
        </Stack>
      </PageLayout>
    );
  }

  const label =
    submitterLabel({
      submitter_name: profile.name,
      submitter_email: profile.email,
    }) ?? "Unnamed";

  const linkEntries = profile.entries.filter((e) => e.category === "link");
  const contactEntries = profile.entries.filter((e) => e.category === "contact");

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const avatarSrc = avatarUrl(slug, profile.identity_id, profile.avatar_hash);

  function openExperts(): void {
    // Phase 4 v1: just navigate to the experts tab. Cross-tab focus into a
    // specific expert row is future work (no scroll-into-view yet).
    navigate(`/conferences/${slug}`);
    // Hash-only navigation doesn't pass query state through our matchRoute —
    // ConferencePage owns the active tab in local state. A small URL hint
    // exists for completeness but we don't read it yet.
    window.location.hash = `/conferences/${encodeURIComponent(slug)}?tab=experts`;
  }

  return (
    <PageLayout>
      <Stack gap="spacious">
        <Stack direction="row" gap="condensed" align="center" justify="between" wrap>
          <Button onClick={() => navigate(`/conferences/${slug}`)}>
            ← Back to conference
          </Button>
          {profile.can_edit && (
            <Button variant="primary" onClick={() => setEditorOpen(true)}>
              Edit profile
            </Button>
          )}
        </Stack>

        {!profile.profile_published && (
          <Banner variant="warning">
            This profile is not published.{" "}
            {profile.is_me
              ? "Only you and moderators can see it. Publish it from the editor."
              : "You're seeing this because you're a moderator."}
          </Banner>
        )}

        <Card>
          <Stack direction="row" gap="spacious" align="start" wrap>
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              aria-label={`Open ${label}'s avatar in full size`}
              style={{
                padding: 0,
                background: "none",
                border: "none",
                cursor: "zoom-in",
                lineHeight: 0,
                borderRadius: 16,
              }}
            >
              <img
                src={avatarSrc}
                alt=""
                className="uncon-profile-avatar"
                draggable={false}
              />
            </button>
            <Stack gap="condensed">
              <Stack direction="row" gap="condensed" align="center" wrap>
                <Heading level={2}>{label}</Heading>
                {profile.pronouns && (
                  <span style={{ color: muted, fontSize: 14 }}>
                    ({profile.pronouns})
                  </span>
                )}
              </Stack>
              {(profile.title || profile.company) && (
                <Text muted>
                  {profile.title}
                  {profile.title && profile.company ? " @ " : ""}
                  {profile.company}
                </Text>
              )}
              <Stack direction="row" gap="condensed" wrap>
                <Badge variant={roleVariant(profile.role)}>{profile.role}</Badge>
                {profile.is_expert && <Badge variant="primary">Expert</Badge>}
              </Stack>
              {profile.bio && (
                <div
                  style={{
                    whiteSpace: "pre-wrap",
                    fontSize: 14,
                    lineHeight: "20px",
                    color: "var(--fgColor-default, var(--uncon-fg, inherit))",
                  }}
                >
                  {profile.bio}
                </div>
              )}
              {profile.is_expert && (
                <div>
                  <Button onClick={openExperts}>Book this expert</Button>
                </div>
              )}
            </Stack>
          </Stack>
        </Card>

        {profile.tags.length > 0 && (
          <Card>
            <Stack gap="condensed">
              <Heading level={3}>Tags</Heading>
              <Stack direction="row" gap="condensed" wrap>
                {profile.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </Stack>
            </Stack>
          </Card>
        )}

        {linkEntries.length > 0 && (
          <Card>
            <Stack gap="condensed">
              <Heading level={3}>Web & socials</Heading>
              <Stack gap="condensed">
                {linkEntries.map((e) => (
                  <EntryRow key={e.id} entry={e} />
                ))}
              </Stack>
            </Stack>
          </Card>
        )}

        {contactEntries.length > 0 && (
          <Card>
            <Stack gap="condensed">
              <Heading level={3}>Contact</Heading>
              <Stack gap="condensed">
                {contactEntries.map((e) => (
                  <EntryRow key={e.id} entry={e} showCopy />
                ))}
              </Stack>
            </Stack>
          </Card>
        )}
      </Stack>

      {lightboxOpen && (
        <AvatarLightbox
          src={avatarSrc}
          alt={`${label}'s avatar`}
          onClose={() => setLightboxOpen(false)}
        />
      )}

      {editorOpen && (
        <ProfileEditor
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          slug={slug}
          profile={profile}
          onSaved={() => {
            load().catch(() => {
              /* keep current view */
            });
          }}
        />
      )}
    </PageLayout>
  );
}

// Full-viewport image viewer for the avatar. Click anywhere (or press Esc)
// to dismiss. We don't reuse the design-system Sheet here because the
// chrome (title bar, padding, max-width) would fight the goal — this is a
// purpose-built lightbox: black backdrop, image centered, no decoration.
function AvatarLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="uncon-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="uncon-lightbox-img"
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />
    </div>
  );
}

function EntryRow({
  entry,
  showCopy,
}: {
  entry: ProfileEntryOut;
  showCopy?: boolean;
}) {
  const valueNode = entry.href ? (
    <a
      href={entry.href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: "var(--fgColor-accent, var(--uncon-primary, #2563eb))",
        textDecoration: "none",
      }}
    >
      {entry.value}
    </a>
  ) : (
    <span>{entry.value}</span>
  );
  return (
    <div className="uncon-profile-entry">
      <div className="uncon-profile-entry__kind">{entry.kind}</div>
      <div className="uncon-profile-entry__value">{valueNode}</div>
      <div className="uncon-profile-entry__copy">
        {showCopy && (
          <CopyButton
            label="Copy"
            value={entry.value}
            successMessage={`${entry.kind} copied.`}
            fallbackPromptLabel={`Copy this ${entry.kind.toLowerCase()}:`}
          />
        )}
      </div>
    </div>
  );
}

function roleVariant(role: "owner" | "moderator" | "participant") {
  if (role === "owner") return "primary";
  if (role === "moderator") return "attention";
  return "default";
}
