// The Agenda tab — Calendar, slot-block sheet contents, slot creation/edit,
// per-room track editor, unconference configuration. The slot-block and its
// many subcomponents are extracted into the `./agenda` directory for
// readability; this file keeps only the tab-level shell.

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  Heading,
  Sheet,
  Spinner,
  Stack,
  Text,
} from "../../design-system";
import { useToast } from "../../design-system/hooks";
import { useNow } from "../../useNow";
import { api, errorCode } from "../../api";
import type { AgendaData, Room, Submission } from "../types";
import { AssignmentRulesTrigger } from "../ui/AssignmentRulesModal";
import { Tip } from "../ui/Tip";
import { useRequirementsConfirm } from "../ui/RequirementsConfirm";
import { ASSIGN_STEPS } from "../ui/agendaGuide";
import { Calendar, CalendarLegend } from "./Calendar";
import { slotSheetTitle } from "./agenda/types";
import { NewSlotForm } from "./agenda/NewSlotForm";
import { SlotBlock } from "./agenda/SlotBlock";
import { PitchModeSheet } from "./agenda/PitchModeSheet";
import { OnboardingChecklist } from "./agenda/OnboardingChecklist";

export function AgendaTab({
  slug,
  isMod,
  timeZone,
  mixerAvoidRepeatsDefault,
  myIdentityId,
}: {
  slug: string;
  isMod: boolean;
  timeZone: string;
  mixerAvoidRepeatsDefault: boolean;
  /** The viewer's conference identity id — lets slot bodies show
   *  submitter-derived state ("you host this session") before seating runs. */
  myIdentityId: number;
}) {
  const [data, setData] = useState<AgendaData | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [confirmingAssign, setConfirmingAssign] = useState(false);
  // Opt-in to also re-seat unchanged future slots (default off — the normal
  // run only touches stale slots). Lives in the confirm sheet; reset after use.
  const [alsoUnchanged, setAlsoUnchanged] = useState(false);
  // "Update seating" is re-runnable and encouraged as stars change, so let a
  // mod silence the confirmation after they've seen it once (persisted per
  // conference). The confirm still explains what the action does the first time.
  const assignConfirmKey = `agenda-skip-assign-confirm:${slug}`;
  const [skipAssignConfirm, setSkipAssignConfirm] = useState<boolean>(() => {
    try { return localStorage.getItem(assignConfirmKey) === "1"; } catch { return false; }
  });
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(null);
  const [pitchOpen, setPitchOpen] = useState(false);

  // Open the confirm, or assign straight away if the mod opted out of it.
  function requestAssignAll() {
    if (skipAssignConfirm) { void assignAll(); return; }
    setConfirmingAssign(true);
  }
  function persistSkipAssignConfirm(skip: boolean) {
    setSkipAssignConfirm(skip);
    try {
      if (skip) localStorage.setItem(assignConfirmKey, "1");
      else localStorage.removeItem(assignConfirmKey);
    } catch { /* storage disabled — keep the in-memory choice */ }
  }
  const toast = useToast();
  // Whole-minute "now", used to tell future slots from started ones for the
  // seating-staleness gate. `useNow` keeps it pure + ticks every minute.
  const now = useNow();

  const fetchAgenda = useCallback(() => Promise.all([
    api.agenda.get({ slug }),
    api.rooms.listAll({ slug }),
    api.submissions.listAll({ slug, status: "published" }),
  ]), [slug]);
  async function refresh() {
    const [a, r, s] = await fetchAgenda();
    setData(a);
    setRooms(r);
    setSubs(s);
  }
  useEffect(() => {
    let cancelled = false;
    fetchAgenda()
      .then(([a, r, s]) => {
        if (cancelled) return;
        setData(a); setRooms(r); setSubs(s);
      })
      .catch(() => {
        if (cancelled) return;
        setData({ slots: [], slot_series: [], tracks: [], placements: [], mixer_placements: [], participant_count: null, spotlight_submission_id: null });
      });
    return () => { cancelled = true; };
  }, [fetchAgenda]);

  async function moveSlot(id: number, starts_at: number, ends_at: number) {
    try {
      await api.agenda.updateSlot({ slug, id, starts_at, ends_at });
      await refresh();
    } catch (e) {
      toast.error(errorCode(e));
      await refresh(); // restore correct render if the update failed
    }
  }

  // "Update seating" re-seats attendees across the WHOLE agenda at once over
  // the existing placements — but only slots whose placements went stale since
  // their last seating (the per-slot "Place sessions from stars" button stays
  // for single-slot placement work). This is a batch action — disable the
  // button while it runs.
  const unconfSlots = (data?.slots ?? []).filter((s) => s.type === "unconference");
  const hasUnconfSlots = unconfSlots.length > 0;
  const placements = data?.placements ?? [];
  // "N sessions placed across M slots" derived from the placement rows, for
  // the step-1 caption. A session counts once even if recurring; slots are
  // the distinct unconference slots that have at least one placement.
  const placedSessionCount = new Set(placements.map((p) => p.submission_id)).size;
  const placedSlotCount = new Set(placements.map((p) => p.slot_id)).size;
  // Step-2 state, derived from slot staleness + seat counts:
  //   - future stale slots are the ones a normal "Update seating" would re-seat
  //   - nobody-seated-yet = placements exist but no seat has landed anywhere
  // A slot that has already started never moves, so only future slots count.
  const staleFutureCount = unconfSlots.filter(
    (s) => s.seating_stale && s.starts_at > now,
  ).length;
  const seatedCount = placements.reduce((n, p) => n + p.attendee_count, 0);
  const hasPlacements = placements.length > 0;
  // Enable "Update seating" when there's stale future work, or when sessions
  // are placed but nobody has been seated yet (the first-ever run).
  const canUpdateSeating =
    staleFutureCount > 0 || (hasPlacements && seatedCount === 0);
  async function assignAll() {
    setConfirmingAssign(false);
    setAssigning(true);
    try {
      const r = await api.agenda.assignAll({
        slug,
        ...(alsoUnchanged ? { include_unchanged: true } : {}),
      });
      const n = r.slot_ids.length;
      const unplaced = r.unplaced_user_ids.length;
      if (n === 0) {
        toast.success("Nothing needed updating.");
      } else {
        toast.success(
          `Seated attendees across ${n} slot${n === 1 ? "" : "s"}.` +
            (unplaced > 0 ? ` ${unplaced} could not be seated.` : ""),
        );
      }
      await refresh();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setAssigning(false);
      setAlsoUnchanged(false);
    }
  }

  const requirementsConfirm = useRequirementsConfirm();

  // Path C: the track-level star UI is wired to the *underlying Submission*.
  // Clicking the star on a planned track in the calendar toggles the
  // submission star — which then derives all linked TrackAssignments onto
  // the participant's schedule (including siblings, if the slot is in a
  // series). Requirements come from BOTH the track and the linked
  // submission, surfaced in one combined confirmation step.
  async function toggleStaticStar(track: {
    id: number;
    slot_id: number;
    starred_by_me: boolean;
  }) {
    const full = data?.tracks.find((t) => t.id === track.id);
    if (!full) return;
    const linkedSub = subs.find((s) => s.id === full.submission_id) ?? null;
    if (track.starred_by_me) {
      try {
        await api.submissions.unstar({ slug, id: full.submission_id });
        await refresh();
      } catch (e) {
        toast.error(errorCode(e));
      }
      return;
    }
    const requirements = Array.from(
      new Set([...(full.requirements ?? []), ...(linkedSub?.requirements ?? [])]),
    );
    requirementsConfirm.request({
      title: linkedSub?.title ?? "Session",
      requirements,
      onConfirm: async () => {
        try {
          await api.submissions.star({ slug, id: full.submission_id });
          await refresh();
        } catch (e) {
          toast.error(errorCode(e));
        }
      },
    });
  }

  async function toggleSubmissionStar(sub: {
    id: number;
    starred_by_me: boolean;
  }) {
    if (sub.starred_by_me) {
      try {
        await api.submissions.unstar({ slug, id: sub.id });
        await refresh();
      } catch (e) {
        toast.error(errorCode(e));
      }
      return;
    }
    const full = subs.find((s) => s.id === sub.id);
    requirementsConfirm.request({
      title: full?.title ?? "Session",
      requirements: full?.requirements ?? [],
      onConfirm: async () => {
        try {
          await api.submissions.star({ slug, id: sub.id });
          await refresh();
        } catch (e) {
          toast.error(errorCode(e));
        }
      },
    });
  }

  if (!data) return <Spinner label="Loading…" />;

  const selectedSlot = selectedSlotId
    ? data.slots.find((s) => s.id === selectedSlotId) ?? null
    : null;

  return (
    <Stack gap="spacious">
      {requirementsConfirm.modal}

      <Stack direction="row" justify="between" align="center">
        <Stack gap="condensed">
          <Heading level={2}>Agenda</Heading>
          <CalendarLegend />
        </Stack>
        <Stack direction="row" gap="condensed" align="center">
          {/* "Update seating" lives in the two-step card below, where it has
              the "place → seat" context. Keeping it only there avoids two
              identical primary actions competing on one screen. */}
          <AssignmentRulesTrigger isMod={isMod} label="How it works" />
          {isMod && (
            <Button onClick={() => setPitchOpen(true)}>
              Pitch mode
            </Button>
          )}
          {isMod && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              + Add slot
            </Button>
          )}
        </Stack>
      </Stack>

      {isMod && (
        <OnboardingChecklist
          slug={slug}
          roomsCount={rooms.length}
          hasPublishedSession={subs.some((s) => s.status === "published")}
          slotsCount={data.slots.length}
          hasPlacedSessions={placements.length > 0}
        />
      )}

      {/* Two-step framing, working as a live checklist. "Place sessions" (done
          inside unconference slots) FEEDS "Update seating". The numbered titles,
          the captions (which read as live status), and the disabled state when
          there's nothing to seat make the dependency literal. */}
      {isMod && hasUnconfSlots && (
        <Card>
          <Stack
            direction="row"
            gap="condensed"
            align="stretch"
            wrap
          >
            <TwoStepCard
              title={ASSIGN_STEPS.place.title}
              blurb={ASSIGN_STEPS.place.blurb}
              caption={
                placedSessionCount === 0
                  ? "No sessions placed yet — open an unconference slot to place sessions into rooms."
                  : `${placedSessionCount} session${placedSessionCount === 1 ? "" : "s"} placed across ${placedSlotCount} slot${placedSlotCount === 1 ? "" : "s"}.`
              }
            />
            <TwoStepCard
              title={ASSIGN_STEPS.assign.title}
              blurb={ASSIGN_STEPS.assign.blurb}
              action={
                <Button
                  variant="primary"
                  size="small"
                  onClick={requestAssignAll}
                  disabled={assigning || !canUpdateSeating}
                >
                  {assigning ? "Updating…" : "Update seating"}
                </Button>
              }
              caption={
                !hasPlacements
                  ? "Place at least one session first."
                  : staleFutureCount > 0
                    ? `${staleFutureCount} slot${staleFutureCount === 1 ? "" : "s"} changed since ${staleFutureCount === 1 ? "its" : "their"} last seating - Update seating re-seats just ${staleFutureCount === 1 ? "it" : "those"}.`
                    : seatedCount === 0
                      ? "No one seated yet."
                      : "Seating is up to date."
              }
            />
          </Stack>
        </Card>
      )}

      <Sheet
        open={confirmingAssign}
        onClose={() => { if (!assigning) setConfirmingAssign(false); }}
        title="Update seating"
      >
        <Stack gap="condensed">
          <Tip>
            {alsoUnchanged
              ? "Re-seats every future unconference slot that has placements. Slots that have already started, and each person's own session picks, are never touched. Only people whose seat changes are notified."
              : `Re-seats only the ${staleFutureCount} future slot${staleFutureCount === 1 ? "" : "s"} whose placements changed since ${staleFutureCount === 1 ? "it was" : "they were"} last seated. Slots that have already started, and each person's own session picks, are never touched. Only people whose seat changes are notified.`}
          </Tip>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={alsoUnchanged}
              onChange={(e) => setAlsoUnchanged(e.target.checked)}
            />
            Also re-seat unchanged future slots
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={skipAssignConfirm}
              onChange={(e) => persistSkipAssignConfirm(e.target.checked)}
            />
            Don&apos;t ask again on this conference
          </label>
          <Stack direction="row" gap="condensed">
            <Button variant="primary" onClick={assignAll} disabled={assigning}>
              {assigning ? "Updating…" : "Update seating"}
            </Button>
            <Button
              onClick={() => setConfirmingAssign(false)}
              disabled={assigning}
            >
              Cancel
            </Button>
          </Stack>
        </Stack>
      </Sheet>

      {isMod && (
        <PitchModeSheet
          slug={slug}
          open={pitchOpen}
          onClose={() => setPitchOpen(false)}
          subs={subs}
          activeId={data.spotlight_submission_id}
          onChanged={refresh}
        />
      )}

      <Sheet open={adding} onClose={() => setAdding(false)} title="Add slot">
        <NewSlotForm
          slug={slug}
          timeZone={timeZone}
          mixerAvoidRepeatsDefault={mixerAvoidRepeatsDefault}
          onCancel={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      </Sheet>


      {data.slots.length === 0 ? (
        <Card>
          <Stack gap="condensed">
            <Text muted>
              {isMod
                ? `No slots yet. Click "+ Add slot" to start the agenda.`
                : "The agenda hasn't been published yet."}
            </Text>
            {isMod && (
              <Text muted>
                Each slot is one of three types: Planned (you schedule each
                session into a room), Unconference (attendees star sessions and
                the app fills rooms + seats people), or Mixer (everyone is
                shuffled evenly across rooms to meet new people).
              </Text>
            )}
          </Stack>
        </Card>
      ) : (
        <>
          {isMod && (
            <Tip>
              Drag a slot to move it, or pull its top/bottom edge to resize.
              Click a slot to open its details.
            </Tip>
          )}
          <Calendar
            slots={data.slots}
            tracks={data.tracks}
            placements={data.placements}
            mixerPlacements={data.mixer_placements ?? []}
            rooms={rooms}
            subs={subs}
            isMod={isMod}
            timeZone={timeZone}
            selectedSlotId={selectedSlotId}
            onSelectSlot={(id) => setSelectedSlotId(id)}
            onMoveSlot={moveSlot}
            onToggleStaticStar={toggleStaticStar}
            onToggleSubmissionStar={toggleSubmissionStar}
          />
        </>
      )}

      <Sheet
        open={!!selectedSlot}
        onClose={() => setSelectedSlotId(null)}
        title={selectedSlot ? slotSheetTitle(selectedSlot) : ""}
      >
        {selectedSlot && (
          <SlotBlock
            key={selectedSlot.id}
            slug={slug}
            slot={selectedSlot}
            series={
              selectedSlot.series_id !== null
                ? data.slot_series.find((s) => s.id === selectedSlot.series_id) ?? null
                : null
            }
            rooms={rooms}
            subs={subs}
            tracks={data.tracks.filter((t) => t.slot_id === selectedSlot.id)}
            placements={data.placements.filter(
              (p) => p.slot_id === selectedSlot.id,
            )}
            recurrenceTimes={recurrenceTimesFor(selectedSlot.id, data)}
            participantCount={data.participant_count}
            isMod={isMod}
            myIdentityId={myIdentityId}
            timeZone={timeZone}
            inSheet
            onChange={refresh}
            onSelectSlot={(id) => setSelectedSlotId(id)}
          />
        )}
      </Sheet>
    </Stack>
  );
}

