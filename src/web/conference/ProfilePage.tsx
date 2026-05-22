// Profile viewer. Loaded by the hash route `/conferences/:slug/p/:identityId`.
//
// Shows the published profile of an identity to anyone allowed to see it
// (the server enforces the visibility rules; non-mod, non-self viewers can't
// even load an unpublished profile — the RPC returns NOT_FOUND for them).
// The page also hosts the "Edit profile" button which opens `ProfileEditor`
// in a sheet, both for self-edit and for mod-edit-other.

import { useCallback, useEffect, useState } from "react";
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

export function ProfilePage({ slug, identityId }: ProfilePageProps) {
  const { navigate } = useRoute();
  const [profile, setProfile] = useState<ProfileOut | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

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
            <img
              src={avatarUrl(slug, profile.identity_id, profile.avatar_hash)}
              alt=""
              width={256}
              height={256}
              style={{
                width: 256,
                height: 256,
                maxWidth: "100%",
                borderRadius: 16,
                objectFit: "cover",
                background:
                  "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
                border:
                  "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
                flexShrink: 0,
              }}
            />
            <Stack gap="condensed">
              <Stack direction="row" gap="condensed" align="center" wrap>
                <Heading level={1}>{label}</Heading>
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
          <Stack gap="condensed">
            <Heading level={3}>Tags</Heading>
            <Stack direction="row" gap="condensed" wrap>
              {profile.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </Stack>
          </Stack>
        )}

        {linkEntries.length > 0 && (
          <Stack gap="condensed">
            <Heading level={3}>Web & socials</Heading>
            <Stack gap="condensed">
              {linkEntries.map((e) => (
                <EntryRow key={e.id} entry={e} />
              ))}
            </Stack>
          </Stack>
        )}

        {contactEntries.length > 0 && (
          <Stack gap="condensed">
            <Heading level={3}>Contact</Heading>
            <Stack gap="condensed">
              {contactEntries.map((e) => (
                <EntryRow key={e.id} entry={e} showCopy />
              ))}
            </Stack>
          </Stack>
        )}
      </Stack>

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

function EntryRow({
  entry,
  showCopy,
}: {
  entry: ProfileEntryOut;
  showCopy?: boolean;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const valueNode = entry.href ? (
    <a
      href={entry.href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: "var(--fgColor-accent, var(--uncon-primary, #2563eb))",
        textDecoration: "none",
        wordBreak: "break-all",
      }}
    >
      {entry.value}
    </a>
  ) : (
    <span style={{ wordBreak: "break-all" }}>{entry.value}</span>
  );
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr auto",
        gap: 12,
        alignItems: "center",
        padding: 10,
        borderRadius: 8,
        border:
          "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      <div style={{ color: muted, fontSize: 13, fontWeight: 500 }}>
        {entry.kind}
      </div>
      <div style={{ fontSize: 14, minWidth: 0 }}>{valueNode}</div>
      <div>
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
