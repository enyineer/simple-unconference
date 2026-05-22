// The Agenda tab — Calendar, slot-block sheet contents, slot creation/edit,
// per-room track editor, unconference configuration. These subcomponents are
// tightly coupled (they all read/write the same agenda payload), so we keep
// them in a single module for cohesion and avoid premature fragmentation.

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  DateTime,
  Form,
  Heading,
  Select,
  Sheet,
  Spinner,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "../../design-system";
import { useToast } from "../../design-system/hooks";
import { api, errorCode } from "../../api";
import type {
  AgendaData,
  Room,
  Slot,
  Submission,
  Track,
} from "../types";
import { fmtTimeShort, parseLabels } from "../helpers";
import { AssignmentRulesTrigger } from "../ui/AssignmentRulesModal";
import { SessionPicker } from "../ui/SessionPicker";
import { SearchableSelect } from "../ui/SearchableSelect";
import { Tip } from "../ui/Tip";
import { useRequirementsConfirm } from "../ui/RequirementsConfirm";
import { Calendar, CalendarLegend } from "./Calendar";

type SlotKind = "normal" | "unconference" | "mixer";

const SLOT_KIND_LABEL: Record<SlotKind, string> = {
  normal: "Planned",
  unconference: "Unconference",
  mixer: "Mixer",
};

// Shown in the "Add slot" sheet so moderators see exactly what the selected
// slot kind will do before they create it.
const SLOT_KIND_TIP: Record<SlotKind, string> = {
  normal:
    "Planned slots run a fixed agenda — you pick which talk (or custom title) runs in each room. " +
    "Attendees can star a talk to add it to their personal schedule.",
  unconference:
    "Unconference slots are auto-assigned. The algorithm places the most-starred published submissions " +
    "in your rooms and balances attendees across them based on their stars. Re-run anytime as people star or unstar.",
  mixer:
    "Mixer slots split every conference member evenly across the rooms you select — no submissions involved. " +
    'By default mixers are "exclusive": the algorithm tries not to put two participants in the same room across mixers, ' +
    'so repeated "meet each other" slots actually meet new people. Switch a mixer to "fresh shuffle" if you want it ' +
    "to ignore prior mixers. The default is owner-configurable in Settings.",
};


function slotSheetTitle(s: Slot): string {
  if (s.type === "unconference") return "Unconference slot";
  if (s.type === "mixer") return s.title ?? "Mixer slot";
  return s.title ?? "Planned slot";
}

export function AgendaTab({
  slug,
  isMod,
  timeZone,
  mixerAvoidRepeatsDefault,
}: {
  slug: string;
  isMod: boolean;
  timeZone: string;
  mixerAvoidRepeatsDefault: boolean;
}) {
  const [data, setData] = useState<AgendaData | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [adding, setAdding] = useState(false);
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(null);

  const fetchAgenda = useCallback(() => Promise.all([
    api.agenda.get({ slug }),
    api.rooms.list({ slug }),
    api.submissions.list({ slug, status: "published" }),
  ]), [slug]);
  async function refresh() {
    const [a, r, s] = await fetchAgenda();
    setData(a);
    setRooms(r);
    setSubs(s);
  }
  useEffect(() => {
    let cancelled = false;
    fetchAgenda()
      .then(([a, r, s]) => {
        if (cancelled) return;
        setData(a); setRooms(r); setSubs(s);
      })
      .catch(() => {
        if (cancelled) return;
        setData({ slots: [], tracks: [], placements: [], mixer_placements: [] });
      });
    return () => { cancelled = true; };
  }, [fetchAgenda]);

  async function moveSlot(id: number, starts_at: number, ends_at: number) {
    try {
      await api.agenda.updateSlot({ slug, id, starts_at, ends_at });
      await refresh();
    } catch (e) {
      alert(errorCode(e));
      await refresh(); // restore correct render if the update failed
    }
  }

  const requirementsConfirm = useRequirementsConfirm();

  // The handlers run a confirmation step when there are requirements to
  // acknowledge; otherwise they fire straight through to the API. Unstarring
  // never prompts — that's a removal action with no risk.
  async function toggleStaticStar(track: {
    id: number;
    slot_id: number;
    starred_by_me: boolean;
  }) {
    if (track.starred_by_me) {
      try {
        await api.agenda.unstarTrack({
          slug,
          slot_id: track.slot_id,
          track_id: track.id,
        });
        await refresh();
      } catch (e) {
        alert(errorCode(e));
      }
      return;
    }
    // Look up the full track + linked submission for the confirmation step.
    // The Calendar passes a thin shape; we keep the source of truth here.
    const full = data?.tracks.find((t) => t.id === track.id);
    const requirements = full?.requirements ?? [];
    const linkedSub =
      full?.submission_id != null
        ? subs.find((s) => s.id === full.submission_id) ?? null
        : null;
    const displayTitle = linkedSub?.title ?? full?.title ?? "Session";
    requirementsConfirm.request({
      title: displayTitle,
      requirements,
      onConfirm: async () => {
        try {
          await api.agenda.starTrack({
            slug,
            slot_id: track.slot_id,
            track_id: track.id,
          });
          await refresh();
        } catch (e) {
          alert(errorCode(e));
        }
      },
    });
  }

  async function toggleSubmissionStar(sub: {
    id: number;
    starred_by_me: boolean;
  }) {
    if (sub.starred_by_me) {
      try {
        await api.submissions.unstar({ slug, id: sub.id });
        await refresh();
      } catch (e) {
        alert(errorCode(e));
      }
      return;
    }
    const full = subs.find((s) => s.id === sub.id);
    requirementsConfirm.request({
      title: full?.title ?? "Session",
      requirements: full?.requirements ?? [],
      onConfirm: async () => {
        try {
          await api.submissions.star({ slug, id: sub.id });
          await refresh();
        } catch (e) {
          alert(errorCode(e));
        }
      },
    });
  }

  if (!data) return <Spinner label="Loading…" />;

  const selectedSlot = selectedSlotId
    ? data.slots.find((s) => s.id === selectedSlotId) ?? null
    : null;

  return (
    <Stack gap="spacious">
      {requirementsConfirm.modal}

      <Stack direction="row" justify="between" align="center">
        <Stack gap="condensed">
          <Heading level={2}>Agenda</Heading>
          <CalendarLegend />
        </Stack>
        <Stack direction="row" gap="condensed" align="center">
          <AssignmentRulesTrigger isMod={isMod} />
          {isMod && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              + Add slot
            </Button>
          )}
        </Stack>
      </Stack>

      <Sheet open={adding} onClose={() => setAdding(false)} title="Add slot">
        <NewSlotForm
          slug={slug}
          timeZone={timeZone}
          mixerAvoidRepeatsDefault={mixerAvoidRepeatsDefault}
          onCancel={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      </Sheet>


      {data.slots.length === 0 ? (
        <Card>
          <Text muted>
            {isMod
              ? `No slots yet. Click "Add slot" to start the agenda.`
              : "The agenda hasn't been published yet."}
          </Text>
        </Card>
      ) : (
        <>
          {isMod && (
            <Tip>
              Drag a slot to move it, or pull its top/bottom edge to resize.
              Click a slot to open its details.
            </Tip>
          )}
          <Calendar
            slots={data.slots}
            tracks={data.tracks}
            placements={data.placements}
            mixerPlacements={data.mixer_placements ?? []}
            rooms={rooms}
            subs={subs}
            isMod={isMod}
            timeZone={timeZone}
            selectedSlotId={selectedSlotId}
            onSelectSlot={(id) => setSelectedSlotId(id)}
            onMoveSlot={moveSlot}
            onToggleStaticStar={toggleStaticStar}
            onToggleSubmissionStar={toggleSubmissionStar}
          />
        </>
      )}

      <Sheet
        open={!!selectedSlot}
        onClose={() => setSelectedSlotId(null)}
        title={selectedSlot ? slotSheetTitle(selectedSlot) : ""}
      >
        {selectedSlot && (
          <SlotBlock
            key={selectedSlot.id}
            slug={slug}
            slot={selectedSlot}
            rooms={rooms}
            subs={subs}
            tracks={data.tracks.filter((t) => t.slot_id === selectedSlot.id)}
            placements={data.placements.filter(
              (p) => p.slot_id === selectedSlot.id,
            )}
            isMod={isMod}
            timeZone={timeZone}
            inSheet
            onChange={refresh}
          />
        )}
      </Sheet>
    </Stack>
  );
}

