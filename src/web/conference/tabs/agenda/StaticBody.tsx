import { useState } from "react";
import {
  Button,
  Card,
  Stack,
  Text,
  TextInput,
} from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Room, Slot, Submission, Track } from "../../types";
import { TagInput } from "../../../design-system/core/tag-input";
import { lowercaseTrim } from "../../../design-system/core/normalize";
import { SearchableSelect } from "../../ui/SearchableSelect";
import { useRequirementsConfirm } from "../../ui/RequirementsConfirm";

export function StaticBody({
  slug,
  slot,
  rooms,
  subs,
  tracks,
  isMod,
  onChange,
}: {
  slug: string;
  slot: Slot;
  rooms: Room[];
  subs: Submission[];
  tracks: Track[];
  isMod: boolean;
  onChange: () => Promise<void>;
}) {
  const trackByRoomId = new Map(tracks.map((t) => [t.room_id, t]));
  const assignedRooms = rooms.filter((r) => trackByRoomId.has(r.id));
  const unassignedRooms = rooms.filter((r) => !trackByRoomId.has(r.id));

  if (rooms.length === 0) {
    return <Text muted>Add a room before scheduling sessions.</Text>;
  }

  return (
    <Stack gap="condensed">
      {assignedRooms.length === 0 && !isMod && (
        <Text muted>No sessions scheduled yet.</Text>
      )}
      {assignedRooms.map((r) => (
        <TrackEditor
          key={r.id}
          slug={slug}
          slot={slot}
          room={r}
          track={trackByRoomId.get(r.id) ?? null}
          subs={subs}
          isMod={isMod}
          onChange={onChange}
        />
      ))}
      {isMod && unassignedRooms.length > 0 && (
        <AddTrackPicker
          slug={slug}
          slot={slot}
          unassignedRooms={unassignedRooms}
          subs={subs}
          onChange={onChange}
        />
      )}
    </Stack>
  );
}

export function AddTrackPicker({
  slug,
  slot,
  unassignedRooms,
  subs,
  onChange,
}: {
  slug: string;
  slot: Slot;
  unassignedRooms: Room[];
  subs: Submission[];
  onChange: () => Promise<void>;
}) {
  const [pickedRoomId, setPickedRoomId] = useState<number | null>(null);
  // Auto-room mode: the mod picks a session first and the server picks the
  // room (honoring the session's pin / room_requirements). Toggled via the
  // primary "Auto-assign room" button below.
  const [autoMode, setAutoMode] = useState(false);
  const room = pickedRoomId
    ? unassignedRooms.find((r) => r.id === pickedRoomId) ?? null
    : null;

  if (room) {
    return (
      <TrackEditor
        key={room.id}
        slug={slug}
        slot={slot}
        room={room}
        track={null}
        subs={subs}
        isMod={true}
        onChange={async () => {
          setPickedRoomId(null);
          await onChange();
        }}
      />
    );
  }

  if (autoMode) {
    return (
      <AutoRoomPicker
        slug={slug}
        slot={slot}
        subs={subs}
        onCancel={() => setAutoMode(false)}
        onDone={async () => {
          setAutoMode(false);
          await onChange();
        }}
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        padding: 12,
        borderRadius: 8,
        border:
          "1px dashed var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
        background: "transparent",
        color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
        fontSize: 13,
      }}
    >
      <span style={{ fontWeight: 500 }}>+ Schedule a session</span>
      <Button size="small" variant="primary" onClick={() => setAutoMode(true)}>
        Auto-assign room
      </Button>
      <span style={{ opacity: 0.7 }}>or reserve a room:</span>
      {unassignedRooms.map((r) => (
        <Button key={r.id} size="small" onClick={() => setPickedRoomId(r.id)}>
          {r.name}
        </Button>
      ))}
    </div>
  );
}

