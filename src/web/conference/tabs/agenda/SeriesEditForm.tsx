import { useState } from "react";
import {
  Button,
  Card,
  Sheet,
  Stack,
  Text,
} from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Room, SlotSeries, Submission } from "../../types";
import { Tip } from "../../ui/Tip";

// ---- Series-level configure form ------------------------------------------
//
// Replaces `SlotConfigure` when the slot belongs to a series. Edits hit
// `agenda.updateSeries` so changes propagate to every sibling via the
// resolver. The endpoint short-circuits with `kind: "needs_confirmation"`
// when the patch would orphan existing track assignments or placements;
// the modal here surfaces what would be removed and offers a confirm-and-
// cascade button.
export function SeriesEditForm({
  slug,
  series,
  rooms,
  subs,
  onSaved,
}: {
  slug: string;
  series: SlotSeries;
  rooms: Room[];
  subs: Submission[];
  onSaved: () => Promise<void>;
}) {
  const isMixer = series.type === "mixer";
  const [useAllRooms, setUseAllRooms] = useState(series.unconf_use_all_rooms);
  const [useAllSubs, setUseAllSubs] = useState(series.unconf_use_all_submissions);
  const [avoidRepeats, setAvoidRepeats] = useState(series.unconf_avoid_repeats);
  const [acrossSiblings, setAcrossSiblings] = useState(series.avoid_repeats_across_siblings);
  const [pickedRooms, setPickedRooms] = useState<Set<number>>(
    () => new Set(series.unconf_use_all_rooms ? rooms.map((r) => r.id) : series.unconf_room_ids),
  );
  const [pickedSubs, setPickedSubs] = useState<Set<number>>(
    () => new Set(series.unconf_use_all_submissions ? subs.map((s) => s.id) : series.unconf_submission_ids),
  );
  const [busy, setBusy] = useState(false);
  // Captured server response when a save needs confirmation. The modal
  // re-fires the same patch with `confirm: true` when the mod agrees.
  const [pendingConfirm, setPendingConfirm] = useState<{
    removed_track_assignments: number;
    removed_unconference_placements: number;
    removed_user_assignments: number;
    removed_room_ids: number[];
    removed_submission_ids: number[];
  } | null>(null);
  const toast = useToast();

  function toggle<T>(set: Set<T>, val: T): Set<T> {
    const next = new Set(set);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    return next;
  }

  async function save(confirm = false) {
    setBusy(true);
    try {
      const res = await api.agenda.updateSeries({
        slug,
        id: series.id,
        unconf_use_all_rooms: useAllRooms,
        unconf_use_all_submissions: useAllSubs,
        unconf_avoid_repeats: avoidRepeats,
        avoid_repeats_across_siblings: acrossSiblings,
        unconf_room_ids: useAllRooms ? [] : [...pickedRooms],
        unconf_submission_ids: useAllSubs ? [] : [...pickedSubs],
        confirm,
      });
      if (res.kind === "needs_confirmation") {
        setPendingConfirm({
          removed_track_assignments: res.removed_track_assignments,
          removed_unconference_placements: res.removed_unconference_placements,
          removed_user_assignments: res.removed_user_assignments,
          removed_room_ids: res.removed_room_ids,
          removed_submission_ids: res.removed_submission_ids,
        });
        return;
      }
      setPendingConfirm(null);
      toast.success("Series updated.");
      await onSaved();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSeries(mode: "series_only" | "with_slots") {
    const msg = mode === "series_only"
      ? "Disband this series? Each offering will become a standalone slot " +
        "with the series's current configuration snapshotted onto it. The " +
        "offerings themselves are kept."
      : "Delete this series AND every offering in it? This removes the " +
        "slots from the calendar; track assignments and placements on " +
        "them go too. Cannot be undone.";
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await api.agenda.deleteSeries({ slug, id: series.id, mode });
      toast.success(mode === "series_only" ? "Series disbanded; offerings kept." : "Series deleted.");
      await onSaved();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  const roomNameById = new Map(rooms.map((r) => [r.id, r.name]));
  const subTitleById = new Map(subs.map((s) => [s.id, s.title]));

  return (
    <Card title={isMixer ? "Configure mixer series" : "Configure unconference series"}>
      <Stack gap="condensed">
        <Tip>
          Editing here applies to every linked offering ({series.slot_ids.length} total).
          Per-instance fields (time, title, description) stay on each
          offering via its own Edit form.
        </Tip>

        <Stack gap="condensed">
          <Text><strong>Rooms</strong></Text>
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
            <Text><strong>Eligible submissions</strong></Text>
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
                {subs.length === 0 && <Text muted>No published submissions yet.</Text>}
              </Stack>
            )}
          </Stack>
        )}

        {!isMixer && (
          <Stack gap="condensed">
            <Text><strong>Repeat avoidance</strong></Text>
            <Tip>
              Conference-wide avoid: never assign a participant to a session
              they&apos;ve already attended in any earlier slot of the conference.
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

        <Stack gap="condensed">
          <Text><strong>Cross-offering rotation</strong></Text>
          <Tip>
            When on (the default), a participant placed in a session in one
            offering won&apos;t be re-placed in the same session in a sibling
            offering — so duplicating a slot to add capacity actually
            rotates people through. Turn off for series where attending
            twice is the point (e.g. an open discussion that runs three
            times).
          </Tip>
          <Stack direction="row" gap="condensed">
            <Button
              size="small"
              variant={acrossSiblings ? "primary" : "default"}
              onClick={() => setAcrossSiblings(true)}
            >
              Rotate across offerings
            </Button>
            <Button
              size="small"
              variant={!acrossSiblings ? "primary" : "default"}
              onClick={() => setAcrossSiblings(false)}
            >
              Allow re-attendance
            </Button>
          </Stack>
        </Stack>

        <Stack direction="row" gap="condensed">
          <Button variant="primary" onClick={() => save(false)} disabled={busy}>
            Save series
          </Button>
        </Stack>

        <Stack gap="condensed">
          <Text muted>
            <strong>Series lifecycle.</strong> &ldquo;Disband&rdquo; keeps every
            offering as a standalone slot. &ldquo;Delete with offerings&rdquo; removes
            the series and every offering in it.
          </Text>
          <Stack direction="row" gap="condensed" wrap>
            <Button onClick={() => deleteSeries("series_only")} disabled={busy}>
              Disband series
            </Button>
            <Button variant="danger" onClick={() => deleteSeries("with_slots")} disabled={busy}>
              Delete with offerings
            </Button>
          </Stack>
        </Stack>
      </Stack>

      {pendingConfirm && (
        <Sheet
          open
          onClose={() => setPendingConfirm(null)}
          title="Confirm series change"
        >
          <Stack gap="condensed">
            <Text>
              This change would remove existing assignments from one or
              more offerings:
            </Text>
            <Stack gap="condensed">
              {pendingConfirm.removed_track_assignments > 0 && (
                <Text>
                  • {pendingConfirm.removed_track_assignments} track
                  assignment(s) in planned offerings
                </Text>
              )}
              {pendingConfirm.removed_unconference_placements > 0 && (
                <Text>
                  • {pendingConfirm.removed_unconference_placements}{" "}
                  unconference placement(s)
                </Text>
              )}
              {pendingConfirm.removed_user_assignments > 0 && (
                <Text>
                  • {pendingConfirm.removed_user_assignments}{" "}
                  participant assignment(s) affected
                </Text>
              )}
              {pendingConfirm.removed_room_ids.length > 0 && (
                <Text muted>
                  Rooms dropped from the pool:{" "}
                  {pendingConfirm.removed_room_ids
                    .map((id) => roomNameById.get(id) ?? `#${id}`)
                    .join(", ")}
                </Text>
              )}
              {pendingConfirm.removed_submission_ids.length > 0 && (
                <Text muted>
                  Sessions dropped from the pool:{" "}
                  {pendingConfirm.removed_submission_ids
                    .map((id) => subTitleById.get(id) ?? `#${id}`)
                    .join(", ")}
                </Text>
              )}
            </Stack>
            <Stack direction="row" gap="condensed">
              <Button variant="danger" onClick={() => save(true)} disabled={busy}>
                Apply and remove
              </Button>
              <Button onClick={() => setPendingConfirm(null)} disabled={busy}>
                Cancel
              </Button>
            </Stack>
          </Stack>
        </Sheet>
      )}
    </Card>
  );
}
