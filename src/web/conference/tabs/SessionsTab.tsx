import { useEffect, useMemo, useState } from "react";
import {
  Banner,
  Button,
  Heading,
  Sheet,
  Spinner,
  Stack,
} from "../../design-system";
import { api, errorCode } from "../../api";
import { useToast } from "../../design-system/hooks";
import type { Participant, Role, Room, Submission } from "../types";
import { submitterLabel } from "../helpers";
import { EmptyState } from "../ui/EmptyState";
import { useRequirementsConfirm } from "../ui/RequirementsConfirm";
import type { SessionFilter } from "./sessions/types";
import { SessionFilterBar } from "./sessions/SessionFilterBar";
import { SessionCard } from "./sessions/SessionCard";
import { SessionForm } from "./sessions/SessionForm";
import { MySessionQuotaHint } from "./sessions/MySessionQuotaHint";

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
          .join("   ")
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
              slug={slug}
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
