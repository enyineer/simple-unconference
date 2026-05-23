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
import { api, errorCode } from "../../api";
import type { AgendaData, Room, Submission } from "../types";
import { AssignmentRulesTrigger } from "../ui/AssignmentRulesModal";
import { Tip } from "../ui/Tip";
import { useRequirementsConfirm } from "../ui/RequirementsConfirm";
import { Calendar, CalendarLegend } from "./Calendar";
import { slotSheetTitle } from "./agenda/types";
import { NewSlotForm } from "./agenda/NewSlotForm";
import { SlotBlock } from "./agenda/SlotBlock";

export function AgendaTab({
  slug,
  isMod,
  timeZone,
  mixerAvoidRepeatsDefault,
}: {
  slug: string;
  isMod: boolean;
  timeZone: string;
  mixerAvoidRepeatsDefault: boolean;
}) {
  const [data, setData] = useState<AgendaData | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [adding, setAdding] = useState(false);
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(null);
  const toast = useToast();

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
        setData({ slots: [], slot_series: [], tracks: [], placements: [], mixer_placements: [] });
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
          <AssignmentRulesTrigger isMod={isMod} />
          {isMod && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              + Add slot
            </Button>
          )}
        </Stack>
      </Stack>

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
          <Text muted>
            {isMod
              ? `No slots yet. Click "Add slot" to start the agenda.`
              : "The agenda hasn't been published yet."}
          </Text>
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
            isMod={isMod}
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
