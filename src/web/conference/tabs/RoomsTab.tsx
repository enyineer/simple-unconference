import { useState } from "react";
import {
  Button, DateTime, Form, Heading, Sheet, Spinner, Stack, TextInput, Textarea,
} from "../../design-system";
import { useToast } from "../../design-system/hooks";
import { api, errorCode } from "../../api";
import { quotaErrorMessage } from "../../quotaErrors";
import type { Room } from "../types";
import {
  availabilityStrandsMessage,
  formatWindows,
  type AvailabilityWindow,
} from "../roomConstraints";
import { TagInput } from "../../design-system/core/tag-input";
import { lowercaseTrim } from "../../design-system/core/normalize";
import { EmptyState } from "../ui/EmptyState";
import { Pager } from "../ui/Pager";
import { Pill } from "../ui/Pill";
import { Tip } from "../ui/Tip";
import { usePaginatedList } from "../usePaginatedList";

export function RoomsTab({
  slug, isMod, timeZone,
}: {
  slug: string;
  isMod: boolean;
  timeZone: string;
}) {
  const rooms = usePaginatedList<Room>(
    (input) => api.rooms.list({ slug, ...input }),
    { pageSize: 25 },
  );
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("20");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [availability, setAvailability] = useState<AvailabilityWindow[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const toast = useToast();

  const availabilityValid = availability.every((w) => w.ends_at > w.starts_at);

  async function addRoom(e: React.FormEvent) {
    e.preventDefault();
    if (!availabilityValid) return;
    try {
      const created = await api.rooms.create({
        slug, name,
        capacity: Number(capacity),
        description: description.trim() || null,
        tags,
        availability,
      });
      setName(""); setCapacity("20"); setDescription(""); setTags([]);
      setAvailability([]);
      setAdding(false);
      rooms.refresh();
      toast.success(`Room "${created.name}" added.`);
    } catch (e) { toast.error(quotaErrorMessage(e) ?? errorCode(e)); }
  }

  async function remove(room: Room) {
    if (!confirm(`Delete room "${room.name}"?`)) return;
    try {
      await api.rooms.delete({ slug, id: room.id });
      rooms.refresh();
      toast.success(`Deleted "${room.name}".`);
    } catch (e) {
      toast.error(errorCode(e));
    }
  }

  const editingRoom = editingId
    ? rooms.items.find((r) => r.id === editingId) ?? null
    : null;

  const showEmpty =
    !rooms.loading && rooms.items.length === 0 && rooms.q.trim() === "";
  const showNoMatches =
    !rooms.loading && rooms.items.length === 0 && rooms.q.trim() !== "";

  return (
    <Stack gap="spacious">
      <Stack direction="row" justify="between" align="center" wrap>
        <Heading level={2}>Rooms</Heading>
        {isMod && (
          <Button variant="primary" onClick={() => setAdding(true)}>+ Add room</Button>
        )}
      </Stack>

      <Sheet open={adding} onClose={() => setAdding(false)} title="Add room">
        <Tip>Capacity bounds the unconference auto-assignment.</Tip>
        <Form onSubmit={addRoom}>
          <TextInput label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label="Capacity" type="number" required value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          <Textarea
            label="Description (e.g. directions, accessibility)"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <TagInput
            label="Tags"
            placeholder="e.g. projector, ground floor"
            value={tags}
            onChange={setTags}
            normalize={lowercaseTrim}
          />
          <AvailabilityEditor
            value={availability}
            onChange={setAvailability}
            timeZone={timeZone}
          />
          <Stack direction="row" gap="condensed">
            <Button type="submit" variant="primary" disabled={!availabilityValid}>Add room</Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </Stack>
        </Form>
      </Sheet>

      <Sheet open={!!editingRoom} onClose={() => setEditingId(null)} title={editingRoom ? `Edit ${editingRoom.name}` : ""}>
        {editingRoom && (
          <RoomEditForm
            slug={slug}
            room={editingRoom}
            timeZone={timeZone}
            onCancel={() => setEditingId(null)}
            onSaved={() => { setEditingId(null); rooms.refresh(); }}
          />
        )}
      </Sheet>

      <TextInput
        label="Search"
        placeholder="Search rooms by name, description, or tag"
        value={rooms.q}
        onChange={(e) => rooms.setQ(e.target.value)}
      />

      {rooms.loading && rooms.items.length === 0 ? (
        <Spinner label="Loading…" />
      ) : showEmpty ? (
        <EmptyState
          message="No rooms yet. Rooms are the spaces sessions run in — their capacity drives unconference auto-assignment. Add your first room to get started."
          action={
            isMod ? (
              <Button size="small" variant="primary" onClick={() => setAdding(true)}>
                + Add room
              </Button>
            ) : undefined
          }
        />
      ) : showNoMatches ? (
        <EmptyState
          message={`No rooms match "${rooms.q}".`}
          action={<Button size="small" onClick={rooms.reset}>Clear search</Button>}
        />
      ) : (
        <Stack gap="condensed">
          {rooms.items.map((r) => (
            <RoomRow
              key={r.id}
              room={r}
              isMod={isMod}
              timeZone={timeZone}
              onEdit={() => setEditingId(r.id)}
              onDelete={() => remove(r)}
            />
          ))}
        </Stack>
      )}

      <Pager
        page={rooms.page}
        pageSize={rooms.pageSize}
        total={rooms.total}
        loading={rooms.loading}
        hasPrev={rooms.hasPrev}
        hasNext={rooms.hasNext}
        onPrev={rooms.prev}
        onNext={rooms.next}
        noun="rooms"
      />
    </Stack>
  );
}

// A muted chip used for the room-constraint badges. Native `title` carries the
// explanation (no dedicated Tooltip in the design system).
function ConstraintChip({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        cursor: "help",
        background: "var(--bgColor-attention-muted, rgba(212,167,44,0.18))",
        color: "var(--fgColor-attention, #9a6700)",
      }}
    >
      {label}
    </span>
  );
}

