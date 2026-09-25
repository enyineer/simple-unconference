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
import { EmptyState } from "../ui/EmptyState";
import { Pager } from "../ui/Pager";
import { Tip } from "../ui/Tip";
import { useRequirementsConfirm } from "../ui/RequirementsConfirm";
import { usePaginatedList } from "../usePaginatedList";
import type { SessionFilter } from "./sessions/types";
import { SessionFilterBar } from "./sessions/SessionFilterBar";
import { SessionCard } from "./sessions/SessionCard";
import { SessionForm } from "./sessions/SessionForm";
import { MySessionQuotaHint } from "./sessions/MySessionQuotaHint";
import { WelcomeRail } from "./sessions/WelcomeRail";
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
  timeZone: string;
  submissionMaxPlacementsDefault: number | null;
  participantSubmissionsEnabled: boolean;
  mySessionCount: number;
  maxSessionsPerUser: number | null;
  onSessionMutated: () => void;
}) {
  const isMod = role === "owner" || role === "moderator";
  const [filter, setFilter] = useState<SessionFilter>(
    isMod ? "all" : "published",
  );
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [starredOnly, setStarredOnly] = useState(false);
  const toast = useToast();

  // Server-paginated session list. The hook owns `q`/cursor/total state;
  // status, tag, and starred-only filters are passed in as inputs so paging
  // accounts include them.
  const subs = usePaginatedList<Submission>(
    (input) => api.submissions.list({
      slug,
      status: isMod && filter !== "all" ? filter : undefined,
      tags: selectedTags.length > 0 ? selectedTags : undefined,
      starred_only: starredOnly || undefined,
      ...input,
    }),
    { pageSize: 25 },
  );

  // Re-run the query whenever the non-search filters change. `usePaginatedList`
  // owns the search input so this is the cleanest way to wire status / tag /
  // starred toggles through the same pipeline.
  useEffect(() => {
    subs.refresh();
    // Resetting cursor when filter changes is intentional but handled by
    // refresh — the user expects to see page 1 of the new filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, starredOnly, selectedTags.join("|")]);

  // Deep-link highlight (?highlight=<id>): share links ("Copy link" on a
  // card) and the board's spotlight QR land here. The list is cursor-
  // paginated, so the target may sit on any page or be filtered out — when
  // it's not among the current page's items, a separately-fetched copy is
  // pinned above the list, so the link always surfaces its session no matter
  // what pagination state the viewer happens to be in.
  const highlightId = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get("highlight");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }, []);
  const [highlightDismissed, setHighlightDismissed] = useState(false);
  // Key-tagged fetch result (the usePaginatedList pattern): a change to any
  // input produces a new key, and stale results for old keys render as null
  // — no reset-setState needed, staleness is impossible by construction.
  const [pinnedFetch, setPinnedFetch] = useState<{ key: string; sub: Submission | null }>({
    key: "",
    sub: null,
  });
  const [pinnedTick, setPinnedTick] = useState(0);
  const pinnedKey = `${slug}|${highlightId ?? ""}|${highlightDismissed}|${pinnedTick}`;
  useEffect(() => {
    if (highlightId === null || highlightDismissed) return;
    let cancelled = false;
    api.submissions.list({ slug, ids: [highlightId], limit: 1 })
      .then((p) => {
        if (!cancelled) setPinnedFetch({ key: pinnedKey, sub: p.items[0] ?? null });
      })
      .catch(() => {
        if (!cancelled) setPinnedFetch({ key: pinnedKey, sub: null });
      });
    return () => { cancelled = true; };
    // pinnedKey encodes slug + target id + dismissal + refresh tick, so it
    // fully drives effect identity (same reasoning as usePaginatedList).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedKey]);
  const pinned = pinnedFetch.key === pinnedKey ? pinnedFetch.sub : null;

  const highlightActive = highlightId !== null && !highlightDismissed;
  // The highlighted session ALWAYS renders pinned at the top and is filtered
  // out of the paginated list below, so it can never appear twice. While the
  // pinned copy is still loading (or if its fetch failed), the in-list row
  // stays put with the highlight styling as a graceful fallback.
  const pinnedShown = highlightActive && pinned !== null;

  function clearHighlight() {
    setHighlightDismissed(true);
    setPinnedTick((t) => t + 1);
    const url = new URL(window.location.href);
    url.searchParams.delete("highlight");
    window.history.replaceState(null, "", url);
  }

  // List mutations refresh the pinned copy too, so a starred/deleted/edited
  // highlighted session never shows stale state.
  const refreshSubs = () => {
    subs.refresh();
    setPinnedTick((t) => t + 1);
  };

  // Rooms / participants needed by the create + edit forms. These use the
  // unpaginated `listAll` because the form's room picker and submitter
  // dropdown must enumerate every row.
  const [rooms, setRooms] = useState<Room[]>([]);
  useEffect(() => {
    api.rooms.listAll({ slug }).then(setRooms).catch(() => setRooms([]));
  }, [slug]);
  const [fetchedParticipants, setFetchedParticipants] = useState<Participant[]>([]);
  useEffect(() => {
    if (!isMod) return;
    let cancelled = false;
    // Load every participant for the submitter-reassign dropdown. We pass a
    // generous `limit` so the form's roster covers conferences of any size;
    // see `conferences.listParticipants` for the page contract.
    api.conferences
      .listParticipants({ slug, limit: 100 })
      .then((p) => { if (!cancelled) setFetchedParticipants(p.items); })
      .catch(() => { if (!cancelled) setFetchedParticipants([]); });
    return () => { cancelled = true; };
  }, [slug, isMod]);
  const participants = isMod ? fetchedParticipants : [];
  const availableRoomTags = useMemo(
    () => Array.from(new Set(rooms.flatMap((r) => r.tags))).sort(),
    [rooms],
  );

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [myUserId, setMyUserId] = useState<number | null>(null);
  useEffect(() => {
    api.conferences
      .me({ slug })
      .then((u) => setMyUserId(u.id))
      .catch(() => {});
  }, [slug]);

  async function deleteSubmission(s: Submission) {
    const msg = isMod
      ? `Delete "${s.title}"? This cannot be undone.`
      : `Withdraw "${s.title}"? It will be removed from the conference.`;
    if (!confirm(msg)) return;
    try {
      await api.submissions.delete({ slug, id: s.id });
      refreshSubs();
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
        refreshSubs();
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
          refreshSubs();
          toast.success("Starred — interest signal. Seats are assigned when moderators run seating.");
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
      refreshSubs();
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

  // Tag chip options derive from the current page's items. The set shifts
  // as the user pages through — acceptable tradeoff for not maintaining a
  // separate "all tags in conference" endpoint. Sorted alphabetically.
  const availableSessionTags = useMemo(() => {
    return Array.from(new Set(subs.items.flatMap((s) => s.tags))).sort();
  }, [subs.items]);

  // Drop any selected tag that no longer appears on the current page so
  // the chip set doesn't show "selected" pills the user can't see in the
  // available list. The filter still applies server-side; this only
  // affects rendering.
  const visibleSelectedTags = useMemo(() => {
    const offered = new Set([...availableSessionTags, ...selectedTags]);
    return selectedTags.filter((t) => offered.has(t));
  }, [availableSessionTags, selectedTags]);

  function toggleTag(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  function clearFilters() {
    subs.setQ("");
    setSelectedTags([]);
    setStarredOnly(false);
  }

  const anyFilterActive =
    subs.q.trim().length > 0 || selectedTags.length > 0 || starredOnly;

  const editingSub = editingId
    ? (subs.items.find((s) => s.id === editingId) ?? (pinned?.id === editingId ? pinned : null))
    : null;

  return (
    <Stack gap="spacious">
      {requirementsConfirm.modal}

      {!isMod && <WelcomeRail slug={slug} />}

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

      {isMod && !participantSubmissionsEnabled && (
        <Tip>
          Attendees can&apos;t submit their own sessions right now. Turn on
          participant submissions in Settings for a crowd-sourced unconference.
        </Tip>
      )}

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
              refreshSubs();
              onSessionMutated();
            }}
          />
        )}
      </Sheet>

      {/* Mod-only status chips. Counts removed for the paginated rewrite —
          totals only apply to the active filter (visible in the Pager).
          Reach for a dedicated `statusCounts` proc if the count badges
          become important again. */}
      {isMod && (
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
              {filterLabel(k)}
            </Button>
          ))}
        </Stack>
      )}

      <SessionFilterBar
        query={subs.q}
        onQueryChange={subs.setQ}
        availableTags={availableSessionTags}
        selectedTags={visibleSelectedTags}
        onToggleTag={toggleTag}
        starredOnly={starredOnly}
        onStarredOnlyChange={setStarredOnly}
        totalCount={subs.total}
        visibleCount={subs.items.length}
        anyFilterActive={anyFilterActive}
        onClear={clearFilters}
      />

      {/* A shared/highlighted session always renders pinned at the top and
          is filtered out of the list below, so the link surfaces its session
          no matter where cursor pagination sits and it never renders twice. */}
      {pinnedShown && pinned && (
        <Stack gap="condensed">
          <Stack direction="row" justify="end">
            <Button size="small" onClick={clearHighlight}>
              Clear highlight
            </Button>
          </Stack>
          <SessionCard
            slug={slug}
            s={pinned}
            canEdit={canEdit(pinned)}
            canDelete={canEdit(pinned)}
            isMod={isMod}
            timeZone={timeZone}
            roomName={
              pinned.pre_assigned_room_id === null
                ? null
                : rooms.find((r) => r.id === pinned.pre_assigned_room_id)?.name ?? null
            }
            highlight
            onStar={() => toggleStar(pinned)}
            onEdit={() => setEditingId(pinned.id)}
            onDelete={() => deleteSubmission(pinned)}
            onStatus={(action) => setStatus(pinned, action)}
          />
        </Stack>
      )}

      {subs.loading && subs.items.length === 0 ? (
        <Spinner label="Loading…" />
      ) : subs.items.length === 0 ? (
        <EmptyState
          message={
            anyFilterActive
              ? "No sessions match your filters."
              : isMod && filter !== "all"
                ? `No sessions with status "${filter}".`
                : isMod
                  ? "No sessions yet. Add a few rooms first, then create a session here — publish it so it can be scheduled or starred. (You can also let attendees submit their own from Settings.)"
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
          {subs.items
            .filter((s) => !(pinnedShown && s.id === highlightId))
            .map((s) => (
            <SessionCard
              key={s.id}
              slug={slug}
              s={s}
              canEdit={canEdit(s)}
              canDelete={canEdit(s)}
              isMod={isMod}
              timeZone={timeZone}
              highlight={highlightActive && !pinnedShown && s.id === highlightId}
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

      <Pager
        page={subs.page}
        pageSize={subs.pageSize}
        total={subs.total}
        loading={subs.loading}
        hasPrev={subs.hasPrev}
        hasNext={subs.hasNext}
        onPrev={subs.prev}
        onNext={subs.next}
        noun="sessions"
      />

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
              refreshSubs();
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