// ---- New-slot inline form ----

function NewSlotForm({
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

// ---- The slot detail block rendered inside the sheet ----

interface SlotBlockProps {
  slug: string;
  slot: Slot;
  rooms: Room[];
  subs: Submission[];
  tracks: Track[];
  placements: {
    slot_id: number;
    submission_id: number;
    room_id: number;
    attendee_count: number;
  }[];
  isMod: boolean;
  timeZone: string;
  onChange: () => Promise<void>;
  onClose?: () => void;
  /** When rendered inside a Sheet, skip the outer Card chrome (the sheet
   * already provides the header + container). */
  inSheet?: boolean;
}

// Pre-assignment conflict surfaced by `agenda.assign`. Three shapes:
//   - duplicate_room: two pinned sessions compete for the same room.
//   - out_of_scope:   a pinned room isn't in the slot's effective scope.
//   - unsatisfiable_requirements: a top-N session has required room tags
//     that can't be satisfied — either no room in scope carries the tags,
//     or every matching room was already claimed by a higher-priority
//     session in this slot.
type PreConflict =
  | {
      kind: "duplicate_room" | "out_of_scope";
      room_id: number;
      room_name: string;
      submissions: { id: number; title: string }[];
    }
  | {
      kind: "unsatisfiable_requirements";
      submission: { id: number; title: string };
      required_tags: string[];
      candidate_room_names: string[];
    };

function SlotBlock({
  slug,
  slot,
  rooms,
  subs,
  tracks,
  placements,
  isMod,
  timeZone,
  onChange,
  onClose,
  inSheet,
}: SlotBlockProps) {
  const [configuring, setConfiguring] = useState(false);
  const [editing, setEditing] = useState(false);
  const [conflicts, setConflicts] = useState<PreConflict[] | null>(null);
  const toast = useToast();
  const isUnconf = slot.type === "unconference";
  const isMixer = slot.type === "mixer";
  const isAssignable = isUnconf || isMixer;

  // Effective rooms in this slot's scope. Both unconference and mixer use
  // `unconf_use_all_rooms` + `unconf_room_ids` for room scoping (the field
  // is shared across the two slot types).
  const effectiveRooms = slot.unconf_use_all_rooms
    ? rooms
    : rooms.filter((r) => slot.unconf_room_ids.includes(r.id));
  // Effective sessions eligible for an unconference run: published and
  // not finished, within the slot's submission scope.
  const effectiveSubs = isUnconf
    ? subs
        .filter((s) => s.status === "published" && !s.is_finished)
        .filter(
          (s) =>
            slot.unconf_use_all_submissions ||
            slot.unconf_submission_ids.includes(s.id),
        )
    : [];
  // Reason the Run button is disabled (or null if it's runnable). Surfaced
  // as a tooltip on the disabled button so mods aren't left guessing.
  const runDisabledReason: string | null = (() => {
    if (!isAssignable) return null;
    if (effectiveRooms.length === 0) {
      return isMixer
        ? "No rooms in scope. Add rooms in the Rooms tab or include some in the configuration."
        : "No rooms in scope. Add rooms in the Rooms tab or include some via Configure.";
    }
    if (isUnconf && effectiveSubs.length === 0) {
      return "No published, non-finished sessions in scope. Publish a session in the Sessions tab.";
    }
    return null;
  })();

  async function remove() {
    if (!confirm("Delete this slot?")) return;
    await api.agenda.deleteSlot({ slug, id: slot.id });
    await onChange();
  }

  async function runAssignment(excludeSubmissionIds?: number[]) {
    try {
      const r = await api.agenda.assign({
        slug,
        slot_id: slot.id,
        ...(excludeSubmissionIds && excludeSubmissionIds.length > 0
          ? { exclude_submission_ids: excludeSubmissionIds }
          : {}),
      });
      if (r.kind === "conflict") {
        // Hard block on running the assignment — mod has to resolve the
        // conflict in the resolver panel that just mounted below.
        setConflicts(r.conflicts);
        toast.error(
          "Pre-assignment conflict — assignment was not run. Resolve the conflict to continue.",
        );
        return;
      }
      // Success — clear any stale conflict panel from a previous attempt.
      setConflicts(null);
      const noun = isMixer ? "attendee" : "participant";
      const unmatched = isMixer
        ? "they couldn't fit in a room (capacity)."
        : "they need to pick another session.";
      // Build the overlap-exclusions footer when present. Mods see this so
      // they understand why some rooms/sessions/users were filtered out —
      // it's expected behavior, not a problem.
      const ex = r.overlap_exclusions;
      const exParts: string[] = [];
      if (ex.rooms.length > 0) {
        exParts.push(
          `${ex.rooms.length} room(s) (${ex.rooms
            .map((r) => r.name)
            .join(", ")})`,
        );
      }
      if (ex.submissions.length > 0) {
        exParts.push(`${ex.submissions.length} session(s)`);
      }
      if (ex.user_ids.length > 0) {
        exParts.push(`${ex.user_ids.length} ${noun}(s)`);
      }
      const overlapNote =
        exParts.length === 0
          ? ""
          : ` Excluded due to overlapping slots: ${exParts.join(", ")}.`;
      if (r.unplaced_users.length === 0) {
        toast.success("Assignment complete — everyone placed." + overlapNote);
      } else {
        toast.warning(
          `${r.unplaced_users.length} ${noun}(s) could not be placed — ${unmatched}${overlapNote}`,
        );
      }
      await onChange();
    } catch (e) {
      toast.error(errorCode(e));
    }
  }

  const headerLabel = isUnconf
    ? "Unconference"
    : isMixer
    ? slot.title ?? "Mixer"
    : slot.title ?? "Planned slot";
  const badgeText = SLOT_KIND_LABEL[slot.type as SlotKind].toLowerCase();
  const badgeVariant: "primary" | "attention" | "default" = isUnconf
    ? "primary"
    : isMixer
    ? "attention"
    : "default";

  const body = (
    <Stack gap="condensed">
      {/* Meta row — header label (off-sheet only) + time/timezone on the
          left, the assignment-rules `?` trigger on the right. The trigger
          lives here rather than in the action row because it's contextual
          help, not an action. */}
      <Stack direction="row" justify="between" align="center" wrap>
        <Stack gap="condensed">
          {!inSheet && (
            <Stack direction="row" gap="condensed" align="center">
              <strong>{headerLabel}</strong>
              <Badge variant={badgeVariant}>{badgeText}</Badge>
            </Stack>
          )}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontSize: 14,
            }}
          >
            <span
              style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}
            >
              {fmtTimeShort(slot.starts_at, timeZone)}
            </span>
            <span
              style={{
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              }}
            >
              →
            </span>
            <span
              style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}
            >
              {fmtTimeShort(slot.ends_at, timeZone)}
            </span>
            <span
              style={{
                padding: "1px 8px",
                borderRadius: 999,
                background:
                  "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                fontSize: 11,
                marginLeft: 4,
              }}
            >
              {timeZone}
            </span>
            {!inSheet && <Badge variant={badgeVariant}>{badgeText}</Badge>}
          </div>
        </Stack>
        {isAssignable && <AssignmentRulesTrigger isMod={isMod} />}
      </Stack>

      {/* Action row — primary actions (Edit / Configure / Run) on the
          left, destructive / chrome (Delete / Close) right-aligned via a
          flex spacer so the row reads as two intentional clusters. */}
      {(isMod || onClose) && (
        <Stack direction="row" gap="condensed" align="center" wrap>
          {isMod && (
            <Button onClick={() => setEditing((v) => !v)} size="small">
              {editing ? "Close edit" : "Edit"}
            </Button>
          )}
          {isMod && isAssignable && (
            <>
              {/* Mixer slots configure rooms inline in MixerBody; no separate
               * Configure panel needed. Unconference slots still have one for
               * eligible submissions + avoid-repeats. */}
              {!isMixer && (
                <Button onClick={() => setConfiguring((v) => !v)} size="small">
                  {configuring ? "Close configure" : "Configure"}
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() => runAssignment()}
                size="small"
                disabled={runDisabledReason !== null}
              >
                {isMixer ? "Assign rooms" : "Run assignment"}
              </Button>
              {runDisabledReason && (
                <Text muted>
                  <span title={runDisabledReason}>{runDisabledReason}</span>
                </Text>
              )}
            </>
          )}
          {/* Spacer pushes Delete / Close to the far right. */}
          <div style={{ flex: 1 }} />
          {isMod && (
            <Button variant="danger" onClick={remove} size="small">
              Delete
            </Button>
          )}
          {onClose && (
            <Button variant="invisible" onClick={onClose} size="small">
              Close
            </Button>
          )}
        </Stack>
      )}

      {isMod && editing && (
        <SlotEditForm
          slug={slug}
          slot={slot}
          timeZone={timeZone}
          onSaved={async () => {
            setEditing(false);
            await onChange();
          }}
        />
      )}

      {isAssignable && configuring && (
        <SlotConfigure
          slug={slug}
          slot={slot}
          rooms={rooms}
          subs={subs}
          onSaved={async () => {
            setConfiguring(false);
            await onChange();
          }}
        />
      )}

      {isMod && isUnconf && conflicts && (
        <ResolveConflictsPanel
          slug={slug}
          slot={slot}
          rooms={rooms}
          subs={subs}
          conflicts={conflicts}
          onCancel={() => setConflicts(null)}
          onRerun={async (excludeSubmissionIds) => {
            await onChange();
            await runAssignment(excludeSubmissionIds);
          }}
        />
      )}

      {isUnconf && (
        <UnconferenceBody
          slug={slug}
          slot={slot}
          subs={subs}
          rooms={rooms}
          placements={placements}
          onChange={onChange}
        />
      )}
      {isMixer && (
        <MixerBody
          slug={slug}
          slot={slot}
          rooms={rooms}
          isMod={isMod}
          onChange={onChange}
        />
      )}
      {!isUnconf && !isMixer && (
        <StaticBody
          slug={slug}
          slot={slot}
          rooms={rooms}
          subs={subs}
          tracks={tracks}
          isMod={isMod}
          onChange={onChange}
        />
      )}
    </Stack>
  );

  return inSheet ? body : <Card>{body}</Card>;
}

