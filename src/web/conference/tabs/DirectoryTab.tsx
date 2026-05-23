// Members-visible profile directory. Mirrors the structure of PeopleTab,
// but never surfaces emails or admin actions and only lists profiles the
// server returns (published profiles for non-mods; everyone for mods).
//
// Search input debounced 200ms. Below the input, a horizontally-scrollable
// list of tags drawn from the currently-loaded result set lets the user
// narrow further; clicking the active tag clears the filter.

import { useEffect, useInsertionEffect, useState } from "react";
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

// Layout CSS for the directory. The two key responsive concerns:
//   1. Profile rows use a shared chrome (YourProfileCard and DirectoryRow
//      look identical now); on narrow widths the right-side actions/badges
//      drop below the text instead of getting squeezed against the avatar.
//   2. The search input gains a clear (×) button when populated.
const DIRECTORY_STYLE_ID = "uncon-directory-tab";
const directoryCss = `
.uncon-dir-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb));
  background: var(--bgColor-default, var(--uncon-bg, transparent));
}
.uncon-dir-row__avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)));
  display: block;
  flex-shrink: 0;
}
.uncon-dir-row__body { min-width: 0; }
.uncon-dir-row__actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
@media (max-width: 480px) {
  .uncon-dir-row {
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas: "avatar body" "actions actions";
    row-gap: 10px;
  }
  .uncon-dir-row__avatar { grid-area: avatar; }
  .uncon-dir-row__body { grid-area: body; }
  .uncon-dir-row__actions { grid-area: actions; justify-content: flex-end; }
}
.uncon-dir-row__name {
  font-size: 15px;
  font-weight: 600;
  line-height: 20px;
  color: var(--fgColor-default, var(--uncon-fg, inherit));
  overflow: hidden;
  text-overflow: ellipsis;
}
.uncon-dir-row__sub {
  font-size: 12px;
  color: var(--fgColor-muted, var(--uncon-fg-muted, #6e7781));
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.uncon-dir-search-wrap { position: relative; }
.uncon-dir-search-clear {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: none;
  background: var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.06)));
  color: var(--fgColor-muted, var(--uncon-fg-muted, #6e7781));
  cursor: pointer;
  padding: 0;
  font-family: inherit;
}
.uncon-dir-search-clear:hover {
  background: var(--bgColor-emphasis, rgba(0,0,0,0.12));
  color: var(--fgColor-default, var(--uncon-fg, inherit));
}
.uncon-dir-count {
  font-size: 12px;
  color: var(--fgColor-muted, var(--uncon-fg-muted, #6e7781));
}
`;

function useDirectoryStyles() {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(DIRECTORY_STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = DIRECTORY_STYLE_ID;
    el.textContent = directoryCss;
    document.head.appendChild(el);
  }, []);
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
  useDirectoryStyles();
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
  const hasFilter = Boolean(debouncedQuery || activeTag);
  const countLabel =
    items === null
      ? null
      : items.length === 1
        ? "1 profile"
        : `${items.length} profiles`;

  return (
    <Stack gap="spacious">
      <Heading level={2}>Directory</Heading>

      <YourProfileCard
        slug={slug}
        confMe={confMe}
        onConfMeRefresh={onConfMeRefresh}
      />

      <DirectorySearch
        value={rawQuery}
        onChange={setRawQuery}
        onClear={() => setRawQuery("")}
      />

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

      {countLabel && (
        <div className="uncon-dir-count">
          {countLabel}
          {hasFilter ? " match your filters" : ""}
        </div>
      )}

      {!items ? (
        <Spinner label="Loading…" />
      ) : items.length === 0 ? (
        <EmptyState
          message={
            hasFilter
              ? "No profiles match your filters."
              : "No published profiles yet. Publish yours from the card above."
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
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const fg = "var(--fgColor-default, var(--uncon-fg, inherit))";
  const bg = "var(--bgColor-default, var(--uncon-bg, transparent))";
  const hasValue = value.length > 0;
  return (
    <div className="uncon-dir-search-wrap">
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
          padding: hasValue ? "8px 38px 8px 32px" : "8px 32px 8px 32px",
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
      {hasValue && (
        <button
          type="button"
          className="uncon-dir-search-clear"
          aria-label="Clear search"
          onClick={onClear}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          >
            <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
            <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
          </svg>
        </button>
      )}
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
      <div className="uncon-dir-row">
        <img
          src={avatarUrl(slug, profile.identity_id, profile.avatar_hash)}
          alt=""
          width={48}
          height={48}
          className="uncon-dir-row__avatar"
          style={{ color: muted }}
          aria-hidden={initial ? undefined : true}
        />
        <div className="uncon-dir-row__body">
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <span className="uncon-dir-row__name">{label}</span>
            {profile.pronouns && (
              <span style={{ color: muted, fontSize: 12 }}>
                ({profile.pronouns})
              </span>
            )}
          </div>
          {(profile.title || profile.company) && (
            <div className="uncon-dir-row__sub">
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
        <div className="uncon-dir-row__actions" />
      </div>
    </ProfileLink>
  );
}

// Permanent "Your profile" entry point pinned at the top of the Directory.
// Replaces the first-login banner that used to live in MyAssignmentsTab —
// putting the profile affordance next to everyone else's profile is more
// discoverable, and it stays useful even after the initial setup (the user
// can come back here any time to edit). Uses the same row chrome as
// DirectoryRow so the directory feels like one consistent list; the "You"
// badge is what distinguishes it (previously it was an accent border-left
// stripe, which looked like a separate widget).
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

  return (
    <>
      <div className="uncon-dir-row">
        <img
          src={`/api/avatars/${encodeURIComponent(slug)}/${confMe.id}`}
          alt=""
          width={48}
          height={48}
          className="uncon-dir-row__avatar"
        />
        <div className="uncon-dir-row__body">
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <span className="uncon-dir-row__name">{label}</span>
            <Badge variant="primary">You</Badge>
            {confMe.profile_published ? (
              <Badge variant="success">Published</Badge>
            ) : (
              <Badge variant="attention">Not published</Badge>
            )}
          </div>
          {!confMe.profile_published && (
            <div className="uncon-dir-row__sub">
              Only you and moderators can see it. Publish it from the editor.
            </div>
          )}
        </div>
        <div className="uncon-dir-row__actions">
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
        </div>
      </div>

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
    </>
  );
}