// "Auto-assign room" flow: mod selects a Submission; the server chooses the
// room based on Submission.preAssignedRoomId / room_requirements / largest
// free room. Conflicts come back as a structured payload — we surface them as
// readable toasts so the mod knows what to fix (or which room to clear).
export function AutoRoomPicker({
  slug,
  slot,
  subs,
  onCancel,
  onDone,
}: {
  slug: string;
  slot: Slot;
  subs: Submission[];
  onCancel: () => void;
  onDone: () => Promise<void>;
}) {
  const [submissionId, setSubmissionId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function save() {
    if (!submissionId) {
      toast.error("Select a session to schedule.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.agenda.scheduleSubmission({
        slug,
        slot_id: slot.id,
        submission_id: Number(submissionId),
      });
      if (r.kind === "conflict") {
        const sub = subs.find((s) => s.id === Number(submissionId));
        const title = sub?.title ?? "this session";
        switch (r.reason) {
          case "pin_room_taken":
            toast.error(
              `${title} is reserved for ${r.pinned_room?.name ?? "a room"}, but that room is already in use here.`,
            );
            break;
          case "pin_room_out_of_scope":
            toast.error(
              `${title} is reserved for ${r.pinned_room?.name ?? "a room"}, which is not in this slot's room set.`,
            );
            break;
          case "unsatisfiable_requirements": {
            const tags = r.required_tags.join(", ");
            if (r.candidate_room_names.length > 0) {
              toast.error(
                `${title} needs ${tags || "specific room tags"}; the only matching rooms (${r.candidate_room_names.join(", ")}) are already in use.`,
              );
            } else {
              toast.error(
                `${title} needs ${tags || "specific room tags"}, but no room in this slot has them.`,
              );
            }
            break;
          }
          case "no_free_room":
            toast.error(
              `Every room in this slot is already taken. Remove a session from a room first to free one up.`,
            );
            break;
        }
        return;
      }
      toast.success(`Scheduled in ${r.room_name}.`);
      await onDone();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Auto-assign room">
      <Stack gap="condensed">
        <Text muted>
          Pick the session; the app places it in the best available room
          (the session&apos;s reserved room if it has one, otherwise the
          largest free room whose tags match the session&apos;s requirements).
        </Text>
        <SearchableSelect
          label="Session"
          value={submissionId}
          onChange={setSubmissionId}
          options={[
            { value: "", label: "— select a session —" },
            ...subs.map((sub) => ({
              value: String(sub.id),
              label: sub.title,
              hint: sub.submitter_name ?? undefined,
            })),
          ]}
          placeholder="Search sessions…"
        />
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="primary" onClick={save} disabled={busy || !submissionId}>
            {busy ? "Scheduling…" : "Schedule"}
          </Button>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </Stack>
    </Card>
  );
}

export function TrackEditor({
  slug,
  slot,
  room,
  track,
  subs,
  isMod,
  onChange,
}: {
  slug: string;
  slot: Slot;
  room: Room;
  track: Track | null;
  subs: Submission[];
  isMod: boolean;
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [submissionId, setSubmissionId] = useState<string>(
    track?.submission_id ? String(track.submission_id) : "",
  );
  const [speakers, setSpeakers] = useState(track?.speakers ?? "");
  const submission = track
    ? subs.find((s) => s.id === track.submission_id)
    : undefined;
  // Pre-fill from the track's own requirements; if absent, fall back to the
  // linked submission's so mods don't have to re-type. Once saved, the track's
  // value is authoritative regardless of what's on the submission.
  const initialReqs = track?.requirements?.length
    ? track.requirements
    : submission?.requirements ?? [];
  const [requirements, setRequirements] = useState<string[]>(initialReqs);
  const [mandatory, setMandatory] = useState(track?.mandatory ?? false);
  const [busy, setBusy] = useState(false);
  // Path C: track display title always comes from the linked submission.
  const display = submission?.title ?? track?.title;
  const requirementsConfirm = useRequirementsConfirm();
  const toast = useToast();

  async function toggleStar() {
    if (!track) return;
    // Path C: star/unstar the underlying Submission. The track's
    // `starred_by_me` is derived from that submission's star on the server.
    if (track.starred_by_me) {
      try {
        await api.submissions.unstar({ slug, id: track.submission_id });
        await onChange();
      } catch (e) {
        toast.error(errorCode(e));
      }
      return;
    }
    requirementsConfirm.request({
      title: display ?? "Session",
      requirements: track.requirements,
      onConfirm: async () => {
        try {
          await api.submissions.star({ slug, id: track.submission_id });
          await onChange();
        } catch (e) {
          toast.error(errorCode(e));
        }
      },
    });
  }

  async function save() {
    // Path C: every track must reference a Submission. The form refuses
    // to save without one — the picker validates this before submit.
    if (!submissionId) {
      toast.error("Select a session to schedule in this room.");
      return;
    }
    setBusy(true);
    try {
      await api.agenda.setTrack({
        slug,
        slot_id: slot.id,
        room_id: room.id,
        submission_id: Number(submissionId),
        speakers: speakers.trim() || null,
        requirements,
        mandatory,
      });
      setEditing(false);
      await onChange();
      toast.success(track ? `Updated the session in ${room.name}.` : `Scheduled a session in ${room.name}.`);
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirm(`Remove this session from ${room.name}?`)) return;
    try {
      await api.agenda.clearTrack({ slug, slot_id: slot.id, room_id: room.id });
      toast.success(`Removed the session from ${room.name}.`);
    } catch (e) {
      toast.error(errorCode(e));
      return;
    }
    setSubmissionId("");
    setSpeakers("");
    setRequirements([]);
    await onChange();
  }

  if (editing && isMod) {
    return (
      <>
        {requirementsConfirm.modal}
        <Card title={`Edit this talk — ${room.name}`}>
          <Stack gap="condensed">
            <SearchableSelect
              label="Session"
              value={submissionId}
              onChange={setSubmissionId}
              options={[
                { value: "", label: "— select a session —" },
                ...subs.map((sub) => ({
                  value: String(sub.id),
                  label: sub.title,
                  hint: sub.submitter_name ?? undefined,
                })),
              ]}
              placeholder="Search sessions…"
            />
            <TextInput
              label="Co-speakers (optional)"
              value={speakers}
              onChange={(e) => setSpeakers(e.target.value)}
              placeholder="Additional speaker names beyond the submitter"
            />
            <TagInput
              label="Requirements"
              placeholder="e.g. laptop, github account"
              value={requirements}
              onChange={setRequirements}
              normalize={lowercaseTrim}
            />
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                fontSize: 13,
                color: "var(--fgColor-default, var(--uncon-fg, inherit))",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={mandatory}
                onChange={(e) => setMandatory(e.target.checked)}
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>Required for all participants</span>
                <span
                  style={{
                    color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                    fontSize: 12,
                    lineHeight: "16px",
                  }}
                >
                  Adds to every schedule, can&apos;t be unstarred. Use for keynotes, opening/closing.
                </span>
              </span>
            </label>
            <Stack direction="row" gap="condensed">
              <Button variant="primary" onClick={save} disabled={busy}>
                Save
              </Button>
              <Button onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
              {track && (
                <Button variant="danger" onClick={clear} disabled={busy}>
                  Remove from room
                </Button>
              )}
            </Stack>
          </Stack>
        </Card>
      </>
    );
  }

  // Read-only row: grid keeps the actions pinned to the top-right regardless
  // of how long the title is, so the layout stays consistent across tracks.
  return (
    <>
      {requirementsConfirm.modal}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: "8px 12px",
          padding: 12,
          borderRadius: 8,
          border:
            "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
          background: "var(--bgColor-default, var(--uncon-bg, transparent))",
        }}
      >
        <div style={{ gridColumn: 1, gridRow: 1 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 8px",
              borderRadius: 999,
              background:
                "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
              color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background:
                  "var(--borderColor-neutral-emphasis, var(--uncon-fg-muted, #6e7781))",
              }}
            />
            {room.name}
            <span style={{ opacity: 0.6, fontWeight: 400 }}>
              · {room.capacity}
            </span>
          </span>
        </div>

        <div
          style={{
            gridColumn: 2,
            gridRow: 1,
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          {track && display && track.mandatory && (
            <span
              title="This session is required — every participant is auto-attending."
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 8px",
                borderRadius: 999,
                background:
                  "var(--bgColor-attention-muted, rgba(212,167,44,0.18))",
                color: "var(--fgColor-attention, #9a6700)",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}
            >
              ★ Required
            </span>
          )}
          {track && display && !track.mandatory && track.star_count > room.capacity && (
            <span
              title={`${track.star_count} people have starred this session — the room holds ${room.capacity}. Consider moving to a larger room or duplicating the slot.`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 8px",
                borderRadius: 999,
                background:
                  "var(--bgColor-danger-muted, rgba(207,34,46,0.12))",
                color: "var(--fgColor-danger, #cf222e)",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}
            >
              ⚠ Room may be full
            </span>
          )}
          {track && display && !track.mandatory && (
            <Button
              size="small"
              variant={track.starred_by_me ? "primary" : "default"}
              onClick={toggleStar}
            >
              {track.starred_by_me
                ? `★ ${track.star_count}`
                : `☆ ${track.star_count}`}
            </Button>
          )}
          {isMod && (
            <Button
              size="small"
              onClick={() => {
                setSubmissionId(
                  track?.submission_id ? String(track.submission_id) : "",
                );
                setSpeakers(track?.speakers ?? "");
                const reqs = track?.requirements?.length
                  ? track.requirements
                  : submission?.requirements ?? [];
                setRequirements(reqs);
                setMandatory(track?.mandatory ?? false);
                setEditing(true);
              }}
            >
              {track ? "Edit this talk" : "Schedule a session"}
            </Button>
          )}
        </div>

        <div
          style={{
            gridColumn: "1 / -1",
            gridRow: 2,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {display ? (
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                lineHeight: "22px",
                color: "var(--fgColor-default, var(--uncon-fg, inherit))",
                wordBreak: "break-word",
              }}
            >
              {display}
            </div>
          ) : (
            <div
              style={{
                fontSize: 14,
                fontStyle: "italic",
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              }}
            >
              No session scheduled
            </div>
          )}
          {track?.speakers && (
            <div
              style={{
                fontSize: 13,
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              }}
            >
              {track.speakers}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
