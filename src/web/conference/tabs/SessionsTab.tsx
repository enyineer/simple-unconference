import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Form,
  Heading,
  Select,
  Sheet,
  Spinner,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "../../design-system";
import { api, errorCode } from "../../api";
import { quotaErrorMessage } from "../../quotaErrors";
import { useToast } from "../../design-system/hooks";
import type { Participant, Role, Room, Submission } from "../types";
import { fmtTimeShort, parseLabels, submitterLabel } from "../helpers";
import { EmptyState } from "../ui/EmptyState";
import { Pill } from "../ui/Pill";
import { Tip } from "../ui/Tip";
import { useRequirementsConfirm } from "../ui/RequirementsConfirm";
import { SearchableSelect, type SearchableSelectOption } from "../ui/SearchableSelect";

// Status filter values used by the Sessions tab. Participants only ever see
// `published`, so the filter chips are mod-only.
type SessionFilter = "all" | "submitted" | "published" | "rejected";

export function SessionsTab({
  slug,
  role,
  timeZone,
  submissionMaxPlacementsDefault,
  participantSubmissionsEnabled,
  mySessionCount,
  maxSessionsPerUser,
  onSessionMutated,
}: {
  slug: string;
  role: Role;
  /** Conference timezone — used to format the inline "Scheduled at..." hint
   *  surfaced on each card when the session is on the planned agenda. */
  timeZone: string;
  /** Conference-wide default cap. Used by the mod edit form to label the
   * "inherit" option (e.g. "Use conference default (once)"). */
  submissionMaxPlacementsDefault: number | null;
  /** When false, participants can't submit sessions: the "+ Submit a session"
   * button is hidden for them and a short notice explains why. Mods + owners
   * always see the button. */
  participantSubmissionsEnabled: boolean;
  /** Submissions in this conference owned by the calling identity (every
   *  status, not just visible ones). Drives the "X / N submitted" hint. */
  mySessionCount: number;
  /** Per-user-per-conference cap from the instance config. null = disabled. */
  maxSessionsPerUser: number | null;
  /** Tell the parent to refresh `conferences.get` after a create/delete so
   *  mySessionCount stays accurate without polling. */
  onSessionMutated: () => void;
}) {
  const isMod = role === "owner" || role === "moderator";
  const [subs, setSubs] = useState<Submission[] | null>(null);
  // Mods need rooms for the "pre-assign to room" dropdown; everyone (mods +
  // participants) needs them to derive the available room-feature tags
  // shown in the "Required room features" picker — so we fetch unconditionally.
  const [rooms, setRooms] = useState<Room[]>([]);
  useEffect(() => {
    api.rooms.list({ slug }).then(setRooms).catch(() => setRooms([]));
  }, [slug]);
  // Mod-only roster used to populate the submitter-reassignment dropdown
  // in the edit form. Participants don't see (or need) this list — we leave
  // `fetchedParticipants` untouched and derive `participants` below so a
  // role flip from mod to participant just hides the data without a
  // synchronous reset-in-effect.
  const [fetchedParticipants, setFetchedParticipants] = useState<Participant[]>([]);
  useEffect(() => {
    if (!isMod) return;
    let cancelled = false;
    api.conferences
      .listParticipants({ slug })
      .then((p) => { if (!cancelled) setFetchedParticipants(p); })
      .catch(() => { if (!cancelled) setFetchedParticipants([]); });
    return () => { cancelled = true; };
  }, [slug, isMod]);
  const participants = isMod ? fetchedParticipants : [];
  // Distinct tag values across all rooms in this conference. The picker
  // only offers these — selecting a tag no room has would just make the
  // session unplaceable.
  const availableRoomTags = Array.from(
    new Set(rooms.flatMap((r) => r.tags)),
  ).sort();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<SessionFilter>(
    isMod ? "all" : "published",
  );
  // Free-text query matched against title, description, submitter name,
  // session tags, and requirements. Client-side only — the list is already
  // in memory and small enough that filtering on every keystroke is cheap.
  const [query, setQuery] = useState("");
  // Selected session tag chips. Multi-select with AND semantics — a session
  // must carry every selected tag to remain visible.
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  // Toggles down to sessions the viewer has personally starred. Only meaningful
  // once the viewer is logged in and has interacted with at least one session,
  // but the toggle is always available — empty result is its own teaching moment.
  const [starredOnly, setStarredOnly] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const toast = useToast();

  // `submitter_id` on a Submission is a ConferenceIdentity.id, not a global
  // User.id, so we must read the per-conference "me" — `auth.me()` would
  // return the wrong id (or 401 for a participant who only has a conference
  // session). Without this, non-mods never see their own edit/delete buttons.
  const [myUserId, setMyUserId] = useState<number | null>(null);
  useEffect(() => {
    api.conferences
      .me({ slug })
      .then((u) => setMyUserId(u.id))
      .catch(() => {});
  }, [slug]);

  async function refresh() {
    // For participants the server already restricts to published, so we
    // don't need a status param; for mods we fetch everything and filter
    // client-side via the chips so toggling is instant.
    setSubs(await api.submissions.list({ slug }));
  }
  useEffect(() => {
    let cancelled = false;
    api.submissions.list({ slug })
      .then((ss) => { if (!cancelled) setSubs(ss); })
      .catch(() => { if (!cancelled) setSubs([]); });
    return () => { cancelled = true; };
  }, [slug]);

  async function deleteSubmission(s: Submission) {
    const msg = isMod
      ? `Delete "${s.title}"? This cannot be undone.`
      : `Withdraw "${s.title}"? It will be removed from the conference.`;
    if (!confirm(msg)) return;
    try {
      await api.submissions.delete({ slug, id: s.id });
      await refresh();
      onSessionMutated();
      toast.success(isMod ? `Deleted "${s.title}".` : `Withdrew "${s.title}".`);
    } catch (e) {
      toast.error(errorCode(e));
    }
  }
  const requirementsConfirm = useRequirementsConfirm();
  async function toggleStar(s: Submission) {
    if (s.starred_by_me) {
      try {
        await api.submissions.unstar({ slug, id: s.id });
        await refresh();
      } catch (e) {
        toast.error(errorCode(e));
      }
      return;
    }
    requirementsConfirm.request({
      title: s.title,
      requirements: s.requirements,
      onConfirm: async () => {
        try {
          await api.submissions.star({ slug, id: s.id });
          await refresh();
        } catch (e) {
          toast.error(errorCode(e));
        }
      },
    });
  }
  async function setStatus(
    s: Submission,
    action: "publish" | "unpublish" | "reject",
  ) {
    try {
      if (action === "publish") await api.submissions.publish({ slug, id: s.id });
      else if (action === "unpublish")
        await api.submissions.unpublish({ slug, id: s.id });
      else await api.submissions.reject({ slug, id: s.id });
      await refresh();
      toast.success(
        action === "publish" ? `Published "${s.title}".` :
        action === "unpublish" ? `Unpublished "${s.title}".` :
        `Rejected "${s.title}".`,
      );
    } catch (e) {
      toast.error(errorCode(e));
    }
  }

  function canEdit(s: Submission): boolean {
    if (isMod) return true;
    return s.submitter_id === myUserId && s.status === "submitted";
  }

  // Apply the mod-only status chip first so the search/tag/star filters
  // operate on the user-visible set. For non-mods the server already
  // restricted to published + own; for mods "all" is a passthrough.
  const statusFiltered = useMemo(() => {
    if (!subs) return null;
    if (!isMod || filter === "all") return subs;
    return subs.filter((s) => s.status === filter);
  }, [subs, isMod, filter]);

  // Tag chip options come from the status-filtered set so we never offer
  // a tag that would produce zero results given the current status. Sorted
  // alphabetically so the chip order is stable as sessions come and go.
  const availableSessionTags = useMemo(() => {
    if (!statusFiltered) return [];
    return Array.from(
      new Set(statusFiltered.flatMap((s) => s.tags)),
    ).sort();
  }, [statusFiltered]);

  // Drop any selected tag that no longer exists in the offered set (e.g.
  // the user switched status from "all" to "rejected" and the tag they had
  // selected only existed on a published session). Avoids the "0 results
  // but I can't see why" footgun. Computed during render and adjusted via
  // setState — React reconciles before painting.
  if (selectedTags.length > 0) {
    const offered = new Set(availableSessionTags);
    const pruned = selectedTags.filter((t) => offered.has(t));
    if (pruned.length !== selectedTags.length) setSelectedTags(pruned);
  }

  const trimmedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!statusFiltered) return null;
    if (!trimmedQuery && selectedTags.length === 0 && !starredOnly)
      return statusFiltered;
    return statusFiltered.filter((s) => {
      if (starredOnly && !s.starred_by_me) return false;
      if (selectedTags.length > 0) {
        const tagSet = new Set(s.tags);
        for (const t of selectedTags) if (!tagSet.has(t)) return false;
      }
      if (trimmedQuery) {
        const haystack = [
          s.title,
          s.description,
          submitterLabel(s) ?? "",
          s.tags.join(" "),
          s.requirements.join(" "),
        ]
          .join("   ")
          .toLowerCase();
        if (!haystack.includes(trimmedQuery)) return false;
      }
      return true;
    });
  }, [statusFiltered, trimmedQuery, selectedTags, starredOnly]);

  const anyFilterActive =
    trimmedQuery.length > 0 || selectedTags.length > 0 || starredOnly;

  function clearFilters() {
    setQuery("");
    setSelectedTags([]);
    setStarredOnly(false);
  }
  function toggleTag(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  const editingSub = editingId
    ? (subs?.find((s) => s.id === editingId) ?? null)
    : null;

  const filterCounts = subs
    ? {
        all: subs.length,
        submitted: subs.filter((s) => s.status === "submitted").length,
        published: subs.filter((s) => s.status === "published").length,
        rejected: subs.filter((s) => s.status === "rejected").length,
      }
    : null;

  return (
    <Stack gap="spacious">
      {requirementsConfirm.modal}

      <Stack direction="row" justify="between" align="center" wrap>
        <Heading level={2}>Sessions</Heading>
        {(isMod || participantSubmissionsEnabled) && (
          <Button
            variant="primary"
            onClick={() => {
              setAdding(true);
            }}
          >
            + Submit a session
          </Button>
        )}
      </Stack>

      {!isMod && !participantSubmissionsEnabled && (
        <Banner variant="info">
          Session submissions are currently closed. Only moderators can add new
          sessions to this conference.
        </Banner>
      )}

      {/* Per-user quota hint. Hidden for mods/owners (the cap doesn't
          apply to them server-side, so showing a count would be
          misleading), when the cap is disabled (limit=null), or when the
          viewer can't submit anyway (participant + submissions closed).
          Counts ALL the viewer's submissions, including rejected /
          finished, since those consume cap slots. */}
      {!isMod && maxSessionsPerUser !== null && participantSubmissionsEnabled && (
        <MySessionQuotaHint current={mySessionCount} limit={maxSessionsPerUser} />
      )}

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title="Submit a session"
      >
        {adding && (
          <SessionForm
            mode="create"
            slug={slug}
            isMod={isMod}
            conferenceDefaultMaxPlacements={submissionMaxPlacementsDefault}
            rooms={rooms}
            participants={participants}
            availableRoomTags={availableRoomTags}
            onCancel={() => setAdding(false)}
            onSaved={async () => {
              setAdding(false);
              toast.success(
                isMod
                  ? "Session created."
                  : "Submitted. A moderator will review it before others can see it.",
              );
              await refresh();
              onSessionMutated();
            }}
          />
        )}
      </Sheet>

      {/* Mod-only status filter as chips with counts — easier to scan than
          a single toggle button. Participants always see published. */}
      {isMod && filterCounts && (
        <Stack direction="row" gap="condensed" wrap>
          {(
            ["all", "submitted", "published", "rejected"] as SessionFilter[]
          ).map((k) => (
            <Button
              key={k}
              size="small"
              variant={filter === k ? "primary" : "default"}
              onClick={() => setFilter(k)}
            >
              {filterLabel(k)}{" "}
              <span style={{ opacity: 0.7, marginLeft: 4 }}>
                {filterCounts[k]}
              </span>
            </Button>
          ))}
        </Stack>
      )}

      {subs && subs.length > 0 && (
        <SessionFilterBar
          query={query}
          onQueryChange={setQuery}
          availableTags={availableSessionTags}
          selectedTags={selectedTags}
          onToggleTag={toggleTag}
          starredOnly={starredOnly}
          onStarredOnlyChange={setStarredOnly}
          totalCount={statusFiltered?.length ?? 0}
          visibleCount={filtered?.length ?? 0}
          anyFilterActive={anyFilterActive}
          onClear={clearFilters}
        />
      )}

      {!filtered ? (
        <Spinner label="Loading…" />
      ) : filtered.length === 0 ? (
        <EmptyState
          message={
            anyFilterActive
              ? "No sessions match your filters."
              : isMod && filter !== "all" && subs && subs.length > 0
                ? `No sessions with status "${filter}".`
                : "No sessions yet. Be the first to submit one."
          }
          action={
            anyFilterActive ? (
              <Button size="small" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Stack gap="condensed">
          {filtered.map((s) => (
            <SessionCard
              key={s.id}
              s={s}
              canEdit={canEdit(s)}
              canDelete={canEdit(s)}
              isMod={isMod}
              timeZone={timeZone}
              roomName={
                s.pre_assigned_room_id === null
                  ? null
                  : rooms.find((r) => r.id === s.pre_assigned_room_id)?.name ?? null
              }
              onStar={() => toggleStar(s)}
              onEdit={() => setEditingId(s.id)}
              onDelete={() => deleteSubmission(s)}
              onStatus={(action) => setStatus(s, action)}
            />
          ))}
        </Stack>
      )}

      {/* Edit form opens in a Sheet — keeps the list still while you edit. */}
      <Sheet
        open={!!editingSub}
        onClose={() => setEditingId(null)}
        title={editingSub ? `Edit: ${editingSub.title}` : ""}
      >
        {editingSub && (
          <SessionForm
            mode="edit"
            slug={slug}
            submission={editingSub}
            isMod={isMod}
            conferenceDefaultMaxPlacements={submissionMaxPlacementsDefault}
            rooms={rooms}
            participants={participants}
            availableRoomTags={availableRoomTags}
            onCancel={() => setEditingId(null)}
            onSaved={async () => {
              setEditingId(null);
              await refresh();
              onSessionMutated();
            }}
          />
        )}
      </Sheet>
    </Stack>
  );
}

function filterLabel(k: SessionFilter): string {
  return (
    {
      all: "All",
      submitted: "Submitted",
      published: "Published",
      rejected: "Rejected",
    } as const
  )[k];
}

// Search + tag + starred filter bar. Single rounded container that adapts
// from a horizontal row on desktop to a stacked layout on mobile via the
// `--uncon-filter-stack` media query rule below. All controls operate on
// client-side state in SessionsTab; nothing here hits the network.
function SessionFilterBar({
  query,
  onQueryChange,
  availableTags,
  selectedTags,
  onToggleTag,
  starredOnly,
  onStarredOnlyChange,
  totalCount,
  visibleCount,
  anyFilterActive,
  onClear,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  availableTags: string[];
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  starredOnly: boolean;
  onStarredOnlyChange: (v: boolean) => void;
  totalCount: number;
  visibleCount: number;
  anyFilterActive: boolean;
  onClear: () => void;
}) {
  const border =
    "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";
  const borderFocus =
    "var(--borderColor-accent-emphasis, var(--uncon-accent, #0969da))";
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const fg = "var(--fgColor-default, var(--uncon-fg, inherit))";
  const bg = "var(--bgColor-default, var(--uncon-bg, transparent))";
  const bgSubtle =
    "var(--bgColor-subtle, var(--uncon-bg-subtle, rgba(0,0,0,0.025)))";

  const selectedSet = new Set(selectedTags);
  const [focused, setFocused] = useState(false);
  const showTagBlock = availableTags.length > 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 12,
        borderRadius: 10,
        border,
        background: bgSubtle,
      }}
    >
      {/* Row 1: search input + starred toggle.
            On mobile (`flexWrap`), the toggle drops to its own line. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            position: "relative",
            flex: "1 1 220px",
            minWidth: 0,
          }}
        >
          {/* Inline search glyph, left-aligned inside the input padding. */}
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
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search by title, speaker, tag…"
            aria-label="Filter sessions"
            style={{
              width: "100%",
              padding: "8px 32px 8px 32px",
              borderRadius: 8,
              border: `1px solid ${focused ? borderFocus : "var(--borderColor-default, var(--uncon-border, #d0d7de))"}`,
              boxShadow: focused
                ? `0 0 0 3px var(--bgColor-accent-muted, rgba(9,105,218,0.18))`
                : "none",
              background: bg,
              color: fg,
              fontSize: 14,
              outline: "none",
              transition: "border-color 120ms, box-shadow 120ms",
              WebkitAppearance: "none",
              appearance: "none",
            }}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onQueryChange("")}
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                width: 22,
                height: 22,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                color: muted,
                cursor: "pointer",
                borderRadius: 999,
                padding: 0,
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="3" y1="3" x2="13" y2="13" />
                <line x1="13" y1="3" x2="3" y2="13" />
              </svg>
            </button>
          )}
        </div>
        <button
          type="button"
          aria-pressed={starredOnly}
          onClick={() => onStarredOnlyChange(!starredOnly)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            border: `1px solid ${starredOnly ? borderFocus : "var(--borderColor-default, var(--uncon-border, #d0d7de))"}`,
            background: starredOnly
              ? "var(--bgColor-accent-muted, rgba(9,105,218,0.14))"
              : bg,
            color: starredOnly
              ? "var(--fgColor-accent, var(--uncon-accent, #0969da))"
              : fg,
            whiteSpace: "nowrap",
            transition: "background 120ms, border-color 120ms, color 120ms",
          }}
        >
          <span aria-hidden="true">{starredOnly ? "★" : "☆"}</span>
          Starred
        </button>
      </div>

      {/* Row 2: tag chips. Hidden when no session in the visible set has
          any tag — keeps the bar compact for brand-new conferences. */}
      {showTagBlock && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: muted,
              marginRight: 2,
            }}
          >
            Tags
          </span>
          {availableTags.map((tag) => {
            const on = selectedSet.has(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={on}
                onClick={() => onToggleTag(tag)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "4px 10px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  border: `1px solid ${on ? borderFocus : "var(--borderColor-default, var(--uncon-border, #d0d7de))"}`,
                  background: on
                    ? "var(--bgColor-accent-muted, rgba(9,105,218,0.14))"
                    : bg,
                  color: on
                    ? "var(--fgColor-accent, var(--uncon-accent, #0969da))"
                    : fg,
                  transition: "background 120ms, border-color 120ms, color 120ms",
                }}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {/* Row 3: result count + clear. Only renders when a filter is active so
          the bar is visually quiet at rest. */}
      {anyFilterActive && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            fontSize: 12,
            color: muted,
            borderTop: border,
            paddingTop: 10,
          }}
        >
          <span>
            Showing <span style={{ fontWeight: 600, color: fg }}>{visibleCount}</span>{" "}
            of {totalCount} {totalCount === 1 ? "session" : "sessions"}
          </span>
          <button
            type="button"
            onClick={onClear}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fgColor-accent, var(--uncon-accent, #0969da))",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 500,
              padding: 0,
            }}
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}

function SessionCard({
  s,
  canEdit,
  canDelete,
  isMod,
  timeZone,
  roomName,
  onStar,
  onEdit,
  onDelete,
  onStatus,
}: {
  s: Submission;
  canEdit: boolean;
  canDelete: boolean;
  isMod: boolean;
  timeZone: string;
  /** Pre-assigned room name when set, used to render the pinned badge.
   * Null when the submission isn't pinned or the room isn't loaded. */
  roomName: string | null;
  onStar: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatus: (action: "publish" | "unpublish" | "reject") => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const statusVariant =
    s.status === "published"
      ? "success"
      : s.status === "rejected"
        ? "danger"
        : "default";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "8px 12px",
        padding: 16,
        borderRadius: 8,
        border:
          "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      <div
        style={{
          gridColumn: 1,
          gridRow: 1,
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Badge variant={statusVariant}>{s.status}</Badge>
        {s.is_finished && (
          // Informational only under Path C: the badge tells everyone the
          // session is excluded from future unconference placement, but
          // doesn't gate stars or visibility.
          <Badge variant="default">
            {s.manually_finished ? "Marked complete" : "Fully scheduled"}
          </Badge>
        )}
        {roomName && (
          <Badge variant="attention">pinned: {roomName}</Badge>
        )}
        {s.room_requirements.length > 0 && (
          <Badge variant="default">
            needs: {s.room_requirements.join(", ")}
          </Badge>
        )}
        {s.allow_overlapping_placements && (
          <Badge variant="default">allows overlap</Badge>
        )}
        <Pill>★ {s.star_count}</Pill>
        {submitterLabel(s) && (
          <span style={{ color: muted, fontSize: 12 }}>
            by <span style={{ fontWeight: 500 }}>{submitterLabel(s)}</span>
          </span>
        )}
      </div>

      {s.scheduled_in.length > 0 && (
        // Path C cause-and-effect surface: "you star this session, it
        // shows up on your schedule at these times." Listing every linked
        // TrackAssignment with its time + room makes the connection
        // explicit at the moment the user is deciding whether to star.
        <div
          style={{
            gridColumn: "1 / -1",
            gridRow: 4,
            fontSize: 12,
            color: muted,
          }}
        >
          Scheduled at:{" "}
          {s.scheduled_in.map((sch, i) => (
            <span key={sch.slot_id}>
              {i > 0 ? " · " : ""}
              <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
                {fmtTimeShort(sch.starts_at, timeZone)}
              </span>{" "}
              <span>{sch.room_name}</span>
            </span>
          ))}
        </div>
      )}

      <div
        style={{
          gridColumn: "1 / -1",
          gridRow: 2,
          fontSize: 18,
          fontWeight: 600,
          lineHeight: "24px",
          wordBreak: "break-word",
        }}
      >
        {s.title}
      </div>

      {s.description && (
        <div
          style={{
            gridColumn: "1 / -1",
            gridRow: 3,
            fontSize: 14,
            lineHeight: "20px",
            color: "var(--fgColor-default, var(--uncon-fg, inherit))",
            whiteSpace: "pre-wrap",
          }}
        >
          {s.description}
        </div>
      )}

      {s.tags.length > 0 && (
        <div
          style={{
            gridColumn: "1 / -1",
            gridRow: 5,
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          {s.tags.map((t) => (
            <Pill key={t} variant="primary">
              {t}
            </Pill>
          ))}
        </div>
      )}

      {s.requirements.length > 0 && (
        <div
          style={{
            gridColumn: "1 / -1",
            gridRow: 6,
            fontSize: 12,
            color: muted,
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            Requires
          </span>
          {s.requirements.map((r) => (
            <Pill key={r}>{r}</Pill>
          ))}
        </div>
      )}

      {/* Action row. Two clusters separated by an auto-margin gap:
            • Left: engage / author / workflow (Star, Edit, Publish/Unpublish).
            • Right: destructive (Reject, then Delete — most-final last).
          Destructive cluster is visually offset so accidental taps land on a
          safer button, and when the row wraps on narrow screens the cluster
          stays together and right-aligns to its own line. */}
      <div
        style={{
          gridColumn: "1 / -1",
          gridRow: 7,
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
          marginTop: 4,
          paddingTop: 8,
          borderTop:
            "1px solid var(--borderColor-muted, var(--uncon-border-muted, #eef0f3))",
        }}
      >
        {s.status === "published" && (
          <Button
            size="small"
            onClick={onStar}
            variant={s.starred_by_me ? "primary" : "default"}
          >
            {s.starred_by_me ? "★ Starred" : "☆ Star"}
          </Button>
        )}
        {canEdit && (
          <Button size="small" onClick={onEdit}>
            Edit
          </Button>
        )}
        {isMod && s.status !== "published" && (
          <Button
            size="small"
            variant="primary"
            onClick={() => onStatus("publish")}
          >
            Publish
          </Button>
        )}
        {isMod && s.status === "published" && (
          <Button size="small" onClick={() => onStatus("unpublish")}>
            Unpublish
          </Button>
        )}

        {(canDelete || (isMod && s.status !== "rejected")) && (
          <div
            role="group"
            aria-label="Destructive actions"
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              marginLeft: "auto",
            }}
          >
            {isMod && s.status !== "rejected" && (
              <Button
                size="small"
                variant="danger"
                onClick={() => onStatus("reject")}
              >
                Reject
              </Button>
            )}
            {canDelete && (
              <Button size="small" variant="danger" onClick={onDelete}>
                {isMod ? "Delete" : "Withdraw"}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Unified create/edit form for a submission. Same UI for both — at create
// time the mod-only fields default to "auto"/empty, at edit time they're
// hydrated from the existing submission. Rendered inside a Sheet, so we
// drop the outer Card chrome the previous inline version used.
type SessionFormProps =
  | (SessionFormCommonProps & { mode: "create"; submission?: undefined })
  | (SessionFormCommonProps & { mode: "edit"; submission: Submission });

interface SessionFormCommonProps {
  slug: string;
  isMod: boolean;
  conferenceDefaultMaxPlacements: number | null;
  /** Conference rooms — used by the mod-only pre-assignment picker and the
   * "required room features" tag picker. Empty for participants. */
  rooms: Room[];
  /** Conference roster — feeds the mod-only "submitter" picker so a mod
   * who submits on someone else's behalf can attribute the session to the
   * actual speaker. Empty for participants. */
  participants: Participant[];
  /** Distinct tag values across all conference rooms. The "required room
   * features" picker offers exactly these — no free text. */
  availableRoomTags: string[];
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
}

function SessionForm(props: SessionFormProps) {
  const {
    mode, slug, isMod, conferenceDefaultMaxPlacements,
    rooms, participants, availableRoomTags, onCancel, onSaved,
  } = props;
  const existing = mode === "edit" ? props.submission : null;

  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [tags, setTags] = useState(existing?.tags.join(", ") ?? "");
  const [requirements, setRequirements] = useState(
    existing?.requirements.join(", ") ?? "",
  );
  // Editable for participants while the session is still "submitted", and
  // for mods regardless of status. The submission becoming "published"
  // effectively freezes this set for the submitter via the existing
  // already_decided gate; we mirror that here. New submissions are always
  // editable (no status yet).
  const [roomRequirements, setRoomRequirements] = useState<string[]>(
    existing?.room_requirements ?? [],
  );
  const requirementsLocked =
    !isMod && existing !== null && existing.status !== "submitted";
  // Mod-only state. `inherit` means "use the conference default" (stored as
  // null on the row); `once` and `limited` set an explicit per-submission cap.
  const [capMode, setCapMode] = useState<"inherit" | "once" | "limited">(() => {
    if (!existing || existing.max_placements === null) return "inherit";
    if (existing.max_placements === 1) return "once";
    return "limited";
  });
  const [capValue, setCapValue] = useState<string>(
    existing && existing.max_placements !== null && existing.max_placements > 1
      ? String(existing.max_placements)
      : "2",
  );
  const [manuallyFinished, setManuallyFinished] = useState(
    existing?.manually_finished ?? false,
  );
  const [allowOverlap, setAllowOverlap] = useState(
    existing?.allow_overlapping_placements ?? false,
  );
  // Pre-assigned room. "" means "auto" (no pin); otherwise the room id as a
  // string (matches SearchableSelect's value type).
  const [preAssignedRoomId, setPreAssignedRoomId] = useState<string>(
    existing?.pre_assigned_room_id == null
      ? ""
      : String(existing.pre_assigned_room_id),
  );
  // Mod-only submitter attribution. At create time defaults to "" (server
  // falls back to the actor); at edit time hydrates from the existing
  // submission so the picker shows the current author.
  const [submitterId, setSubmitterId] = useState<string>(
    existing ? String(existing.submitter_id) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Mod-only patch — same fields apply to both create and update.
      // Computed up front so we can early-return on validation errors
      // before touching the server.
      const modFields: {
        max_placements?: number | null;
        manually_finished?: boolean;
        pre_assigned_room_id?: number | null;
        allow_overlapping_placements?: boolean;
        submitter_id?: number;
      } = {};
      if (isMod) {
        let next: number | null;
        if (capMode === "inherit") next = null;
        else if (capMode === "once") next = 1;
        else {
          const parsed = Number.parseInt(capValue, 10);
          if (!Number.isFinite(parsed) || parsed < 1) {
            setError("Limit must be a positive whole number.");
            setBusy(false);
            return;
          }
          next = parsed;
        }
        modFields.max_placements = next;
        modFields.manually_finished = manuallyFinished;
        modFields.allow_overlapping_placements = allowOverlap;
        modFields.pre_assigned_room_id =
          preAssignedRoomId === ""
            ? null
            : Number.parseInt(preAssignedRoomId, 10);
        if (submitterId !== "") {
          const parsed = Number.parseInt(submitterId, 10);
          if (Number.isFinite(parsed)) {
            // Only send when it actually differs from the current author
            // on edit — there's nothing to do otherwise, and keeping the
            // payload tight avoids spurious "changed" signals.
            if (!existing || parsed !== existing.submitter_id) {
              modFields.submitter_id = parsed;
            }
          }
        }
      }

      if (mode === "create") {
        await api.submissions.create({
          slug,
          title,
          description,
          tags: parseLabels(tags),
          requirements: parseLabels(requirements),
          room_requirements: roomRequirements,
          ...modFields,
        });
      } else {
        await api.submissions.update({
          slug,
          id: existing!.id,
          title,
          description,
          tags: parseLabels(tags),
          requirements: parseLabels(requirements),
          // Only send room_requirements when the field is editable, so
          // the server never sees a stale value from a frozen edit screen.
          ...(requirementsLocked ? {} : { room_requirements: roomRequirements }),
          ...modFields,
        });
      }
      await onSaved();
    } catch (e) {
      setError(quotaErrorMessage(e) ?? errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  function inheritLabel(): string {
    if (conferenceDefaultMaxPlacements === null)
      return "Use conference default (unlimited)";
    if (conferenceDefaultMaxPlacements === 1)
      return "Use conference default (assign once)";
    return `Use conference default (${conferenceDefaultMaxPlacements} placements)`;
  }

  // Submitter options. Always include a "default" entry so create has a
  // sensible no-op state, and include the current author at edit time even
  // if they've since left the conference.
  const submitterOptions: SearchableSelectOption[] = [
    {
      value: "",
      label: mode === "create" ? "Me (default)" : "Keep current submitter",
    },
    ...participants.map((p) => ({
      value: String(p.user_id),
      label: p.name && p.name.trim() ? p.name : p.email,
      hint: p.name && p.name.trim() ? p.email : undefined,
    })),
  ];
  if (
    existing &&
    !participants.some((p) => p.user_id === existing.submitter_id)
  ) {
    submitterOptions.push({
      value: String(existing.submitter_id),
      label: submitterLabel(existing) ?? `User #${existing.submitter_id}`,
    });
  }

  const roomOptions: SearchableSelectOption[] = [
    { value: "", label: "Auto (assign to any room)" },
    ...rooms.map((r) => ({
      value: String(r.id),
      label: r.name,
      hint: `Capacity ${r.capacity}`,
    })),
  ];

  return (
    <Stack gap="condensed">
      {mode === "create" && !isMod && (
        <Tip>
          A moderator publishes your session before others can star it.
          Once published, a star means &ldquo;I want this on my schedule&rdquo; —
          it both signals interest to the unconference algorithm and adds
          any planned-slot offering of this session to the starring
          user&apos;s schedule automatically.
        </Tip>
      )}
      {error && <Banner variant="critical">{error}</Banner>}
      <Form onSubmit={save}>
        <TextInput
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Textarea
          label="Description"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TextInput
          label="Tags (comma-separated)"
          placeholder="e.g. workshop, discussion, lightning"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <TextInput
          label="Requirements (comma-separated)"
          placeholder="e.g. laptop, github account"
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
        />
        <RoomTagPicker
          availableTags={availableRoomTags}
          selected={roomRequirements}
          onChange={setRoomRequirements}
          disabled={requirementsLocked}
        />
        {requirementsLocked && (
          <Text muted>
            Required room features can&apos;t be changed after publishing.
          </Text>
        )}
        {isMod && (
          <>
            {participants.length > 0 && (
              <>
                <SearchableSelect
                  label="Submitter"
                  value={submitterId}
                  onChange={setSubmitterId}
                  options={submitterOptions}
                  placeholder="Search by name or email…"
                />
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                  }}
                >
                  {mode === "create"
                    ? "Attribute this session to the actual speaker if you're submitting on their behalf."
                    : "Reassign authorship to the actual speaker if you created this session on their behalf."}
                </div>
              </>
            )}
            <Select
              label="How many times can this session be assigned?"
              value={capMode}
              onChange={(e) =>
                setCapMode(e.target.value as "inherit" | "once" | "limited")
              }
              options={[
                { value: "inherit", label: inheritLabel() },
                { value: "once", label: "Assign once" },
                { value: "limited", label: "Limit to N placements" },
              ]}
            />
            {capMode === "limited" && (
              <TextInput
                label="Max placements"
                type="number"
                value={capValue}
                onChange={(e) => setCapValue(e.target.value)}
              />
            )}
            <CheckboxField
              checked={manuallyFinished}
              onChange={setManuallyFinished}
              label="Mark as finished"
              description="Hides from participants and excludes from assignment, regardless of count."
            />
            <CheckboxField
              checked={allowOverlap}
              onChange={setAllowOverlap}
              label="Allow placement in overlapping slots"
              description="Let this session run (or its submitter host) in slots whose times overlap. Use for recurring workshops."
            />
            {existing && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                }}
              >
                Currently placed {existing.placement_count}{" "}
                {existing.placement_count === 1 ? "time" : "times"}.
              </div>
            )}
            <SearchableSelect
              label="Pre-assign to room"
              value={preAssignedRoomId}
              onChange={setPreAssignedRoomId}
              options={roomOptions}
              placeholder="Search rooms…"
            />
            <div
              style={{
                fontSize: 12,
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              }}
            >
              Pre-assigned sessions always go to their pinned room in any
              unconference slot they land in. The slot&apos;s assignment will be
              blocked if two pre-assigned sessions compete for the same room.
            </div>
          </>
        )}
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary" disabled={busy}>
            {mode === "create" ? "Submit" : "Save"}
          </Button>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}

// Multi-tag picker for "required room features". Only renders tags that
// actually exist on at least one room in the conference; selecting a tag
// no room carries would make the session unplaceable, so we don't offer
// free-text input. Renders a notice when the conference has no room tags
// at all (the picker is a no-op until a mod tags some rooms).
function RoomTagPicker({
  availableTags, selected, onChange, disabled,
}: {
  availableTags: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  if (availableTags.length === 0) {
    return (
      <Stack gap="condensed">
        <div style={{ fontSize: 13, fontWeight: 500 }}>Required room features</div>
        <Text muted>
          No room has any feature tags yet. Ask a moderator to tag rooms
          (e.g. &quot;projector&quot;, &quot;whiteboard&quot;) in the Rooms tab to enable this.
        </Text>
      </Stack>
    );
  }
  const selectedSet = new Set(selected);
  function toggle(tag: string) {
    if (disabled) return;
    if (selectedSet.has(tag)) onChange(selected.filter((t) => t !== tag));
    else onChange([...selected, tag]);
  }
  return (
    <Stack gap="condensed">
      <div style={{ fontSize: 13, fontWeight: 500 }}>Required room features</div>
      <div style={{ fontSize: 12, color: muted }}>
        The assigned room must have all selected features. Leave empty if any
        room works.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {availableTags.map((tag) => {
          const on = selectedSet.has(tag);
          return (
            <label
              key={tag}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 8px",
                borderRadius: 999,
                fontSize: 12,
                border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
                background: on
                  ? "var(--bgColor-accent-muted, rgba(9,105,218,0.15))"
                  : "var(--bgColor-default, transparent)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.6 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={() => toggle(tag)}
                style={{ margin: 0 }}
              />
              {tag}
            </label>
          );
        })}
      </div>
    </Stack>
  );
}

// Two-line checkbox row: bold label on the first line next to the box,
// muted description aligned underneath. Replaces the older single-line
// "label — muted hint" layout, which crowded into a tiny column on the
// right of the box and wrapped awkwardly on narrow viewports.
function CheckboxField({
  checked, onChange, label, description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        fontSize: 13,
        color: "var(--fgColor-default, var(--uncon-fg, inherit))",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, flexShrink: 0 }}
      />
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span
          style={{
            color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
            fontSize: 12,
            lineHeight: "16px",
          }}
        >
          {description}
        </span>
      </span>
    </label>
  );
}

// Mod- and participant-facing reminder of the per-user submission cap on
// this conference. The count includes rejected/finished sessions since
// those still occupy quota slots on the server (participants would not see
// them in `submissions.list`, hence the explicit prop instead of filtering
// the visible list).
function MySessionQuotaHint({ current, limit }: { current: number; limit: number }) {
  const remaining = Math.max(0, limit - current);
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const accent = remaining === 0
    ? "var(--fgColor-danger, #cf222e)"
    : remaining <= Math.max(1, Math.floor(limit * 0.2))
      ? "var(--fgColor-attention, #9a6700)"
      : muted;
  const message = remaining === 0
    ? `You've used all ${limit} of your session submissions for this conference. Delete one of yours to free up a slot.`
    : `${current} of ${limit} session submissions used (${remaining} remaining).`;
  return (
    <Text>
      <span style={{ color: accent, fontSize: 13 }}>{message}</span>
    </Text>
  );
}
