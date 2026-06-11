import { useState } from "react";
import {
  Button,
  DateTime,
  Form,
  Stack,
  TextInput,
} from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Slot } from "../../types";
import { Tip } from "../../ui/Tip";

// ---- Duplicate-slot sheet contents ----------------------------------------
//
// Mods click "Duplicate" on any slot to spawn another offering of it. If the
// source is standalone, the server creates a SlotSeries rooted at the source
// and links both. If the source is already in a series, the new sibling
// joins that series. From the mod's POV it's just "make another one of this
// at time T" — the series machinery is transparent.
export function DuplicateSlotForm({
  slug,
  slot,
  timeZone,
  onCancel,
  onDuplicated,
}: {
  slug: string;
  slot: Slot;
  timeZone: string;
  onCancel: () => void;
  onDuplicated: () => Promise<void>;
}) {
  const duration = slot.ends_at - slot.starts_at;
  // Default: place the new offering immediately after the source. Mods will
  // usually want a different time (e.g. afternoon vs morning) but "right
  // after" is a sensible starting point because it's always valid (doesn't
  // pre-fill a stale yesterday-time when re-using).
  const [startsAt, setStartsAt] = useState<number>(slot.ends_at);
  const [endsAt, setEndsAt] = useState<number>(slot.ends_at + duration);
  const [title, setTitle] = useState(slot.title ?? "");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (endsAt <= startsAt) {
      toast.error("End time must be after start time.");
      return;
    }
    setBusy(true);
    try {
      await api.agenda.duplicateSlot({
        slug,
        id: slot.id,
        new_starts_at: startsAt,
        new_ends_at: endsAt,
        title: title.trim() === "" ? null : title.trim(),
      });
      toast.success("Offering created.");
      await onDuplicated();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="condensed">
      <Tip>
        <strong>Repeat this slot at another time.</strong> This makes a second
        copy of the slot that runs at a time you choose. The copies are linked
        as a series (each copy is called an &ldquo;offering&rdquo;).
      </Tip>
      <Tip>
        Linked offerings share their room pool, eligible sessions, and
        assignment rules — edit any of those once on the series form and
        every offering updates. Time, title, and description stay per-copy.
      </Tip>
      <Tip>
        <strong>Each offering counts on its own.</strong> A session placed in
        two offerings counts as two placements against its cap. If you want the
        same session to run in every offering, lift its cap on the Sessions tab
        first.
      </Tip>
      <Form onSubmit={submit}>
        <TextInput
          label="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={slot.title ?? "Same as source"}
        />
        <DateTime
          label="Starts at"
          value={startsAt}
          onChange={setStartsAt}
          timeZone={timeZone}
          max={endsAt}
        />
        <DateTime
          label="Ends at"
          value={endsAt}
          onChange={setEndsAt}
          timeZone={timeZone}
          min={startsAt}
        />
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary" disabled={busy}>
            Create offering
          </Button>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}