// For a given slot, build a map of submission_id -> the start times of every
// OTHER slot the same session is placed in. Drives the "also at HH:MM"
// recurrence hint on placement cards. Sorted ascending so the hint reads in
// chronological order.
function recurrenceTimesFor(
  slotId: number,
  data: AgendaData,
): Map<number, number[]> {
  const startById = new Map(data.slots.map((s) => [s.id, s.starts_at]));
  const out = new Map<number, number[]>();
  for (const p of data.placements) {
    if (p.slot_id === slotId) continue;
    const start = startById.get(p.slot_id);
    if (start === undefined) continue;
    const arr = out.get(p.submission_id) ?? [];
    arr.push(start);
    out.set(p.submission_id, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a - b);
  return out;
}

// One column of the "1 · Place sessions → 2 · Update seating" strip. Kept
// local to the tab since it's pure presentation specific to this header.
function TwoStepCard({
  title,
  blurb,
  caption,
  action,
}: {
  title: string;
  blurb: string;
  caption?: string;
  action?: React.ReactNode;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <div
      style={{
        flex: "1 1 240px",
        minWidth: 220,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 12,
        borderRadius: 8,
        border:
          "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background:
          "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.025)))",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12, color: muted, lineHeight: "17px" }}>
        {blurb}
      </div>
      {caption && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--fgColor-accent, #2563eb)",
          }}
        >
          {caption}
        </div>
      )}
      {action && <div style={{ marginTop: 2 }}>{action}</div>}
    </div>
  );
}
