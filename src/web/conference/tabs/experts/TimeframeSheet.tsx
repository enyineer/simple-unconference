import { useState } from "react";
import { Button, DateTime, Form, Sheet, Stack, TextInput } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import { Tip } from "../../ui/Tip";
import { humanError } from "./helpers";
import type { Expert } from "./types";

export function TimeframeSheet({
  open, slug, expert, timeZone, onClose, onDone,
}: {
  open: boolean;
  slug: string;
  expert: Expert;
  timeZone: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [startsAt, setStartsAt] = useState<number>(() => {
    return Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  });
  const [endsAt, setEndsAt] = useState<number>(() => {
    return Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 60 * 60_000;
  });
  const [duration, setDuration] = useState<string>("15");
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const mins = Number(duration);
    if (!Number.isFinite(mins) || mins < 5) { toast.error("Slot length must be at least 5 minutes."); return; }
    if (endsAt <= startsAt) { toast.error("End must be after start."); return; }
    if ((endsAt - startsAt) < mins * 60_000) { toast.error("Timeframe is shorter than one slot."); return; }
    try {
      await api.experts.createTimeframe({
        slug,
        expert_id: expert.id,
        starts_at: startsAt,
        ends_at: endsAt,
        slot_duration_minutes: mins,
      });
      onDone();
    } catch (err) { toast.error(humanError(errorCode(err))); }
  }

  const display = expert.name || expert.email || `Expert #${expert.id}`;
  return (
    <Sheet open={open} onClose={onClose} title={`Timeframe for ${display}`}>
      <Tip>
        Slots are generated automatically — a 60-minute window with 15-minute
        slots produces 4 bookable slots.
      </Tip>
      <Form onSubmit={submit}>
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
        <TextInput
          label="Slot length (minutes)"
          type="number"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary">Add timeframe</Button>
          <Button onClick={onClose}>Cancel</Button>
        </Stack>
      </Form>
    </Sheet>
  );
}
