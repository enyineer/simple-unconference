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
import { slotRoomBlockReason } from "../../roomConstraints";
import { speakerWarningMessage } from "./speakerWarning";

export function StaticBody({
  slug,
  slot,
  rooms,
  subs,
  tracks,
  participantCount,
  isMod,
  onChange,
}: {
  slug: string;
  slot: Slot;
  rooms: Room[];
  subs: Submission[];
  tracks: Track[];
  /** Conference identity count (mod-only; `null` for participants). Drives the
   *  mandatory overfill badge — everyone attends a required talk, so its room
   *  must seat the whole conference. */
  participantCount: number | null;
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
      {/* Re-fit is an occasional mod action: reassign this slot's rooms among
          its scheduled talks by star count. Only meaningful once at least one
          talk is scheduled (a single talk can still hop to a bigger free room). */}
      {isMod && assignedRooms.length >= 1 && (
        <RefitRoomsButton slug={slug} slot={slot} onChange={onChange} />
      )}
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
          participantCount={participantCount}
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

// Re-fit rooms: reassign this planned slot's rooms among its scheduled talks
// by star count (biggest room → most-starred), honoring reserved rooms and
// room requirements. All-or-nothing on the server; conflicts come back as a
// structured payload we surface as a readable toast (mirrors the
// AutoRoomPicker / PlacementAuthor conflict pattern). A compact right-aligned
// row so it reads as an occasional action, not the slot's primary control.
function RefitRoomsButton({
  slug,
  slot,
  onChange,
}: {
  slug: string;
  slot: Slot;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function refit() {
    setBusy(true);
    try {
      const r = await api.agenda.refitRooms({ slug, slot_id: slot.id });
      if (r.kind === "conflict") {
        toast.error(refitConflictMessage(r));
        return;
      }
      if (r.moves.length === 0) {
        if (r.unresolved.length > 0) {
          toast.info(refitUnresolvedNote(r.unresolved));
        } else {
          toast.info("All talks already fit their rooms.");
        }
        return;
      }
      const parts = r.moves.map((m) => `${m.title} → ${m.to_room}`);
      const shown = parts.slice(0, 3).join(" · ");
      const extra =
        parts.length > 3 ? ` and ${parts.length - 3} more` : "";
      const tail =
        r.unresolved.length > 0 ? ` ${refitUnresolvedNote(r.unresolved)}` : "";
      toast.success(`Re-fit rooms: ${shown}${extra}.${tail}`);
      await onChange();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ display: "flex", justifyContent: "flex-end" }}
      title="Fixes talks whose room no longer fits - overfilled, conflicting with an overlapping slot, or violating their requirements - by moving them to the best-fitting free room. Talks that already fit stay put. People who starred a moved talk are notified."
    >
      <Button size="small" onClick={refit} disabled={busy}>
        {busy ? "Re-fitting…" : "Re-fit rooms by interest"}
      </Button>
    </div>
  );
}

// Toast copy for talks a refit couldn't improve (they stay in their current
// room). Names the shared reason when all unresolved talks failed the same way.
function refitUnresolvedNote(
  unresolved: { reason: "overfilled" | "double_booked" | "requirements" }[],
): string {
  const n = unresolved.length;
  const noun = n === 1 ? "talk" : "talks";
  const reasons = new Set(unresolved.map((u) => u.reason));
  let why = "";
  if (reasons.size === 1) {
    const [reason] = [...reasons];
    why =
      reason === "overfilled"
        ? " (no bigger room free)"
        : reason === "double_booked"
          ? " (clashing with an overlapping slot)"
          : " (no free room with the required features)";
  }
  return `${n} ${noun} could not be improved${why}.`;
}

// Conflict copy for `agenda.refitRooms`. Mirrors AutoRoomPicker's messaging but
// names the offending talk from the payload's `submission` field (a refit
// weighs many talks at once, so the server tells us which one couldn't be
// placed).
function refitConflictMessage(
  r: Extract<Awaited<ReturnType<typeof api.agenda.refitRooms>>, { kind: "conflict" }>,
): string {
  const subject = r.submission ? `"${r.submission.title}"` : "A talk";
  switch (r.reason) {
    case "pin_room_taken":
      return `${subject} is reserved for ${r.pinned_room?.name ?? "a room"}, but that room is already used by another talk in this slot.`;
    case "pin_room_out_of_scope":
      return `${subject} is reserved for ${r.pinned_room?.name ?? "a room"}, which isn't in this slot's room set.`;
    case "unsatisfiable_requirements": {
      const tags = r.required_tags.join(", ") || "specific room tags";
      return r.candidate_room_names.length > 0
        ? `${subject} needs ${tags}; the only matching rooms (${r.candidate_room_names.join(", ")}) are already in use.`
        : `${subject} needs ${tags}, but no room in this slot has them.`;
    }
    case "room_expert_dedicated":
      return r.pool_name
        ? `${subject} is reserved for ${r.room.name}, which is dedicated to experts (${r.pool_name}).`
        : `${subject} is reserved for ${r.room.name}, which is dedicated to experts.`;
    case "room_unavailable":
      return `${subject} is reserved for ${r.room.name}, which isn't available during this slot's time.`;
  }
}

// Conflict copy for `agenda.setTrack`. A room may be refused because a
// time-overlapping slot holds it, because it's reserved for experts, or because
// it's outside its availability windows for this slot.
function setTrackConflictMessage(
  r: Extract<Awaited<ReturnType<typeof api.agenda.setTrack>>, { kind: "conflict" }>,
): string {
  switch (r.reason) {
    case "room_overlap_taken": {
      const who = r.holder.title ? `"${r.holder.title}"` : "a mixer";
      return `${r.holder.room_name} is already used at ${r.holder.slot_label} by ${who} in an overlapping slot.`;
    }
    case "room_expert_dedicated":
      return r.pool_name
        ? `${r.room.name} is reserved for experts (${r.pool_name}) and can't host a session.`
        : `${r.room.name} is reserved for experts and can't host a session.`;
    case "room_unavailable":
      return `${r.room.name} isn't available during this slot's time.`;
  }
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
        participantCount={null}
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
      {/* "start with a room" (not "reserve") — nothing is persisted until a
          session is scheduled, and "reserved" already means a session's
          pinned room elsewhere in the app. */}
      <span style={{ opacity: 0.7 }}>or start with a room:</span>
      {unassignedRooms.map((r) => {
        // A room reserved for experts, or outside its availability at this
        // slot's time, can't host a track — the server would refuse setTrack.
        // Keep it visible but disabled with a hint so the mod sees why.
        const reason = slotRoomBlockReason(r, slot);
        return (
          <span key={r.id} title={reason ?? undefined} style={{ display: "inline-flex" }}>
            <Button
              size="small"
              disabled={reason !== null}
              onClick={() => setPickedRoomId(r.id)}
            >
              {r.name}
            </Button>
          </span>
        );
      })}
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
          case "room_expert_dedicated":
            toast.error(
              r.pool_name
                ? `${r.room.name} is reserved for experts (${r.pool_name}) and can't host a session.`
                : `${r.room.name} is reserved for experts and can't host a session.`,
            );
            break;
          case "room_unavailable":
            toast.error(`${r.room.name} isn't available during this slot's time.`);
            break;
        }
        return;
      }
      toast.success(`Scheduled in ${r.room_name}.`);
      if (r.speaker_warning) toast.warning(speakerWarningMessage(r.speaker_warning));
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
  participantCount,
  isMod,
  onChange,
}: {
  slug: string;
  slot: Slot;
  room: Room;
  track: Track | null;
  subs: Submission[];
  /** Conference identity count (mod-only; `null` for participants). A required
   *  track is attended by everyone, so its room must seat all of them. */
  participantCount: number | null;
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
      const r = await api.agenda.setTrack({
        slug,
        slot_id: slot.id,
        room_id: room.id,
        submission_id: Number(submissionId),
        speakers: speakers.trim() || null,
        requirements,
        mandatory,
      });
      if (r.kind === "conflict") {
        toast.error(setTrackConflictMessage(r));
        return;
      }
      setEditing(false);
      await onChange();
      toast.success(track ? `Updated the session in ${room.name}.` : `Scheduled a session in ${room.name}.`);
      if (r.speaker_warning) toast.warning(speakerWarningMessage(r.speaker_warning));
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
            // Wrap the badge/action cluster so a mandatory track's extra
            // overfill badge can't overflow the row on narrow (mobile) widths.
            flexWrap: "wrap",
            justifyContent: "flex-end",
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
          {track && display && track.mandatory && participantCount !== null && participantCount > room.capacity && (
            <span
              title={`Every participant attends required talks - this room seats ${room.capacity} of ${participantCount} people. Move it to a bigger room or re-fit rooms.`}
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
              ⚠ Required talk overfills room ({participantCount}/{room.capacity})
            </span>
          )}
          {track && display && !track.mandatory && track.star_count > room.capacity && (
            <span
              title={`${track.star_count} people have starred this session — the room holds ${room.capacity}. Move it to a bigger room, re-fit rooms, or duplicate the slot.`}
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
