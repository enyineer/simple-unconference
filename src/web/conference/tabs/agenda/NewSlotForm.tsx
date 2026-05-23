import { useState } from "react";
import {
  Button,
  DateTime,
  Form,
  Select,
  Stack,
  TextInput,
} from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import { Tip } from "../../ui/Tip";
import { SLOT_KIND_TIP, type SlotKind } from "./types";

export function NewSlotForm({
  slug,
  timeZone,
  mixerAvoidRepeatsDefault,
  onCancel,
  onCreated,
}: {
  slug: string;
  timeZone: string;
  mixerAvoidRepeatsDefault: boolean;
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [type, setType] = useState<SlotKind>("unconference");
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState<number>(
    () => Date.now() + 60 * 60 * 1000,
  );
  const [endsAt, setEndsAt] = useState<number>(
    () => Date.now() + 2 * 60 * 60 * 1000,
  );
  // Mixer-only. "inherit" sends null; the other two send a boolean override.
  const [mixerMode, setMixerMode] = useState<"inherit" | "exclusive" | "fresh">(
    "inherit",
  );
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.agenda.createSlot({
        slug,
        type,
        title: title || null,
        starts_at: startsAt,
        ends_at: endsAt,
        mixer_avoid_repeats:
          type === "mixer"
            ? mixerMode === "inherit"
              ? null
              : mixerMode === "exclusive"
            : null,
      });
      await onCreated();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="condensed">
      <Form onSubmit={submit}>
        <Select
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as SlotKind)}
          options={[
            {
              value: "normal",
              label: "Planned (keynote, talks — admin picks tracks)",
            },
            {
              value: "unconference",
              label: "Unconference (auto-assigned by stars)",
            },
            { value: "mixer", label: "Mixer (everyone split across rooms)" },
          ]}
        />
        {/* Type-specific guidance — explains how the chosen slot kind will
            behave once it's created, without burying it three lines deep. */}
        <Tip>{SLOT_KIND_TIP[type]}</Tip>
        {type === "mixer" && (
          <Select
            label="Mixing mode"
            value={mixerMode}
            onChange={(e) => setMixerMode(e.target.value as typeof mixerMode)}
            options={[
              {
                value: "inherit",
                label: `Use conference default (${
                  mixerAvoidRepeatsDefault ? "exclusive mix" : "fresh shuffle"
                })`,
              },
              { value: "exclusive", label: "Exclusive mix (avoid re-pairing)" },
              { value: "fresh", label: "Fresh shuffle (ignore prior mixers)" },
            ]}
          />
        )}
        {type !== "unconference" && (
          <TextInput
            label={
              type === "mixer"
                ? "Title (e.g. Meet each other, Lunch tables)"
                : "Title (e.g. Keynote, Morning Talks)"
            }
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
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
            Add slot
          </Button>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}
