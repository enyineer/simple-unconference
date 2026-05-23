import { useState } from "react";
import { Button, Card, Stack, Text } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Room, Slot, Submission } from "../../types";
import { Tip } from "../../ui/Tip";

export function SlotConfigure({
  slug,
  slot,
  rooms,
  subs,
  onSaved,
}: {
  slug: string;
  slot: Slot;
  rooms: Room[];
  subs: Submission[];
  onSaved: () => Promise<void>;
}) {
  const isMixer = slot.type === "mixer";
  const [useAllRooms, setUseAllRooms] = useState(slot.unconf_use_all_rooms);
  const [useAllSubs, setUseAllSubs] = useState(slot.unconf_use_all_submissions);
  const [avoidRepeats, setAvoidRepeats] = useState(slot.unconf_avoid_repeats);
  const [pickedRooms, setPickedRooms] = useState<Set<number>>(
    () =>
      new Set(
        slot.unconf_use_all_rooms
          ? rooms.map((r) => r.id)
          : slot.unconf_room_ids,
      ),
  );
  const [pickedSubs, setPickedSubs] = useState<Set<number>>(
    () =>
      new Set(
        slot.unconf_use_all_submissions
          ? subs.map((s) => s.id)
          : slot.unconf_submission_ids,
      ),
  );
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function save() {
    setBusy(true);
    try {
      await api.agenda.updateSlot({
        slug,
        id: slot.id,
        unconf_use_all_rooms: useAllRooms,
        unconf_use_all_submissions: useAllSubs,
        unconf_avoid_repeats: avoidRepeats,
        unconf_room_ids: useAllRooms ? [] : [...pickedRooms],
        unconf_submission_ids: useAllSubs ? [] : [...pickedSubs],
      });
      await onSaved();
      toast.success("Slot configuration saved.");
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle<T>(set: Set<T>, val: T): Set<T> {
    const next = new Set(set);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    return next;
  }

  return (
    <Card
      title={isMixer ? "Configure mixer slot" : "Configure unconference slot"}
    >
      <Stack gap="condensed">
        <Stack gap="condensed">
          <Text>
            <strong>Rooms</strong>
          </Text>
          <Stack direction="row" gap="condensed">
            <Button
              size="small"
              variant={useAllRooms ? "primary" : "default"}
              onClick={() => setUseAllRooms(true)}
            >
              All rooms
            </Button>
            <Button
              size="small"
              variant={!useAllRooms ? "primary" : "default"}
              onClick={() => setUseAllRooms(false)}
            >
              Select rooms
            </Button>
          </Stack>
          {!useAllRooms && (
            <Stack direction="row" gap="condensed" wrap>
              {rooms.map((r) => (
                <Button
                  key={r.id}
                  size="small"
                  variant={pickedRooms.has(r.id) ? "primary" : "default"}
                  onClick={() => setPickedRooms((s) => toggle(s, r.id))}
                >
                  {r.name}
                </Button>
              ))}
              {rooms.length === 0 && <Text muted>No rooms exist yet.</Text>}
            </Stack>
          )}
        </Stack>

        {!isMixer && (
          <Stack gap="condensed">
            <Text>
              <strong>Eligible submissions</strong>
            </Text>
            <Stack direction="row" gap="condensed">
              <Button
                size="small"
                variant={useAllSubs ? "primary" : "default"}
                onClick={() => setUseAllSubs(true)}
              >
                All published
              </Button>
              <Button
                size="small"
                variant={!useAllSubs ? "primary" : "default"}
                onClick={() => setUseAllSubs(false)}
              >
                Select submissions
              </Button>
            </Stack>
            {!useAllSubs && (
              <Stack direction="row" gap="condensed" wrap>
                {subs.map((s) => (
                  <Button
                    key={s.id}
                    size="small"
                    variant={pickedSubs.has(s.id) ? "primary" : "default"}
                    onClick={() => setPickedSubs((set) => toggle(set, s.id))}
                  >
                    {s.title}
                  </Button>
                ))}
                {subs.length === 0 && (
                  <Text muted>No published submissions yet.</Text>
                )}
              </Stack>
            )}
          </Stack>
        )}

        {!isMixer && (
          <Stack gap="condensed">
            <Text>
              <strong>Repeat avoidance</strong>
            </Text>
            <Tip>
              When on, attendees won&apos;t be assigned to a session they&apos;ve already
              been placed in. Session creators always lead their own session
              regardless.
            </Tip>
            <Stack direction="row" gap="condensed">
              <Button
                size="small"
                variant={avoidRepeats ? "primary" : "default"}
                onClick={() => setAvoidRepeats(true)}
              >
                Avoid repeats
              </Button>
              <Button
                size="small"
                variant={!avoidRepeats ? "primary" : "default"}
                onClick={() => setAvoidRepeats(false)}
              >
                Allow repeats
              </Button>
            </Stack>
          </Stack>
        )}

        <Stack direction="row" gap="condensed">
          <Button variant="primary" onClick={save} disabled={busy}>
            Save configuration
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}
