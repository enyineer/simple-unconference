// Members-visible profile directory. Mirrors the structure of PeopleTab,
// but never surfaces emails or admin actions and only lists profiles the
// server returns (published profiles for non-mods; everyone for mods).
//
// Search input debounced 200ms. Below the input, a horizontally-scrollable
// list of tags drawn from the currently-loaded result set lets the user
// narrow further; clicking the active tag clears the filter.

import { useEffect, useState } from "react";
import { Badge, Button, Heading, Spinner, Stack } from "../../design-system";
import { useToast } from "../../design-system/hooks";
import { api, errorCode } from "../../api";
import { useRoute } from "../../router";
import { EmptyState } from "../ui/EmptyState";
import { ProfileLink } from "../ProfileLink";
import { ProfileEditor } from "../ProfileEditor";
import type { ProfileOut, ProfileSummaryOut } from "../../../shared/contract";
import type { ConfMe } from "../../App";

function avatarUrl(slug: string, identityId: number, hash: string | null): string {
  if (hash) return `/api/avatars/${encodeURIComponent(slug)}/${identityId}/${hash}`;
  return `/api/avatars/${encodeURIComponent(slug)}/${identityId}`;
}

export function DirectoryTab({
  slug,
  confMe,
  onConfMeRefresh,
}: {
  slug: string;
  /** Per-conference identity for the viewer; drives the "Your profile" card
   *  at the top of the directory (the main entry point for editing one's
   *  own profile). */
  confMe: ConfMe;
  /** Ask the App to refetch `conferences.me` after the user publishes or
   *  dismisses, so the nudge state stays accurate. */
  onConfMeRefresh: () => void;
}) {
  const [items, setItems] = useState<ProfileSummaryOut[] | null>(null);
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const toast = useToast();

  // Debounce the search input 200ms so we don't hit profiles.list on every
  // keystroke. The local input value updates immediately; the network query
  // catches up shortly after the user stops typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(rawQuery.trim()), 200);
    return () => clearTimeout(t);
  }, [rawQuery]);

  // Fetch when the debounced query or active tag changes. The server already
  // strips unpublished profiles for non-mod viewers; nothing to do client-side.
  useEffect(() => {
    let cancelled = false;
    api.profiles
      .list({
        slug,
        query: debouncedQuery || undefined,
        tag: activeTag ?? undefined,
      })
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
      })
      .catch((e) => {
        if (cancelled) return;
        setItems([]);
        toast.error(errorCode(e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, debouncedQuery, activeTag, toast]);

  // Tag chip list comes from the loaded result set. When the user is already
  // filtering by a tag, the loaded set only contains rows with that tag,
  // so we always include the active tag itself in the chip list (otherwise
  // the chip would vanish the moment it's selected, hiding the "clear" affordance).
  const tagSet = new Set<string>(activeTag ? [activeTag] : []);
  for (const r of items ?? []) for (const t of r.tags) tagSet.add(t);
  const tags = Array.from(tagSet).sort();

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  return (
    <Stack gap="spacious">
      <Heading level={2}>Directory</Heading>

      <YourProfileCard
        slug={slug}
        confMe={confMe}
        onConfMeRefresh={onConfMeRefresh}
      />

      <DirectorySearch value={rawQuery} onChange={setRawQuery} />

      {tags.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            overflowX: "auto",
            paddingBottom: 4,
            WebkitOverflowScrolling: "touch",
          }}
        >
          {tags.map((t) => {
            const on = activeTag === t;
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => setActiveTag(on ? null : t)}
                style={{
                  flex: "0 0 auto",
                  padding: "4px 10px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  border: `1px solid ${on
                    ? "var(--borderColor-accent-emphasis, var(--uncon-accent, #0969da))"
                    : "var(--borderColor-default, var(--uncon-border, #d0d7de))"}`,
                  background: on
                    ? "var(--bgColor-accent-muted, rgba(9,105,218,0.14))"
                    : "var(--bgColor-default, var(--uncon-bg, transparent))",
                  color: on
                    ? "var(--fgColor-accent, var(--uncon-accent, #0969da))"
                    : "var(--fgColor-default, var(--uncon-fg, inherit))",
                  whiteSpace: "nowrap",
                  fontFamily: "inherit",
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
      )}

      {!items ? (
        <Spinner label="Loading…" />
      ) : items.length === 0 ? (
        <EmptyState
          message={
            debouncedQuery || activeTag
              ? "No profiles match your filters."
              : "No published profiles yet. Open the Me tab to publish yours."
          }
        />
      ) : (
        <Stack gap="condensed">
          {items.map((p) => (
            <DirectoryRow key={p.identity_id} slug={slug} profile={p} muted={muted} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function DirectorySearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const fg = "var(--fgColor-default, var(--uncon-fg, inherit))";
  const bg = "var(--bgColor-default, var(--uncon-bg, transparent))";
  return (
    <div style={{ position: "relative" }}>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 10,
          top: "50%",
          transform: "translateY(-50%)",
          color: muted,
          pointerEvents: "none",
          display: "inline-flex",
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="7" cy="7" r="5" />
          <line x1="11" y1="11" x2="14" y2="14" />
        </svg>
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search profiles by name, title, company, tag…"
        aria-label="Search directory"
        style={{
          width: "100%",
          padding: "8px 32px 8px 32px",
          borderRadius: 8,
          border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
          background: bg,
          color: fg,
          fontSize: 14,
          outline: "none",
          WebkitAppearance: "none",
          appearance: "none",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}

function DirectoryRow({
  slug,
  profile,
  muted,
}: {
  slug: string;
  profile: ProfileSummaryOut;
  muted: string;
}) {
  const label = profile.name && profile.name.trim() ? profile.name : "Unnamed";
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  return (
    <ProfileLink slug={slug} identityId={profile.identity_id} linkable={true}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          gap: 12,
          alignItems: "center",
          padding: 12,
          borderRadius: 8,
          border:
            "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
          background: "var(--bgColor-default, var(--uncon-bg, transparent))",
        }}
      >
        <img
          src={avatarUrl(slug, profile.identity_id, profile.avatar_hash)}
          alt=""
          width={48}
          height={48}
          style={{
            width: 48,
            height: 48,
            borderRadius: "50%",
            objectFit: "cover",
            background:
              "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
            color: muted,
            display: "block",
            flexShrink: 0,
          }}
          aria-hidden={initial ? undefined : true}
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                lineHeight: "20px",
                color: "var(--fgColor-default, var(--uncon-fg, inherit))",
              }}
            >
              {label}
            </span>
            {profile.pronouns && (
              <span style={{ color: muted, fontSize: 12 }}>
                ({profile.pronouns})
              </span>
            )}
          </div>
          {(profile.title || profile.company) && (
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
              {profile.title}
              {profile.title && profile.company ? " @ " : ""}
              {profile.company}
            </div>
          )}
          {(profile.tags.length > 0 || profile.is_expert) && (
            <div
              style={{
                marginTop: 6,
                display: "flex",
                gap: 4,
                flexWrap: "wrap",
              }}
            >
              {profile.is_expert && <Badge variant="primary">Expert</Badge>}
              {profile.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </ProfileLink>
  );
}

// Permanent "Your profile" entry point pinned at the top of the Directory.
// Replaces the first-login banner that used to live in MyAssignmentsTab —
// putting the profile affordance next to everyone else's profile is more
// discoverable, and it stays useful even after the initial setup (the user
// can come back here any time to edit). Renders a compact card with the
// viewer's avatar, a status badge (published / not published), and two
// actions: open own profile page, or open the editor sheet.
function YourProfileCard({
  slug,
  confMe,
  onConfMeRefresh,
}: {
  slug: string;
  confMe: ConfMe;
  onConfMeRefresh: () => void;
}) {
  const { navigate } = useRoute();
  const [editorProfile, setEditorProfile] = useState<ProfileOut | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  async function openEditor() {
    if (loading) return;
    setLoading(true);
    try {
      const p = await api.profiles.get({ slug, identity_id: confMe.id });
      setEditorProfile(p);
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setLoading(false);
    }
  }

  const label = confMe.name && confMe.name.trim() ? confMe.name : "Unnamed";
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const accent = "var(--borderColor-accent-emphasis, #0969da)";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 12,
        alignItems: "center",
        padding: 12,
        borderRadius: 8,
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        borderLeft: `4px solid ${accent}`,
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      <img
        src={`/api/avatars/${encodeURIComponent(slug)}/${confMe.id}`}
        alt=""
        width={48}
        height={48}
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          objectFit: "cover",
          background:
            "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
          display: "block",
          flexShrink: 0,
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
          Your profile
        </div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--fgColor-default, var(--uncon-fg, inherit))",
            marginTop: 2,
          }}
        >
          {label}
        </div>
        <div style={{ marginTop: 6 }}>
          {confMe.profile_published ? (
            <Badge variant="success">Published</Badge>
          ) : (
            <Badge variant="attention">Not published</Badge>
          )}
          {!confMe.profile_published && (
            <span style={{ color: muted, fontSize: 12, marginLeft: 8 }}>
              Only you and moderators can see it.
            </span>
          )}
        </div>
      </div>
      <Stack direction="row" gap="condensed">
        <Button
          size="small"
          onClick={() => navigate(`/conferences/${encodeURIComponent(slug)}/p/${confMe.id}`)}
        >
          View
        </Button>
        <Button
          size="small"
          variant="primary"
          onClick={openEditor}
          disabled={loading}
        >
          {loading ? "Loading…" : "Edit"}
        </Button>
      </Stack>

      {editorProfile && (
        <ProfileEditor
          open={true}
          onClose={() => setEditorProfile(null)}
          slug={slug}
          profile={editorProfile}
          onSaved={() => {
            // Refresh both the conferences.me payload (so the badge above
            // flips to "Published" right away) and the locally-held profile
            // (so the editor stays accurate if the user keeps editing).
            onConfMeRefresh();
            api.profiles
              .get({ slug, identity_id: confMe.id })
              .then(setEditorProfile)
              .catch(() => { /* keep current */ });
          }}
        />
      )}
    </div>
  );
}
