import { useState } from "react";
import {
  Button,
  Card,
  Form,
  Stack,
  TextInput,
  Textarea,
} from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Slot } from "../../types";
import { Tip } from "../../ui/Tip";
import { SlotTimeFields } from "./SlotTimeFields";
import { slotTimesValid } from "./slotTimes";

export function SlotEditForm({
  slug,
  slot,
  timeZone,
  onSaved,
}: {
  slug: string;
  slot: Slot;
  timeZone: string;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(slot.title ?? "");
  const [description, setDescription] = useState(slot.description ?? "");
  const [startsAt, setStartsAt] = useState<number>(slot.starts_at);
  const [endsAt, setEndsAt] = useState<number>(slot.ends_at);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!slotTimesValid(startsAt, endsAt)) return;
    setBusy(true);
    try {
      await api.agenda.updateSlot({
        slug,
        id: slot.id,
        title: title.trim() === "" ? null : title.trim(),
        description: description.trim() === "" ? null : description.trim(),
        starts_at: startsAt,
        ends_at: endsAt,
      });
      await onSaved();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Edit slot">
      <Tip>
        Drag a slot in the calendar for quick moves; this form is for precise
        edits.
      </Tip>
      <Form onSubmit={save}>
        <TextInput
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={
            slot.type === "unconference"
              ? "e.g. Morning unconference"
              : slot.type === "mixer"
              ? "e.g. Meet each other"
              : "e.g. Opening Keynote"
          }
        />
        <Textarea
          label="Description (optional)"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <SlotTimeFields
          startsAt={startsAt}
          endsAt={endsAt}
          onStartsAtChange={setStartsAt}
          onEndsAtChange={setEndsAt}
          timeZone={timeZone}
        />
        <Stack direction="row" gap="condensed">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !slotTimesValid(startsAt, endsAt)}
          >
            Save changes
          </Button>
        </Stack>
      </Form>
    </Card>
  );
}
