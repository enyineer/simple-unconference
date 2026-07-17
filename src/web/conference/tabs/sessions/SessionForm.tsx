import { useState } from "react";
import {
  Banner,
  Button,
  Form,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "../../../design-system";
import { api, errorCode } from "../../../api";
import { quotaErrorMessage } from "../../../quotaErrors";
import { submitterLabel } from "../../helpers";
import { TagInput } from "../../../design-system/core/tag-input";
import { lowercaseTrim } from "../../../design-system/core/normalize";
import { Tip } from "../../ui/Tip";
import { SearchableSelect, type SearchableSelectOption } from "../../ui/SearchableSelect";
import type { SessionFormProps } from "./types";
import { RoomTagPicker } from "./RoomTagPicker";
import { CheckboxField } from "./CheckboxField";

// One row in the mod-only Speakers editor: either a registered conference
// identity (picked from the roster) or a free-form typed name. Kept as edit
// state; converted to the wire payload on submit.
type SpeakerRow =
  | { kind: "registered"; identityId: string }
  | { kind: "name"; name: string };

type SpeakerPayload = { identity_id: number } | { name: string };

// Seed the editor from a session's EFFECTIVE speakers (always populated —
// defaults to a single submitter-derived entry). Registered rows map back to
// their identity option; free-form rows to their text.
function seedSpeakerRows(
  existing: { speakers: { identity_id: number | null; name: string }[] } | null,
): SpeakerRow[] {
  if (!existing) return [];
  return existing.speakers.map((sp) =>
    sp.identity_id !== null
      ? { kind: "registered", identityId: String(sp.identity_id) }
      : { kind: "name", name: sp.name },
  );
}

// Convert editor rows to the wire payload, dropping empties (an unpicked
// registered row or a blank name row contributes nothing).
function speakerRowsToPayload(rows: SpeakerRow[]): SpeakerPayload[] {
  const out: SpeakerPayload[] = [];
  for (const r of rows) {
    if (r.kind === "registered") {
      const id = Number.parseInt(r.identityId, 10);
      if (Number.isFinite(id)) out.push({ identity_id: id });
    } else {
      const name = r.name.trim();
      if (name) out.push({ name });
    }
  }
  return out;
}

// Unified create/edit form for a submission. Same UI for both — at create
// time the mod-only fields default to "auto"/empty, at edit time they're
// hydrated from the existing submission. Rendered inside a Sheet, so we
// drop the outer Card chrome the previous inline version used.
export function SessionForm(props: SessionFormProps) {
  const {
    mode, slug, isMod, conferenceDefaultMaxPlacements,
    rooms, participants, availableRoomTags, onCancel, onSaved,
  } = props;
  const existing = mode === "edit" ? props.submission : null;

  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [tags, setTags] = useState<string[]>(existing?.tags ?? []);
  const [requirements, setRequirements] = useState<string[]>(
    existing?.requirements ?? [],
  );
  // Editable for participants while the session is still "submitted", and
  // for mods regardless of status. The submission becoming "published"
  // effectively freezes this set for the submitter via the existing
  // already_decided gate; we mirror that here. New submissions are always
  // editable (no status yet).
  const [roomRequirements, setRoomRequirements] = useState<string[]>(
    existing?.room_requirements ?? [],
  );
  const requirementsLocked =
    !isMod && existing !== null && existing.status !== "submitted";
  // Mod-only state. `inherit` means "use the conference default" (stored as
  // null on the row); `once` and `limited` set an explicit per-submission cap.
  const [capMode, setCapMode] = useState<"inherit" | "once" | "limited">(() => {
    if (!existing || existing.max_placements === null) return "inherit";
    if (existing.max_placements === 1) return "once";
    return "limited";
  });
  const [capValue, setCapValue] = useState<string>(
    existing && existing.max_placements !== null && existing.max_placements > 1
      ? String(existing.max_placements)
      : "2",
  );
  const [manuallyFinished, setManuallyFinished] = useState(
    existing?.manually_finished ?? false,
  );
  const [allowOverlap, setAllowOverlap] = useState(
    existing?.allow_overlapping_placements ?? false,
  );
  // Mod-only assignment fill priority. Drives whether the assignment
  // algorithm places and fills this session ahead of (high) or behind (low)
  // its star ranking. Defaults to "normal".
  const [priority, setPriority] = useState<"low" | "normal" | "high">(
    existing?.priority ?? "normal",
  );
  // Pre-assigned room. "" means "auto" (no pin); otherwise the room id as a
  // string (matches SearchableSelect's value type).
  const [preAssignedRoomId, setPreAssignedRoomId] = useState<string>(
    existing?.pre_assigned_room_id == null
      ? ""
      : String(existing.pre_assigned_room_id),
  );
  // Mod-only submitter attribution. At create time defaults to "" (server
  // falls back to the actor); at edit time hydrates from the existing
  // submission so the picker shows the current author.
  const [submitterId, setSubmitterId] = useState<string>(
    existing ? String(existing.submitter_id) : "",
  );
  // Mod-only speakers editor. Seeded from the current effective speakers; only
  // sent on submit when it actually differs from the seed (like submitter_id).
  const [speakers, setSpeakers] = useState<SpeakerRow[]>(() =>
    seedSpeakerRows(existing),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Mod-only patch — same fields apply to both create and update.
      // Computed up front so we can early-return on validation errors
      // before touching the server.
      const modFields: {
        max_placements?: number | null;
        manually_finished?: boolean;
        pre_assigned_room_id?: number | null;
        allow_overlapping_placements?: boolean;
        priority?: "low" | "normal" | "high";
        submitter_id?: number;
        speakers?: SpeakerPayload[];
      } = {};
      if (isMod) {
        let next: number | null;
        if (capMode === "inherit") next = null;
        else if (capMode === "once") next = 1;
        else {
          const parsed = Number.parseInt(capValue, 10);
          if (!Number.isFinite(parsed) || parsed < 1) {
            setError("Limit must be a positive whole number.");
            setBusy(false);
            return;
          }
          next = parsed;
        }
        modFields.max_placements = next;
        modFields.manually_finished = manuallyFinished;
        modFields.allow_overlapping_placements = allowOverlap;
        modFields.priority = priority;
        modFields.pre_assigned_room_id =
          preAssignedRoomId === ""
            ? null
            : Number.parseInt(preAssignedRoomId, 10);
        if (submitterId !== "") {
          const parsed = Number.parseInt(submitterId, 10);
          if (Number.isFinite(parsed)) {
            // Only send when it actually differs from the current author
            // on edit — there's nothing to do otherwise, and keeping the
            // payload tight avoids spurious "changed" signals.
            if (!existing || parsed !== existing.submitter_id) {
              modFields.submitter_id = parsed;
            }
          }
        }
        // Speakers: validate client-side (server also enforces these), then
        // only send when the list actually differs from the seeded effective
        // speakers — an untouched edit is a no-op.
        const nextSpeakers = speakerRowsToPayload(speakers);
        if (nextSpeakers.length > 10) {
          setError("A session can have at most 10 speakers.");
          setBusy(false);
          return;
        }
        for (const r of speakers) {
          if (r.kind === "name" && r.name.trim().length > 80) {
            setError("Speaker names must be 80 characters or fewer.");
            setBusy(false);
            return;
          }
        }
        const seededSpeakers = speakerRowsToPayload(seedSpeakerRows(existing));
        if (JSON.stringify(nextSpeakers) !== JSON.stringify(seededSpeakers)) {
          modFields.speakers = nextSpeakers;
        }
      }

      if (mode === "create") {
        await api.submissions.create({
          slug,
          title,
          description,
          tags,
          requirements,
          room_requirements: roomRequirements,
          ...modFields,
        });
      } else {
        await api.submissions.update({
          slug,
          id: existing!.id,
          title,
          description,
          tags,
          requirements,
          // Only send room_requirements when the field is editable, so
          // the server never sees a stale value from a frozen edit screen.
          ...(requirementsLocked ? {} : { room_requirements: roomRequirements }),
          ...modFields,
        });
      }
      await onSaved();
    } catch (e) {
      setError(quotaErrorMessage(e) ?? errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  function inheritLabel(): string {
    if (conferenceDefaultMaxPlacements === null)
      return "Use conference default (unlimited)";
    if (conferenceDefaultMaxPlacements === 1)
      return "Use conference default (assign once)";
    return `Use conference default (${conferenceDefaultMaxPlacements} placements)`;
  }

  // Submitter options. Always include a "default" entry so create has a
  // sensible no-op state, and include the current author at edit time even
  // if they've since left the conference.
  const submitterOptions: SearchableSelectOption[] = [
    {
      value: "",
      label: mode === "create" ? "Me (default)" : "Keep current submitter",
    },
    ...participants.map((p) => ({
      value: String(p.user_id),
      label: p.name && p.name.trim() ? p.name : p.email,
      hint: p.name && p.name.trim() ? p.email : undefined,
    })),
  ];
  if (
    existing &&
    !participants.some((p) => p.user_id === existing.submitter_id)
  ) {
    submitterOptions.push({
      value: String(existing.submitter_id),
      label: submitterLabel(existing) ?? `User #${existing.submitter_id}`,
    });
  }

  // Registered-speaker options: the same roster the Submitter picker uses,
  // augmented with any seeded speaker identity that's no longer in the roster
  // (so an existing pick never silently disappears from the control).
  const speakerIdentityOptions: SearchableSelectOption[] = participants.map(
    (p) => ({
      value: String(p.user_id),
      label: p.name && p.name.trim() ? p.name : p.email,
      hint: p.name && p.name.trim() ? p.email : undefined,
    }),
  );
  if (existing) {
    for (const sp of existing.speakers) {
      if (
        sp.identity_id !== null &&
        !participants.some((p) => p.user_id === sp.identity_id)
      ) {
        speakerIdentityOptions.push({
          value: String(sp.identity_id),
          label: sp.name || `User #${sp.identity_id}`,
        });
      }
    }
  }

  function updateSpeaker(idx: number, row: SpeakerRow) {
    setSpeakers((prev) => prev.map((r, i) => (i === idx ? row : r)));
  }
  function removeSpeaker(idx: number) {
    setSpeakers((prev) => prev.filter((_, i) => i !== idx));
  }
  function addSpeaker(row: SpeakerRow) {
    setSpeakers((prev) => [...prev, row]);
  }

  // Expert-dedicated rooms can't be pinned (the server rejects the write), so
  // drop them from the picker — but keep whichever room is currently pinned so
  // an existing pin never silently disappears from the control.
  const pinnableRooms = rooms.filter(
    (r) => !r.expert_dedicated || String(r.id) === preAssignedRoomId,
  );
  const hiddenDedicatedCount = rooms.length - pinnableRooms.length;
  const roomOptions: SearchableSelectOption[] = [
    { value: "", label: "Auto (assign to any room)" },
    ...pinnableRooms.map((r) => ({
      value: String(r.id),
      label: r.name,
      hint: `Capacity ${r.capacity}`,
    })),
  ];

  return (
    <Stack gap="condensed">
      {mode === "create" && !isMod && (
        <Tip>
          A moderator publishes your session before others can star it.
          Once published, a star means &ldquo;I want this on my schedule&rdquo; —
          it both signals interest to the unconference algorithm and adds
          any planned-slot offering of this session to the starring
          user&apos;s schedule automatically.
        </Tip>
      )}
      {error && <Banner variant="critical">{error}</Banner>}
      <Form onSubmit={save}>
        <TextInput
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Textarea
          label="Description"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TagInput
          label="Tags"
          placeholder="e.g. workshop, discussion, lightning"
          value={tags}
          onChange={setTags}
          normalize={lowercaseTrim}
        />
        <TagInput
          label="Requirements"
          placeholder="e.g. laptop, github account"
          value={requirements}
          onChange={setRequirements}
          normalize={lowercaseTrim}
        />
        <RoomTagPicker
          availableTags={availableRoomTags}
          selected={roomRequirements}
          onChange={setRoomRequirements}
          disabled={requirementsLocked}
        />
        {requirementsLocked && (
          <Text muted>
            Required room features can&apos;t be changed after publishing.
          </Text>
        )}
        {isMod && (
          <>
            {participants.length > 0 && (
              <>
                <SearchableSelect
                  label="Submitter"
                  value={submitterId}
                  onChange={setSubmitterId}
                  options={submitterOptions}
                  placeholder="Search by name or email…"
                />
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                  }}
                >
                  {mode === "create"
                    ? "Attribute this session to the actual speaker if you're submitting on their behalf."
                    : "Reassign authorship to the actual speaker if you created this session on their behalf."}
                </div>
              </>
            )}
            <div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  marginBottom: 4,
                  color: "var(--fgColor-default, var(--uncon-fg, inherit))",
                }}
              >
                Speakers
              </div>
              <Stack gap="condensed">
                {speakers.map((row, idx) => (
                  <Stack
                    key={idx}
                    direction="row"
                    gap="condensed"
                    align="end"
                    wrap
                  >
                    <div style={{ flex: 1, minWidth: 160 }}>
                      {row.kind === "registered" ? (
                        <SearchableSelect
                          value={row.identityId}
                          onChange={(v) =>
                            updateSpeaker(idx, { kind: "registered", identityId: v })
                          }
                          options={speakerIdentityOptions}
                          placeholder="Search by name or email…"
                        />
                      ) : (
                        <TextInput
                          value={row.name}
                          placeholder="Speaker name"
                          onChange={(e) =>
                            updateSpeaker(idx, { kind: "name", name: e.target.value })
                          }
                        />
                      )}
                    </div>
                    <Button
                      type="button"
                      size="small"
                      onClick={() => removeSpeaker(idx)}
                    >
                      Remove
                    </Button>
                  </Stack>
                ))}
                <Stack direction="row" gap="condensed" wrap>
                  {participants.length > 0 && (
                    <Button
                      type="button"
                      size="small"
                      onClick={() =>
                        addSpeaker({ kind: "registered", identityId: "" })
                      }
                    >
                      + Add registered speaker
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="small"
                    onClick={() => addSpeaker({ kind: "name", name: "" })}
                  >
                    + Add speaker by name
                  </Button>
                </Stack>
              </Stack>
              <div
                style={{
                  fontSize: 12,
                  marginTop: 4,
                  color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                }}
              >
                Defaults to the submitter. Add speakers who aren&apos;t
                registered by name; the schedule keeps a speaker out of two
                rooms at once.
              </div>
            </div>
            <Select
              label="How many times can this session be assigned?"
              value={capMode}
              onChange={(e) =>
                setCapMode(e.target.value as "inherit" | "once" | "limited")
              }
              options={[
                { value: "inherit", label: inheritLabel() },
                { value: "once", label: "Assign once" },
                { value: "limited", label: "Limit to N placements" },
              ]}
            />
            {capMode === "limited" && (
              <TextInput
                label="Max placements"
                type="number"
                value={capValue}
                onChange={(e) => setCapValue(e.target.value)}
              />
            )}
            <Select
              label="Assignment priority"
              value={priority}
              onChange={(e) =>
                setPriority(e.target.value as "low" | "normal" | "high")
              }
              options={[
                { value: "normal", label: "Normal" },
                { value: "high", label: "High - place and fill first" },
                { value: "low", label: "Low - place and fill last" },
              ]}
            />
            <div
              style={{
                fontSize: 12,
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              }}
            >
              High-priority sessions get a room and are filled with attendees
              ahead of star count; low-priority ones are placed and filled last.
            </div>
            <CheckboxField
              checked={manuallyFinished}
              onChange={setManuallyFinished}
              label="Mark as finished"
              description="Hides from participants and excludes from assignment, regardless of count."
            />
            <CheckboxField
              checked={allowOverlap}
              onChange={setAllowOverlap}
              label="Allow placement in overlapping slots"
              description="Let this session run (or its submitter host) in slots whose times overlap. Use for recurring workshops."
            />
            {existing && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                }}
              >
                Currently placed {existing.placement_count}{" "}
                {existing.placement_count === 1 ? "time" : "times"}.
              </div>
            )}
            <SearchableSelect
              label="Pre-assign to room"
              value={preAssignedRoomId}
              onChange={setPreAssignedRoomId}
              options={roomOptions}
              placeholder="Search rooms…"
            />
            <div
              style={{
                fontSize: 12,
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              }}
            >
              Pre-assigned sessions always go to their pinned room in any
              unconference slot they land in. The slot&apos;s assignment will be
              blocked if two pre-assigned sessions compete for the same room.
              {hiddenDedicatedCount > 0 && (
                <>
                  {" "}
                  Rooms reserved for expert bookings can&apos;t be pre-assigned
                  and aren&apos;t listed.
                </>
              )}
            </div>
          </>
        )}
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary" disabled={busy}>
            {mode === "create" ? "Submit" : "Save"}
          </Button>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}
