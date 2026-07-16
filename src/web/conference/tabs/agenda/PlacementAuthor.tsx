import { useState } from "react";
import { Button, Select, Stack, Text } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import { Disclosure } from "../../ui/Disclosure";
import { slotRoomBlockReason } from "../../roomConstraints";
import type { Room, Slot, Submission } from "../../types";

// Moderator-only control to author the unconference occurrence set: place a
// session into this slot + room (or let the server auto-pick the room). The
// global "Update seating" action then routes participants over these
// placements. Mirrors the `scheduleSubmission` authoring pattern for planned
// slots, but writes an `UnconferencePlacement`.
//
// Rendered as a collapsed Disclosure: placing from stars (the slot's primary
// button) is the default path, and hand-placing is the deliberate exception —
// the visual hierarchy should say so.
export function PlacementAuthor({
  slug,
  slot,
  eligibleSubs,
  eligibleRooms,
  placedSubmissionIds,
  takenRoomIds,
  onChange,
}: {
  slug: string;
  slot: Slot;
  eligibleSubs: Submission[];
  eligibleRooms: Room[];
  placedSubmissionIds: Set<number>;
  takenRoomIds: Set<number>;
  onChange: () => Promise<void>;
}) {
  const toast = useToast();
  const slotId = slot.id;
  const [subId, setSubId] = useState<string>("");
  const [roomId, setRoomId] = useState<string>(""); // "" = auto-pick
  const [busy, setBusy] = useState(false);

  const addable = eligibleSubs.filter((s) => !placedSubmissionIds.has(s.id));
  const freeRooms = eligibleRooms.filter((r) => !takenRoomIds.has(r.id));
  // Rooms that are physically unusable for THIS slot (reserved for experts, or
  // outside their availability windows) can't host a placement — the server
  // would reject them. Drop them from the picker and explain below, rather
  // than offering a choice that always fails.
  const pickableRooms = freeRooms.filter((r) => slotRoomBlockReason(r, slot) === null);
  const blockedRooms = freeRooms
    .map((r) => ({ room: r, reason: slotRoomBlockReason(r, slot) }))
    .filter((x): x is { room: Room; reason: string } => x.reason !== null);

  if (addable.length === 0) {
    // Everything eligible is already placed — keep the disclosure so the
    // affordance doesn't vanish, and tell the mod why there's nothing to add.
    return (
      <Disclosure summary="Place a session by hand">
        <Text muted>All eligible sessions are placed here.</Text>
      </Disclosure>
    );
  }

  async function place() {
    const submission_id = Number(subId || addable[0]!.id);
    setBusy(true);
    try {
      const r = await api.agenda.placeSubmission({
        slug,
        slot_id: slotId,
        submission_id,
        ...(roomId ? { room_id: Number(roomId) } : {}),
      });
      if (r.kind === "conflict") {
        toast.error(conflictMessage(r));
        return;
      }
      toast.success(`Placed in ${r.room_name}`);
      setSubId("");
      setRoomId("");
      await onChange();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Disclosure summary="Place a session by hand">
      <Stack gap="condensed">
        <Text muted>
          Pick a session and room yourself - normally &ldquo;Place sessions
          from stars&rdquo; does this for you. Place the same session on other
          slots to make it recurring.
        </Text>
        <Stack
          direction="row"
          gap="condensed"
          align="end"
          wrap
        >
          <Select
            label="Add session"
            value={subId || String(addable[0]!.id)}
            disabled={busy}
            onChange={(e) => setSubId(e.target.value)}
            options={addable.map((s) => ({ value: String(s.id), label: s.title }))}
          />
          <Select
            label="Room"
            value={roomId}
            disabled={busy}
            onChange={(e) => setRoomId(e.target.value)}
            options={[
              { value: "", label: "Auto (largest free)" },
              ...pickableRooms.map((r) => ({ value: String(r.id), label: `${r.name} · ${r.capacity}` })),
            ]}
          />
          <Button variant="default" onClick={place} disabled={busy}>
            {busy ? "Placing…" : "Place"}
          </Button>
        </Stack>
        {blockedRooms.length > 0 && (
          <Text muted>
            Not listed:{" "}
            {blockedRooms
              .map((x) => `${x.room.name} (${x.reason.toLowerCase()})`)
              .join(", ")}
            .
          </Text>
        )}
      </Stack>
    </Disclosure>
  );
}

function conflictMessage(
  r: Extract<Awaited<ReturnType<typeof api.agenda.placeSubmission>>, { kind: "conflict" }>,
): string {
  switch (r.reason) {
    case "pin_room_taken":
      return "That room is already used by another session in this slot.";
    case "pin_room_out_of_scope":
      return "That room isn't in this slot's room scope.";
    case "unsatisfiable_requirements":
      return r.required_tags.length > 0
        ? `No free room satisfies the required tags: ${r.required_tags.join(", ")}.`
        : "No room satisfies this session's requirements.";
    case "no_free_room":
      return "Every room in this slot's scope is already taken.";
    case "room_expert_dedicated":
      return r.pool_name
        ? `${r.room.name} is reserved for experts (${r.pool_name}) and can't host a session.`
        : `${r.room.name} is reserved for experts and can't host a session.`;
    case "room_unavailable":
      return `${r.room.name} isn't available during this slot's time.`;
  }
}