// ---- Planned slot body: per-room track editor (incl. add-track picker) ----

function StaticBody({
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
    return <Text muted>Add a room before assigning tracks.</Text>;
  }

  return (
    <Stack gap="condensed">
      {assignedRooms.length === 0 && !isMod && (
        <Text muted>No tracks scheduled yet.</Text>
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

function AddTrackPicker({
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
      <span style={{ fontWeight: 500 }}>+ Add track for</span>
      {unassignedRooms.map((r) => (
        <Button key={r.id} size="small" onClick={() => setPickedRoomId(r.id)}>
          {r.name}
        </Button>
      ))}
    </div>
  );
}

function TrackEditor({
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
  const [title, setTitle] = useState(track?.title ?? "");
  const [speakers, setSpeakers] = useState(track?.speakers ?? "");
  const submission = track?.submission_id
    ? subs.find((s) => s.id === track.submission_id)
    : undefined;
  // Pre-fill from the track's own requirements; if absent, fall back to the
  // linked submission's so mods don't have to re-type. Once saved, the track's
  // value is authoritative regardless of what's on the submission.
  const initialReqs = track?.requirements?.length
    ? track.requirements
    : submission?.requirements ?? [];
  const [requirements, setRequirements] = useState(initialReqs.join(", "));
  const [mandatory, setMandatory] = useState(track?.mandatory ?? false);
  const [busy, setBusy] = useState(false);
  const display = submission?.title ?? track?.title;
  const requirementsConfirm = useRequirementsConfirm();

  async function toggleStar() {
    if (!track) return;
    if (track.starred_by_me) {
      try {
        await api.agenda.unstarTrack({
          slug,
          slot_id: slot.id,
          track_id: track.id,
        });
        await onChange();
      } catch (e) {
        alert(errorCode(e));
      }
      return;
    }
    requirementsConfirm.request({
      title: display ?? "Session",
      requirements: track.requirements,
      onConfirm: async () => {
        try {
          await api.agenda.starTrack({
            slug,
            slot_id: slot.id,
            track_id: track.id,
          });
          await onChange();
        } catch (e) {
          alert(errorCode(e));
        }
      },
    });
  }

  async function save() {
    setBusy(true);
    try {
      await api.agenda.setTrack({
        slug,
        slot_id: slot.id,
        room_id: room.id,
        submission_id: submissionId ? Number(submissionId) : null,
        title: title.trim() || null,
        speakers: speakers.trim() || null,
        requirements: parseLabels(requirements),
        mandatory,
      });
      setEditing(false);
      await onChange();
    } catch (e) {
      alert(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirm(`Clear track in ${room.name}?`)) return;
    await api.agenda.clearTrack({ slug, slot_id: slot.id, room_id: room.id });
    setSubmissionId("");
    setTitle("");
    setSpeakers("");
    setRequirements("");
    await onChange();
  }

  if (editing && isMod) {
    return (
      <>
        {requirementsConfirm.modal}
        <Card title={`Edit track — ${room.name}`}>
          <Stack gap="condensed">
            <SearchableSelect
              label="Linked submission (optional)"
              value={submissionId}
              onChange={setSubmissionId}
              options={[
                { value: "", label: "— none (use custom title) —" },
                ...subs.map((sub) => ({
                  value: String(sub.id),
                  label: sub.title,
                  hint: sub.submitter_name ?? undefined,
                })),
              ]}
              placeholder="Search sessions…"
            />
            <TextInput
              label="Custom title (when no submission)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Welcome Keynote"
            />
            <TextInput
              label="Speakers"
              value={speakers}
              onChange={(e) => setSpeakers(e.target.value)}
              placeholder="e.g. Alice, Bob"
            />
            <TextInput
              label="Requirements (comma-separated)"
              placeholder="e.g. laptop, github account"
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
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
                  Clear
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
                setTitle(track?.title ?? "");
                setSpeakers(track?.speakers ?? "");
                const reqs = track?.requirements?.length
                  ? track.requirements
                  : submission?.requirements ?? [];
                setRequirements(reqs.join(", "));
                setMandatory(track?.mandatory ?? false);
                setEditing(true);
              }}
            >
              {track ? "Edit" : "Set track"}
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
              No track scheduled
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

// ---- Unconference slot body: placements + optional configure picker ----

function UnconferenceBody({
  slug,
  slot,
  subs,
  rooms,
  placements,
  onChange,
}: {
  slug: string;
  slot: Slot;
  subs: Submission[];
  rooms: Room[];
  placements: {
    slot_id: number;
    submission_id: number;
    room_id: number;
    attendee_count: number;
  }[];
  onChange: () => Promise<void>;
}) {
  const [myAssignment, setMyAssignment] = useState<{
    submission_id: number | null;
    manual: boolean;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Pull just this user's row for the slot so we can show "Your session" and
  // open the picker with the right "current pick" highlighted.
  useEffect(() => {
    api.agenda
      .myAssignments({ slug })
      .then((m) => {
        const a = m.assignments.find(
          (x) => x.slot_id === slot.id && x.source === "unconference",
        );
        setMyAssignment(
          a
            ? { submission_id: a.submission_id, manual: a.manual ?? false }
            : null,
        );
      })
      .catch(() => setMyAssignment(null));
  }, [slug, slot.id, placements]);

  const subById = new Map(subs.map((s) => [s.id, s]));
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  const eligibleRooms = slot.unconf_use_all_rooms
    ? rooms
    : rooms.filter((r) => slot.unconf_room_ids.includes(r.id));
  const eligibleSubs = slot.unconf_use_all_submissions
    ? subs
    : subs.filter((s) => slot.unconf_submission_ids.includes(s.id));

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  const summaryPillStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 10px",
    borderRadius: 999,
    background:
      "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
    color: muted,
    fontSize: 12,
    lineHeight: "16px",
    whiteSpace: "nowrap",
  };

  // The Change-session row is participant-facing. We show it whenever the
  // slot has placements (the picker would be empty otherwise), regardless of
  // whether the user is currently placed — it doubles as "pick a session"
  // for unplaced and "switch session" for placed.
  const showSwitcher = placements.length > 0;
  const currentSub = myAssignment?.submission_id ?? null;
  const currentSubTitle = currentSub
    ? subById.get(currentSub)?.title ?? `#${currentSub}`
    : null;

  return (
    <Stack gap="condensed">
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <span style={summaryPillStyle}>
          Rooms: {eligibleRooms.length}
          {slot.unconf_use_all_rooms ? " (all)" : ""}
        </span>
        <span style={summaryPillStyle}>
          Submissions: {eligibleSubs.length}
          {slot.unconf_use_all_submissions ? " (all)" : ""}
        </span>
      </div>

      {showSwitcher && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            padding: "10px 12px",
            borderRadius: 8,
            border:
              "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
            background:
              "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.03)))",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: muted,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                fontWeight: 600,
              }}
            >
              Your session
            </span>
            <span style={{ fontSize: 14, wordBreak: "break-word" }}>
              {currentSubTitle ?? "Not assigned yet"}
              {myAssignment?.manual && (
                <span
                  style={{
                    marginLeft: 6,
                    color: "var(--fgColor-accent, #2563eb)",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  · manual pick
                </span>
              )}
            </span>
          </div>
          <Button
            size="small"
            variant={currentSub ? "default" : "primary"}
            onClick={() => setPickerOpen(true)}
          >
            {currentSub ? "Change session" : "Pick a session"}
          </Button>
        </div>
      )}

      <SessionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        slug={slug}
        slotId={slot.id}
        placements={placements}
        subs={subs}
        rooms={rooms}
        currentSubmissionId={currentSub}
        onChanged={onChange}
      />

      {placements.length === 0 ? (
        <div
          style={{
            padding: 16,
            borderRadius: 8,
            border:
              "1px dashed var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
            color: muted,
            fontSize: 13,
            textAlign: "center",
          }}
        >
          No placements yet — run assignment to fill.
        </div>
      ) : (
        <Stack gap="condensed">
          {placements.map((p) => {
            const sub = subById.get(p.submission_id);
            const room = roomById.get(p.room_id);
            return (
              <div
                key={p.submission_id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "8px 12px",
                  padding: 12,
                  borderRadius: 8,
                  border: `1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))`,
                  background:
                    "var(--bgColor-default, var(--uncon-bg, transparent))",
                }}
              >
                <span
                  style={{
                    gridColumn: 1,
                    gridRow: 1,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background:
                      "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
                    color: muted,
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                    width: "fit-content",
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
                  {room?.name ?? "?"}
                  {room && (
                    <span style={{ opacity: 0.6, fontWeight: 400 }}>
                      · {room.capacity}
                    </span>
                  )}
                </span>
                <div style={{ gridColumn: 2, gridRow: 1 }} />
                <div
                  style={{
                    gridColumn: "1 / -1",
                    gridRow: 2,
                    fontSize: 16,
                    fontWeight: 600,
                    lineHeight: "22px",
                    wordBreak: "break-word",
                  }}
                >
                  {sub?.title ?? `#${p.submission_id}`}
                </div>
                {sub?.submitter_name && (
                  <div
                    style={{
                      gridColumn: "1 / -1",
                      gridRow: 3,
                      color: muted,
                      fontSize: 13,
                    }}
                  >
                    {sub.submitter_name}
                  </div>
                )}
                {sub &&
                  (sub.pre_assigned_room_id !== null ||
                    sub.room_requirements.length > 0) && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        gridRow: 4,
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        marginTop: 4,
                      }}
                    >
                      {sub.pre_assigned_room_id !== null && (
                        <Badge variant="attention">pinned to this room</Badge>
                      )}
                      {sub.room_requirements.length > 0 && (
                        <Badge variant="default">
                          needs: {sub.room_requirements.join(", ")}
                        </Badge>
                      )}
                    </div>
                  )}
              </div>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

// ---- Slot edit form (title, description, start, end) ----

function SlotEditForm({
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
    if (endsAt <= startsAt) {
      toast.error("End time must be after start time.");
      return;
    }
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
            Save changes
          </Button>
        </Stack>
      </Form>
    </Card>
  );
}

function SlotConfigure({
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
    } catch (e) {
      alert(errorCode(e));
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

// ---- Pre-assignment conflict resolver --------------------------------------
//
// When two pinned sessions want the same room, or a pinned room isn't in
// the slot's scope, the server returns a structured conflict instead of
// running. The panel lets the moderator resolve each grouped conflict via
// one of three actions per session:
//   - skip: drop this session from the pool just for the next run (no
//     persistent change — the next-most-starred session takes the room).
//   - move: rewrite the session's pinned room to a different room.
//   - clear: unpin the session entirely (algorithm auto-places it).
// Mutating actions (move / clear) batch into `submissions.update` calls
// queued until the moderator clicks "Apply and re-run", so partial edits
// don't accumulate on Cancel. Skips are one-shot and live only in this
// component's state.

type ResolveAction =
  | { kind: "keep" }
  | { kind: "skip" }
  | { kind: "move"; roomId: number }
  | { kind: "clear" };

function ResolveConflictsPanel({
  slug,
  slot: _slot,
  rooms,
  subs,
  conflicts,
  onCancel,
  onRerun,
}: {
  slug: string;
  slot: Slot;
  rooms: Room[];
  subs: Submission[];
  conflicts: PreConflict[];
  onCancel: () => void;
  onRerun: (excludeSubmissionIds: number[]) => Promise<void>;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  // Every conflicting submission shows up in `actions` so its row has a
  // controlled state. Defaults are picked so a single click "Apply" usually
  // resolves the conflict without further input: for tag conflicts the most
  // non-destructive option (skip) is preselected; for pin conflicts the
  // mod still has to pick which session yields, so we leave them on "keep"
  // and clearly flag the unresolved state.
  const allSubIds = Array.from(
    new Set(
      conflicts.flatMap((c) =>
        c.kind === "unsatisfiable_requirements"
          ? [c.submission.id]
          : c.submissions.map((s) => s.id),
      ),
    ),
  );
  const defaultActionFor = (subId: number): ResolveAction => {
    const inTagConflict = conflicts.some(
      (c) =>
        c.kind === "unsatisfiable_requirements" && c.submission.id === subId,
    );
    return inTagConflict ? { kind: "skip" } : { kind: "keep" };
  };
  const [actions, setActions] = useState<Record<number, ResolveAction>>(() => {
    const init: Record<number, ResolveAction> = {};
    for (const id of allSubIds) init[id] = defaultActionFor(id);
    return init;
  });
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  function setAction(subId: number, action: ResolveAction) {
    setActions((prev) => ({ ...prev, [subId]: action }));
  }

  // Build the per-submission room picker options. Offer every conference
  // room *except* the session's current pin (no-op) and rooms already
  // pinned by a non-conflicting submission (would just create a fresh
  // conflict).
  const pinnedRoomIdsByOthers = new Set<number>();
  for (const s of subs) {
    if (s.pre_assigned_room_id === null) continue;
    if (allSubIds.includes(s.id)) continue;
    pinnedRoomIdsByOthers.add(s.pre_assigned_room_id);
  }
  function roomOptionsFor(currentPin: number | null) {
    return rooms
      .filter((r) => r.id !== currentPin && !pinnedRoomIdsByOthers.has(r.id))
      .map((r) => ({
        value: String(r.id),
        label: r.name,
        hint: `Capacity ${r.capacity}`,
      }));
  }

  // Counts at the bottom — and we use `unresolvedKeep` to disable Apply
  // when the mod hasn't actually resolved a pin conflict (still on "keep"
  // for both sides). Without this, clicking Apply just re-runs and shows
  // the same conflict.
  const summary = (() => {
    let skip = 0,
      move = 0,
      clear = 0,
      keep = 0;
    for (const id of allSubIds) {
      const a = actions[id];
      if (!a) continue;
      if (a.kind === "skip") skip++;
      else if (a.kind === "move") move++;
      else if (a.kind === "clear") clear++;
      else keep++;
    }
    return { skip, move, clear, keep, total: allSubIds.length };
  })();
  const isResolved = (() => {
    // Each conflict must have at least one of its sessions changed from
    // "keep" (or be a tag-only conflict resolved via skip/move).
    for (const c of conflicts) {
      if (c.kind === "unsatisfiable_requirements") {
        const a = actions[c.submission.id];
        if (!a || a.kind === "keep") return false;
      } else {
        const all = c.submissions;
        const anyAction = all.some((cs) => {
          const a = actions[cs.id];
          return a && a.kind !== "keep";
        });
        if (!anyAction) return false;
      }
    }
    return true;
  })();

  async function apply() {
    setBusy(true);
    try {
      // Persist move / clear actions first so the next run sees the new pins.
      for (const id of allSubIds) {
        const a = actions[id];
        if (!a) continue;
        if (a.kind === "move") {
          await api.submissions.update({
            slug,
            id,
            pre_assigned_room_id: a.roomId,
          });
        } else if (a.kind === "clear") {
          await api.submissions.update({
            slug,
            id,
            pre_assigned_room_id: null,
          });
        }
      }
      const excludes = allSubIds.filter((id) => actions[id]?.kind === "skip");
      await onRerun(excludes);
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  // Radio option styled as a labelled card row. Cleaner and far less
  // visually noisy than four pill buttons + a separate description line.
  function ActionOption({
    name,
    current,
    value,
    title,
    hint,
    onSelect,
    danger,
  }: {
    name: string;
    current: string;
    value: string;
    title: string;
    hint: string;
    onSelect: () => void;
    danger?: boolean;
  }) {
    const checked = current === value;
    return (
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px solid ${
            checked
              ? "var(--borderColor-accent-emphasis, #2563eb)"
              : "var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))"
          }`,
          background: checked
            ? "var(--bgColor-accent-muted, rgba(37, 99, 235, 0.08))"
            : "transparent",
          cursor: "pointer",
          transition: "border-color .12s ease, background .12s ease",
        }}
      >
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onSelect}
          style={{ marginTop: 3, flexShrink: 0 }}
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: danger && !checked ? muted : "inherit",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 12,
              color: muted,
              marginTop: 2,
              lineHeight: 1.45,
            }}
          >
            {hint}
          </div>
        </div>
      </label>
    );
  }

  // Per-session action editor. Each session card lists the available
  // resolutions as a radio group, with a contextual room picker when
  // "Move pin" / "Pin to a room" is chosen.
  function SessionActionRow({
    cs,
    hasPin,
  }: {
    cs: { id: number; title: string };
    hasPin: boolean;
  }) {
    const sub = subs.find((s) => s.id === cs.id);
    const currentPin = sub?.pre_assigned_room_id ?? null;
    const currentPinName =
      currentPin === null
        ? null
        : rooms.find((r) => r.id === currentPin)?.name ?? null;
    const a = actions[cs.id] ?? { kind: "keep" };
    const options = roomOptionsFor(currentPin);
    const radioName = `resolve-${cs.id}`;
    return (
      <div
        style={{
          padding: 14,
          borderRadius: 10,
          border:
            "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
          background: "var(--bgColor-default, transparent)",
        }}
      >
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.3 }}>
            {cs.title}
          </div>
          {currentPinName && (
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
              Currently pinned to <strong>{currentPinName}</strong>
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <ActionOption
            name={radioName}
            current={a.kind}
            value="skip"
            title="Skip just this run"
            hint="The session drops out for this slot only. The next-most-starred session takes its place. No permanent change."
            onSelect={() => setAction(cs.id, { kind: "skip" })}
          />
          <ActionOption
            name={radioName}
            current={a.kind}
            value="move"
            title={
              hasPin ? "Move the pin to another room" : "Pin to a specific room"
            }
            hint={
              hasPin
                ? "Permanently re-pins this session to a room you pick below."
                : "Permanently pins this session to a room you pick below — overrides required features."
            }
            onSelect={() =>
              setAction(cs.id, {
                kind: "move",
                roomId:
                  options.length > 0
                    ? Number.parseInt(options[0]!.value, 10)
                    : currentPin ?? 0,
              })
            }
          />
          {hasPin && (
            <ActionOption
              name={radioName}
              current={a.kind}
              value="clear"
              title="Clear the pin"
              hint="Removes the pin permanently. The algorithm auto-places the session in any free room."
              onSelect={() => setAction(cs.id, { kind: "clear" })}
            />
          )}
          <ActionOption
            name={radioName}
            current={a.kind}
            value="keep"
            danger
            title={
              hasPin
                ? "Keep the pin (don't resolve)"
                : "Leave unchanged (don't resolve)"
            }
            hint="The conflict will still be there next time you run. Use this if you'll resolve via another session in the same group."
            onSelect={() => setAction(cs.id, { kind: "keep" })}
          />
          {a.kind === "move" && (
            <div style={{ marginTop: 4, paddingLeft: 30 }}>
              <SearchableSelect
                label={hasPin ? "New room" : "Pin to room"}
                value={String(a.roomId)}
                onChange={(value) =>
                  setAction(cs.id, {
                    kind: "move",
                    roomId: Number.parseInt(value, 10),
                  })
                }
                options={options}
                placeholder="Search rooms…"
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Headline that adapts to the conflict mix so the mod sees a single
  // sentence describing the situation, instead of having to compose it
  // from the card list below.
  const headline = (() => {
    const dup = conflicts.filter((c) => c.kind === "duplicate_room").length;
    const oos = conflicts.filter((c) => c.kind === "out_of_scope").length;
    const tag = conflicts.filter(
      (c) => c.kind === "unsatisfiable_requirements",
    ).length;
    const parts: string[] = [];
    if (dup > 0)
      parts.push(`${dup} room ${dup === 1 ? "conflict" : "conflicts"}`);
    if (oos > 0) parts.push(`${oos} out-of-slot ${oos === 1 ? "pin" : "pins"}`);
    if (tag > 0)
      parts.push(
        `${tag} unmet-requirements ${tag === 1 ? "session" : "sessions"}`,
      );
    return parts.join(", ");
  })();

  return (
    <div
      style={{
        padding: 18,
        borderRadius: 12,
        border: "1px solid var(--borderColor-danger-emphasis, #cf222e)",
        background: "var(--bgColor-danger-muted, rgba(207, 34, 46, 0.06))",
      }}
    >
      {/* Header — single sentence summarising what's wrong + how the panel works */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
          Assignment blocked: {headline}
        </div>
        <div style={{ fontSize: 13, color: muted, lineHeight: 1.45 }}>
          Pick one option per session below. <strong>Apply and re-run</strong>{" "}
          will persist the permanent changes (move / clear pin), batch the
          one-shot skips, and re-run the assignment in one click.
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {conflicts.map((c, idx) => {
          if (c.kind === "unsatisfiable_requirements") {
            const matched = c.candidate_room_names;
            return (
              <ConflictGroup
                key={`tags:${c.submission.id}:${idx}`}
                badge="Required features can't be met"
                badgeTone="danger"
                description={
                  matched.length === 0
                    ? `No room in this slot has all of the required features (${c.required_tags
                        .map((t) => `"${t}"`)
                        .join(
                          ", ",
                        )}). Skip the session, pin it to a specific room (overrides tags), or add the missing feature to a room from the Rooms tab.`
                    : `Needs ${c.required_tags
                        .map((t) => `"${t}"`)
                        .join(", ")} — matching rooms in this slot (${matched
                        .map((n) => `"${n}"`)
                        .join(
                          ", ",
                        )}) are all claimed by higher-priority sessions.`
                }
              >
                <SessionActionRow cs={c.submission} hasPin={false} />
              </ConflictGroup>
            );
          }
          const isOutOfScope = c.kind === "out_of_scope";
          return (
            <ConflictGroup
              key={`${c.kind}:${c.room_id}`}
              badge={
                isOutOfScope
                  ? "Pinned room isn't in this slot"
                  : "Two pins on the same room"
              }
              badgeTone={isOutOfScope ? "attention" : "primary"}
              description={
                isOutOfScope
                  ? `"${c.room_name}" isn't part of this slot's room set. Move the pin to a room that is in scope, clear it, or add "${c.room_name}" to the slot via Configure.`
                  : `"${c.room_name}" is the only place to put ${c.submissions.length} sessions. Pick one to move/clear/skip — the rest can stay.`
              }
            >
              {c.submissions.map((cs) => (
                <SessionActionRow key={cs.id} cs={cs} hasPin={true} />
              ))}
            </ConflictGroup>
          );
        })}
      </div>

      {/* Footer — primary action, secondary cancel, and a tiny summary */}
      <div
        style={{
          marginTop: 18,
          paddingTop: 16,
          borderTop:
            "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Button
          variant="primary"
          onClick={apply}
          disabled={busy || !isResolved}
        >
          {busy ? "Applying…" : "Apply and re-run"}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: muted }}>
          {!isResolved
            ? "Pick a non-default option in every group to enable Apply."
            : `${summary.move} move${summary.move === 1 ? "" : "s"} · ${
                summary.clear
              } clear${summary.clear === 1 ? "" : "s"} · ${summary.skip} skip${
                summary.skip === 1 ? "" : "s"
              } · ${summary.keep} unchanged`}
        </div>
      </div>
    </div>
  );
}

// A bordered card for a single conflict group. Header has a tone-colored
// "kicker" pill instead of a generic Badge so the conflict type reads as
// a one-line headline rather than a tag-plus-room blob.
function ConflictGroup({
  badge,
  badgeTone,
  description,
  children,
}: {
  badge: string;
  badgeTone: "danger" | "attention" | "primary";
  description: string;
  children: React.ReactNode;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const tone =
    badgeTone === "danger"
      ? {
          fg: "var(--fgColor-danger, #cf222e)",
          bg: "var(--bgColor-danger-muted, rgba(207, 34, 46, 0.12))",
        }
      : badgeTone === "attention"
      ? {
          fg: "var(--fgColor-attention, #9a6700)",
          bg: "var(--bgColor-attention-muted, rgba(255, 200, 0, 0.18))",
        }
      : {
          fg: "var(--fgColor-accent, #2563eb)",
          bg: "var(--bgColor-accent-muted, rgba(37, 99, 235, 0.12))",
        };
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        border:
          "1px solid var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
        background: "var(--bgColor-default, transparent)",
      }}
    >
      <div
        style={{
          display: "inline-block",
          padding: "3px 10px",
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.3,
          textTransform: "uppercase",
          color: tone.fg,
          background: tone.bg,
          marginBottom: 8,
        }}
      >
        {badge}
      </div>
      <div
        style={{
          fontSize: 13,
          color: muted,
          marginBottom: 12,
          lineHeight: 1.5,
        }}
      >
        {description}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
      </div>
    </div>
  );
}

// ---- Mixer slot body: room picker (mods) + room summary (everyone). ----
//
// Mods see every conference room as a toggleable card and can flip rooms
// in/out of the mixer right from the body — no separate "Configure" step
// for what is functionally the only mixer-specific setting.

function MixerBody({
  slug,
  slot,
  rooms,
  isMod,
  onChange,
}: {
  slug: string;
  slot: Slot;
  rooms: Room[];
  isMod: boolean;
  onChange: () => Promise<void>;
}) {
  // `selected` derives from the slot's stored config. `unconfUseAllRooms`
  // means every room is in; otherwise only the ones in `unconf_room_ids`.
  const selected = new Set<number>(
    slot.unconf_use_all_rooms ? rooms.map((r) => r.id) : slot.unconf_room_ids,
  );
  const selectedRooms = rooms.filter((r) => selected.has(r.id));
  const totalCapacity = selectedRooms.reduce((acc, r) => acc + r.capacity, 0);
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  // Persist a new selection. If every conference room ends up selected we
  // store `unconfUseAllRooms=true` so newly-added rooms auto-participate;
  // otherwise we store the explicit list.
  async function setSelection(next: Set<number>) {
    const allPicked = rooms.length > 0 && rooms.every((r) => next.has(r.id));
    try {
      await api.agenda.updateSlot({
        slug,
        id: slot.id,
        unconf_use_all_rooms: allPicked,
        unconf_room_ids: allPicked ? [] : [...next],
      });
      await onChange();
    } catch (e) {
      alert(errorCode(e));
    }
  }

  async function toggleRoom(roomId: number) {
    const next = new Set(selected);
    if (next.has(roomId)) next.delete(roomId);
    else next.add(roomId);
    await setSelection(next);
  }
  async function selectAll() {
    await setSelection(new Set(rooms.map((r) => r.id)));
  }
  async function clearAll() {
    await setSelection(new Set());
  }

  // Avoid-repeats mode for THIS slot. Stored as `mixer_avoid_repeats`:
  //  - null    → inherit conference default (UI shows "Use conference default")
  //  - true    → exclusive mix (avoid re-pairing across other exclusive mixers)
  //  - false   → fresh shuffle (ignore prior mixers entirely)
  // The "effective" mode is what the server will actually use when assigning.
  async function setAvoidMode(next: "inherit" | "exclusive" | "fresh") {
    const value = next === "inherit" ? null : next === "exclusive";
    try {
      await api.agenda.updateSlot({
        slug,
        id: slot.id,
        mixer_avoid_repeats: value,
      });
      await onChange();
    } catch (e) {
      alert(errorCode(e));
    }
  }

  if (rooms.length === 0) {
    return <Text muted>Add a room before assigning attendees.</Text>;
  }

  // Read-only view for attendees: show the rooms that are in the mix.
  const summaryPillStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 10px",
    borderRadius: 999,
    background:
      "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
    color: muted,
    fontSize: 12,
    lineHeight: "16px",
    whiteSpace: "nowrap",
  };

  const modeBadge = slot.mixer_avoid_repeats_effective
    ? "Exclusive mix"
    : "Fresh shuffle";
  const slotModeValue =
    slot.mixer_avoid_repeats === null
      ? "inherit"
      : slot.mixer_avoid_repeats
      ? "exclusive"
      : "fresh";

  if (!isMod) {
    return (
      <Stack gap="condensed">
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span style={summaryPillStyle}>
            Rooms: {selectedRooms.length}
            {slot.unconf_use_all_rooms ? " (all)" : ""}
          </span>
          <span style={summaryPillStyle}>Total capacity: {totalCapacity}</span>
          <span style={summaryPillStyle}>{modeBadge}</span>
        </div>
        {selectedRooms.length === 0 ? (
          <Text muted>No rooms picked yet.</Text>
        ) : (
          <Stack gap="condensed">
            {selectedRooms.map((r) => (
              <MixerRoomCard key={r.id} room={r} selected />
            ))}
          </Stack>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="condensed">
      <Tip>
        Click a room to add or remove it from this mixer. Everyone will be split
        evenly across the selected rooms when you assign.
      </Tip>

      <Select
        label={`Mixing mode (effective: ${modeBadge})`}
        value={slotModeValue}
        onChange={(e) =>
          setAvoidMode(e.target.value as "inherit" | "exclusive" | "fresh")
        }
        options={[
          { value: "inherit", label: "Use conference default" },
          { value: "exclusive", label: "Exclusive mix (avoid re-pairing)" },
          { value: "fresh", label: "Fresh shuffle (ignore prior mixers)" },
        ]}
      />

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <span style={summaryPillStyle}>
          Selected: {selectedRooms.length} / {rooms.length}
          {slot.unconf_use_all_rooms ? " (all)" : ""}
        </span>
        <span style={summaryPillStyle}>Total capacity: {totalCapacity}</span>
        <Stack direction="row" gap="condensed">
          <Button
            size="small"
            onClick={selectAll}
            disabled={selectedRooms.length === rooms.length}
          >
            Select all
          </Button>
          <Button
            size="small"
            onClick={clearAll}
            disabled={selectedRooms.length === 0}
          >
            Clear
          </Button>
        </Stack>
      </div>

      <Stack gap="condensed">
        {rooms.map((r) => (
          <MixerRoomCard
            key={r.id}
            room={r}
            selected={selected.has(r.id)}
            onToggle={() => toggleRoom(r.id)}
          />
        ))}
      </Stack>
    </Stack>
  );
}

function MixerRoomCard({
  room,
  selected,
  onToggle,
}: {
  room: Room;
  selected: boolean;
  onToggle?: () => Promise<void>;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  // Border + chip color hint at selection state. Unselected cards still show
  // the room and capacity (just dimmed) so mods can see what they're skipping.
  const accentBg = selected
    ? "var(--bgColor-success-muted, rgba(26,127,55,0.12))"
    : "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))";
  const accentFg = selected ? "var(--fgColor-success, #1a7f37)" : muted;

  const content = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "4px 12px",
        padding: 12,
        borderRadius: 8,
        border: `1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))`,
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
        opacity: selected ? 1 : 0.7,
        transition: "opacity 120ms",
      }}
    >
      <span
        style={{
          gridColumn: 1,
          gridRow: 1,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 8px",
          borderRadius: 999,
          background: accentBg,
          color: accentFg,
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          width: "fit-content",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: accentFg,
          }}
        />
        {room.name}
        <span style={{ opacity: 0.6, fontWeight: 400 }}>
          · capacity {room.capacity}
        </span>
      </span>
      {onToggle && (
        <span
          style={{
            gridColumn: 2,
            gridRow: 1,
            fontSize: 11,
            color: muted,
            fontWeight: 500,
          }}
        >
          {selected ? "✓ included" : "+ add"}
        </span>
      )}
    </div>
  );

  if (!onToggle) return content;
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        all: "unset",
        display: "block",
        cursor: "pointer",
        borderRadius: 8,
      }}
      aria-pressed={selected}
      title={
        selected
          ? `Remove ${room.name} from this mixer`
          : `Add ${room.name} to this mixer`
      }
    >
      {content}
    </button>
  );
}
