import { useState } from "react";
import { Button, Heading, Select, Stack, Text } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Room, Submission } from "../../types";

// Moderator-only control to author the unconference occurrence set: place a
// session into this slot + room (or let the server auto-pick the room). The
// global "Assign attendees" action then routes participants over these
// placements. Mirrors the `scheduleSubmission` authoring pattern for planned
// slots, but writes an `UnconferencePlacement`.
export function PlacementAuthor({
  slug,
  slotId,
  eligibleSubs,
  eligibleRooms,
  placedSubmissionIds,
  takenRoomIds,
  onChange,
}: {
  slug: string;
  slotId: number;
  eligibleSubs: Submission[];
  eligibleRooms: Room[];
  placedSubmissionIds: Set<number>;
  takenRoomIds: Set<number>;
  onChange: () => Promise<void>;
}) {
  const toast = useToast();
  const [subId, setSubId] = useState<string>("");
  const [roomId, setRoomId] = useState<string>(""); // "" = auto-pick
  const [busy, setBusy] = useState(false);

  const addable = eligibleSubs.filter((s) => !placedSubmissionIds.has(s.id));
  const freeRooms = eligibleRooms.filter((r) => !takenRoomIds.has(r.id));

  const heading = (
    <Stack gap="condensed">
      <Heading level={4}>Place sessions in this slot</Heading>
      <Text muted>
        Pick a session and room. Place the same session on other slots to make
        it recurring.
      </Text>
    </Stack>
  );

  if (addable.length === 0) {
    // Everything eligible is already placed — keep the heading so the section
    // doesn't vanish, and tell the mod why there's nothing to add.
    return (
      <Stack gap="condensed">
        {heading}
        <Text muted>All eligible sessions are placed here.</Text>
      </Stack>
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
    <Stack gap="condensed">
      {heading}
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
            ...freeRooms.map((r) => ({ value: String(r.id), label: `${r.name} · ${r.capacity}` })),
          ]}
        />
        <Button variant="default" onClick={place} disabled={busy}>
          {busy ? "Placing…" : "Place"}
        </Button>
      </Stack>
    </Stack>
  );
}

function conflictMessage(r: {
  reason: "pin_room_taken" | "pin_room_out_of_scope" | "unsatisfiable_requirements" | "no_free_room";
  required_tags: string[];
  candidate_room_names: string[];
}): string {
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
  }
}
