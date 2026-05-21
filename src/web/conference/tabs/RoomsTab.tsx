import { useEffect, useState } from "react";
import {
  Banner, Button, Form, Heading, Sheet, Spinner, Stack, TextInput, Textarea,
} from "../../design-system";
import { api, errorCode } from "../../api";
import { quotaErrorMessage } from "../../quotaErrors";
import type { Room } from "../types";
import { parseLabels } from "../helpers";
import { EmptyState } from "../ui/EmptyState";
import { Pill } from "../ui/Pill";
import { Tip } from "../ui/Tip";

export function RoomsTab({ slug, isMod }: { slug: string; isMod: boolean }) {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("20");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setRooms(await api.rooms.list({ slug }));
  }
  useEffect(() => {
    let cancelled = false;
    api.rooms.list({ slug })
      .then((rs) => { if (!cancelled) setRooms(rs); })
      .catch(() => { if (!cancelled) setRooms([]); });
    return () => { cancelled = true; };
  }, [slug]);

  async function addRoom(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.rooms.create({
        slug, name,
        capacity: Number(capacity),
        description: description.trim() || null,
        tags: parseLabels(tags),
      });
      setName(""); setCapacity("20"); setDescription(""); setTags("");
      setAdding(false);
      await refresh();
    } catch (e) { setError(quotaErrorMessage(e) ?? errorCode(e)); }
  }

  async function remove(id: number) {
    if (!confirm("Delete this room?")) return;
    await api.rooms.delete({ slug, id });
    await refresh();
  }

  const editingRoom = editingId ? rooms?.find((r) => r.id === editingId) ?? null : null;

  return (
    <Stack gap="spacious">
      <Stack direction="row" justify="between" align="center" wrap>
        <Heading level={2}>Rooms</Heading>
        {isMod && (
          <Button variant="primary" onClick={() => setAdding(true)}>+ Add room</Button>
        )}
      </Stack>

      <Sheet open={adding} onClose={() => setAdding(false)} title="Add room">
        {error && <Banner variant="critical">{error}</Banner>}
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
          <TextInput
            label="Tags (comma-separated)"
            placeholder="e.g. projector, ground floor"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
          <Stack direction="row" gap="condensed">
            <Button type="submit" variant="primary">Add room</Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </Stack>
        </Form>
      </Sheet>

      <Sheet open={!!editingRoom} onClose={() => setEditingId(null)} title={editingRoom ? `Edit ${editingRoom.name}` : ""}>
        {editingRoom && (
          <RoomEditForm
            slug={slug}
            room={editingRoom}
            onCancel={() => setEditingId(null)}
            onSaved={async () => { setEditingId(null); await refresh(); }}
          />
        )}
      </Sheet>

      {!rooms ? (
        <Spinner label="Loading…" />
      ) : rooms.length === 0 ? (
        <EmptyState message="No rooms yet." />
      ) : (
        <Stack gap="condensed">
          {rooms.map((r) => (
            <RoomRow
              key={r.id}
              room={r}
              isMod={isMod}
              onEdit={() => setEditingId(r.id)}
              onDelete={() => remove(r.id)}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function RoomRow({
  room: r, isMod, onEdit, onDelete,
}: {
  room: Room;
  isMod: boolean;
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

// Edit form for a room — rendered inside a Sheet, so we drop the Card chrome
// the previous inline version used.
function RoomEditForm({
  slug, room, onCancel, onSaved,
}: {
  slug: string;
  room: Room;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [name, setName] = useState(room.name);
  const [capacity, setCapacity] = useState(String(room.capacity));
  const [description, setDescription] = useState(room.description ?? "");
  const [tags, setTags] = useState(room.tags.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.rooms.update({
        slug, id: room.id,
        name,
        capacity: Number(capacity),
        description: description.trim() === "" ? null : description,
        tags: parseLabels(tags),
      });
      await onSaved();
    } catch (e) {
      setError(errorCode(e));
    } finally { setBusy(false); }
  }

  return (
    <Stack gap="condensed">
      {error && <Banner variant="critical">{error}</Banner>}
      <Form onSubmit={save}>
        <TextInput label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput label="Capacity" type="number" required value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        <Textarea
          label="Description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TextInput
          label="Tags (comma-separated)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary" disabled={busy}>Save</Button>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        </Stack>
      </Form>
    </Stack>
  );
}
