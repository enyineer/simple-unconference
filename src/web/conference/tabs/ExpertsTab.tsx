// Experts tab: lets owner/mods promote conference members to "Expert", define
// bookable timeframes, manage expert room pools, and lets every conference
// member browse experts and book a 1:1 slot.
//
// Privacy: non-mods never see other bookers' names/emails (parity with the
// submitter_email rule in Submissions). The booker sees their own row.

import { useEffect, useState } from "react";
import {
  Banner, Button, Heading, Spinner, Stack,
} from "../../design-system";
import { useToast } from "../../design-system/hooks";
import { api, errorCode } from "../../api";
import type { Role, Room, Participant } from "../types";
import { EmptyState } from "../ui/EmptyState";
import { Tip } from "../ui/Tip";
import { ExpertCard } from "./experts/ExpertCard";
import { PromoteExpertSheet } from "./experts/PromoteExpertSheet";
import { EditExpertSheet } from "./experts/EditExpertSheet";
import { TimeframeSheet } from "./experts/TimeframeSheet";
import { PoolsSheet } from "./experts/PoolsSheet";
import { humanError } from "./experts/helpers";
import type { Expert, ExpertPool, ExpertSlot } from "./experts/types";

export function ExpertsTab({
  slug, role, timeZone,
}: {
  slug: string;
  role: Role;
  timeZone: string;
}) {
  const isMod = role === "owner" || role === "moderator";

  const [experts, setExperts] = useState<Expert[] | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [pools, setPools] = useState<ExpertPool[] | null>(null);
  const [people, setPeople] = useState<Participant[]>([]);
  const toast = useToast();

  const [poolsSheetOpen, setPoolsSheetOpen] = useState(false);
  const [promoteSheetOpen, setPromoteSheetOpen] = useState(false);
  const [tfExpertId, setTfExpertId] = useState<number | null>(null);
  const [editExpertId, setEditExpertId] = useState<number | null>(null);

  async function refresh() {
    try {
      const [ex, rs] = await Promise.all([
        api.experts.list({ slug }),
        api.rooms.listAll({ slug }),
      ]);
      setExperts(ex);
      setRooms(rs);
      if (isMod) {
        const [pp, ps] = await Promise.all([
          api.experts.listPools({ slug }),
          // Promote-expert picker enumerates every participant; ask for a
          // generous limit since we display them all in one dropdown.
          api.conferences.listParticipants({ slug, limit: 100 }),
        ]);
        setPools(pp);
        setPeople(ps.items);
      }
    } catch (e) {
      toast.error(errorCode(e));
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [slug, isMod]);

  async function book(expertId: number, slot: ExpertSlot) {
    try {
      await api.experts.book({ slug, expert_id: expertId, starts_at: slot.starts_at });
      toast.success("Booked. See you there!");
      await refresh();
    } catch (e) { toast.error(humanError(errorCode(e))); }
  }

  async function cancel(bookingId: number) {
    if (!confirm("Cancel this booking?")) return;
    try {
      await api.experts.cancelBooking({ slug, booking_id: bookingId });
      toast.success("Booking cancelled.");
      await refresh();
    } catch (e) { toast.error(humanError(errorCode(e))); }
  }

  async function demote(id: number) {
    if (!confirm("Remove expert status? All their timeframes and bookings will be deleted.")) return;
    try { await api.experts.demote({ slug, id }); }
    catch (e) { toast.error(humanError(errorCode(e))); }
    await refresh();
  }

  async function deleteTimeframe(expertId: number, id: number) {
    if (!confirm("Delete this timeframe? Existing bookings inside it will also be cancelled.")) return;
    try { await api.experts.deleteTimeframe({ slug, expert_id: expertId, id }); }
    catch (e) { toast.error(humanError(errorCode(e))); }
    await refresh();
  }

  const editingExpert = editExpertId
    ? experts?.find((e) => e.id === editExpertId) ?? null
    : null;
  const tfExpert = tfExpertId
    ? experts?.find((e) => e.id === tfExpertId) ?? null
    : null;

  // A new expert needs *something* to allocate as a room: either at least one
  // room (to be picked individually) or at least one pool (which itself must
  // contain rooms — empty pools wouldn't help, but creating them is on the
  // mod). Without either, promotion would always produce no_rooms_configured.
  const canPromote = rooms.length > 0 || (pools ?? []).length > 0;

  return (
    <Stack gap="spacious">
      <Stack direction="row" justify="between" align="center" wrap>
        <Heading level={2}>Experts</Heading>
        {isMod && (
          <Stack direction="row" gap="condensed">
            <Button onClick={() => setPoolsSheetOpen(true)}>Room pools</Button>
            <Button
              variant="primary"
              disabled={!canPromote}
              onClick={() => setPromoteSheetOpen(true)}
            >
              + Promote expert
            </Button>
          </Stack>
        )}
      </Stack>

      <Tip>
        Book a 1:1 chat with an expert. Each expert offers timeframes with
        fixed-length slots — pick one that works for you. A room is assigned
        automatically when you book.
      </Tip>

      {isMod && !canPromote && (
        // Persistent precondition — *not* a transient action result, so it
        // stays as an inline Banner. Tells the mod which prerequisite they
        // need to satisfy before "+ Promote expert" can be used.
        <Banner variant="warning">
          You need at least one room (Rooms tab) or one room pool before you can
          promote an expert.
        </Banner>
      )}

      {!experts ? (
        <Spinner label="Loading…" />
      ) : experts.length === 0 ? (
        <EmptyState message={isMod
          ? "No experts yet. Promote someone from your People list."
          : "No experts yet. The organizers haven't set any up."} />
      ) : (
        <Stack gap="spacious">
          {experts.map((e) => (
            <ExpertCard
              key={e.id}
              slug={slug}
              expert={e}
              rooms={rooms}
              isMod={isMod}
              timeZone={timeZone}
              onBook={(slot) => book(e.id, slot)}
              onCancel={cancel}
              onDemote={() => demote(e.id)}
              onAddTimeframe={() => setTfExpertId(e.id)}
              onDeleteTimeframe={(tfId) => deleteTimeframe(e.id, tfId)}
              onEdit={() => setEditExpertId(e.id)}
            />
          ))}
        </Stack>
      )}

      {isMod && (
        <PromoteExpertSheet
          open={promoteSheetOpen}
          slug={slug}
          rooms={rooms}
          pools={pools ?? []}
          people={people}
          existingExpertIdentityIds={new Set((experts ?? []).map((e) => e.identity_id))}
          onClose={() => setPromoteSheetOpen(false)}
          onDone={() => { setPromoteSheetOpen(false); refresh(); }}
        />
      )}

      {isMod && editingExpert && (
        <EditExpertSheet
          open
          slug={slug}
          expert={editingExpert}
          rooms={rooms}
          pools={pools ?? []}
          onClose={() => setEditExpertId(null)}
          onDone={() => { setEditExpertId(null); refresh(); }}
        />
      )}

      {isMod && tfExpert && (
        <TimeframeSheet
          open
          slug={slug}
          expert={tfExpert}
          timeZone={timeZone}
          onClose={() => setTfExpertId(null)}
          onDone={() => { setTfExpertId(null); refresh(); }}
        />
      )}

      {isMod && (
        <PoolsSheet
          open={poolsSheetOpen}
          slug={slug}
          rooms={rooms}
          pools={pools ?? []}
          onClose={() => setPoolsSheetOpen(false)}
          onDone={() => { refresh(); }}
        />
      )}
    </Stack>
  );
}