function RoomRow({
  room: r, isMod, timeZone, onEdit, onDelete,
}: {
  room: Room;
  isMod: boolean;
  timeZone: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "8px 12px",
        padding: 12,
        borderRadius: 8,
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      <div style={{ gridColumn: 1, gridRow: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 16 }}>{r.name}</strong>
          <span style={{ color: muted, fontSize: 12 }}>capacity {r.capacity}</span>
          {r.expert_dedicated && (
            <ConstraintChip
              label="Expert bookings"
              title="This room is reserved for expert conversations - agenda slots never use it."
            />
          )}
          {r.availability.length > 0 && (
            <ConstraintChip
              label="Limited availability"
              title={`Available only: ${formatWindows(r.availability, timeZone)}`}
            />
          )}
        </div>
        {r.description && (
          <div style={{ fontSize: 13, color: muted, whiteSpace: "pre-wrap" }}>{r.description}</div>
        )}
        {r.tags.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {r.tags.map((t) => <Pill key={t} variant="primary">{t}</Pill>)}
          </div>
        )}
      </div>
      {isMod && (
        <div style={{ gridColumn: 2, gridRow: 1, display: "flex", gap: 6 }}>
          <Button size="small" onClick={onEdit}>Edit</Button>
          <Button size="small" variant="danger" onClick={onDelete}>Delete</Button>
        </div>
      )}
    </div>
  );
}

// Editor for a room's availability windows. Zero or more rows of two DateTime
// pickers; per-row client validation mirrors the server (end must be after
// start). No windows = always available.
function nextHourWindow(): AvailabilityWindow {
  const hour = 3_600_000;
  const start = Math.ceil(Date.now() / hour) * hour;
  return { starts_at: start, ends_at: start + hour };
}

function AvailabilityEditor({
  value, onChange, timeZone,
}: {
  value: AvailabilityWindow[];
  onChange: (next: AvailabilityWindow[]) => void;
  timeZone: string;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  function patch(index: number, next: Partial<AvailabilityWindow>) {
    onChange(value.map((w, i) => (i === index ? { ...w, ...next } : w)));
  }
  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  return (
    <Stack gap="condensed">
      <span style={{ fontSize: 13, fontWeight: 500 }}>Availability windows</span>
      {value.map((w, i) => {
        const valid = w.ends_at > w.starts_at;
        return (
          <div
            key={i}
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "flex-end",
              gap: 8,
              padding: 8,
              borderRadius: 6,
              border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
            }}
          >
            <div style={{ flex: "1 1 180px", minWidth: 0 }}>
              <DateTime
                label="From"
                value={w.starts_at}
                timeZone={timeZone}
                onChange={(ms) => patch(i, { starts_at: ms })}
              />
            </div>
            <div style={{ flex: "1 1 180px", minWidth: 0 }}>
              <DateTime
                label="To"
                value={w.ends_at}
                timeZone={timeZone}
                onChange={(ms) => patch(i, { ends_at: ms })}
                error={valid ? undefined : "End must be after start."}
              />
            </div>
            <Button size="small" variant="danger" onClick={() => removeAt(i)}>
              Remove
            </Button>
          </div>
        );
      })}
      <div>
        <Button size="small" onClick={() => onChange([...value, nextHourWindow()])}>
          + Add availability window
        </Button>
      </div>
      <span style={{ fontSize: 12, color: muted }}>
        No windows = available for the whole conference. With windows, this room
        can only be used inside them.
      </span>
    </Stack>
  );
}

// Edit form for a room — rendered inside a Sheet, so we drop the Card chrome
// the previous inline version used.
function RoomEditForm({
  slug, room, timeZone, onCancel, onSaved,
}: {
  slug: string;
  room: Room;
  timeZone: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(room.name);
  const [capacity, setCapacity] = useState(String(room.capacity));
  const [description, setDescription] = useState(room.description ?? "");
  const [tags, setTags] = useState<string[]>(room.tags);
  const [availability, setAvailability] = useState<AvailabilityWindow[]>(
    room.availability.map((w) => ({ starts_at: w.starts_at, ends_at: w.ends_at })),
  );
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const availabilityValid = availability.every((w) => w.ends_at > w.starts_at);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!availabilityValid) return;
    setBusy(true);
    try {
      await api.rooms.update({
        slug, id: room.id,
        name,
        capacity: Number(capacity),
        description: description.trim() === "" ? null : description,
        tags,
        availability,
      });
      onSaved();
      toast.success(`Room "${name}" updated.`);
    } catch (e) {
      toast.error(availabilityStrandsMessage(e, timeZone) ?? errorCode(e));
    } finally { setBusy(false); }
  }

  return (
    <Stack gap="condensed">
      <Form onSubmit={save}>
        <TextInput label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput label="Capacity" type="number" required value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        <Textarea
          label="Description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TagInput
          label="Tags"
          value={tags}
          onChange={setTags}
          normalize={lowercaseTrim}
        />
        <AvailabilityEditor
          value={availability}
          onChange={setAvailability}
          timeZone={timeZone}
        />
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary" disabled={busy || !availabilityValid}>Save</Button>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        </Stack>
      </Form>
    </Stack>
  );
}
