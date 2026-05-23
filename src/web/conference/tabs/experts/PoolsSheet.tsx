import { useState } from "react";
import { Button, Form, Sheet, Stack, Text, TextInput } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Room } from "../../types";
import { EmptyState } from "../../ui/EmptyState";
import { Tip } from "../../ui/Tip";
import { RoomCheckboxes } from "./RoomCheckboxes";
import { humanError } from "./helpers";
import type { ExpertPool } from "./types";

export function PoolsSheet({
  open, slug, rooms, pools, onClose, onDone,
}: {
  open: boolean;
  slug: string;
  rooms: Room[];
  pools: ExpertPool[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [roomIds, setRoomIds] = useState<Set<number>>(new Set());
  const toast = useToast();

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { toast.error("Pool name is required."); return; }
    try {
      await api.experts.createPool({ slug, name: name.trim(), room_ids: [...roomIds] });
      setName(""); setRoomIds(new Set()); setCreating(false);
      onDone();
    } catch (err) { toast.error(humanError(errorCode(err))); }
  }

  async function remove(id: number) {
    if (!confirm("Delete this pool? Experts using it will be left without rooms.")) return;
    try { await api.experts.deletePool({ slug, id }); }
    catch (err) { toast.error(humanError(errorCode(err))); }
    onDone();
  }

  return (
    <Sheet open={open} onClose={onClose} title="Expert room pools">
      <Tip>
        A pool is a named set of rooms reserved for expert chats. Assign an
        expert to a pool and bookings will draw the first available room from
        it. You can also assign specific rooms per expert instead.
      </Tip>
      <Stack gap="spacious">
        {pools.length === 0 ? (
          <EmptyState message="No pools yet." />
        ) : (
          <Stack gap="condensed">
            {pools.map((p) => (
              <PoolRow
                key={p.id}
                pool={p}
                rooms={rooms}
                slug={slug}
                onChanged={onDone}
                onDelete={() => remove(p.id)}
              />
            ))}
          </Stack>
        )}
        {!creating ? (
          <Stack direction="row" gap="condensed">
            <Button onClick={() => setCreating(true)}>+ Add pool</Button>
          </Stack>
        ) : (
          <Form onSubmit={create}>
            <TextInput
              label="Pool name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Quiet corners"
            />
            <RoomCheckboxes rooms={rooms} value={roomIds} onChange={setRoomIds} />
            <Stack direction="row" gap="condensed">
              <Button type="submit" variant="primary">Create pool</Button>
              <Button onClick={() => setCreating(false)}>Cancel</Button>
            </Stack>
          </Form>
        )}
      </Stack>
    </Sheet>
  );
}

export function PoolRow({
  pool, rooms, slug, onChanged, onDelete,
}: {
  pool: ExpertPool;
  rooms: Room[];
  slug: string;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pool.name);
  const [roomIds, setRoomIds] = useState<Set<number>>(new Set(pool.room_ids));
  const toast = useToast();

  async function save() {
    try {
      await api.experts.updatePool({ slug, id: pool.id, name: name.trim() || pool.name, room_ids: [...roomIds] });
      setEditing(false);
      onChanged();
    } catch (e) { toast.error(humanError(errorCode(e))); }
  }

  return (
    <div style={{
      padding: 12,
      borderRadius: 8,
      border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
    }}>
      {!editing ? (
        <Stack direction="row" justify="between" align="center" wrap>
          <div>
            <div style={{ fontWeight: 600 }}>{pool.name}</div>
            <Text muted>
              {pool.room_ids.length} room{pool.room_ids.length === 1 ? "" : "s"} ·{" "}
              {pool.expert_count} expert{pool.expert_count === 1 ? "" : "s"}
            </Text>
          </div>
          <Stack direction="row" gap="condensed">
            <Button size="small" onClick={() => setEditing(true)}>Edit</Button>
            <Button size="small" variant="danger" onClick={onDelete}>Delete</Button>
          </Stack>
        </Stack>
      ) : (
        <Stack gap="condensed">
          <TextInput label="Pool name" value={name} onChange={(e) => setName(e.target.value)} />
          <RoomCheckboxes rooms={rooms} value={roomIds} onChange={setRoomIds} />
          <Stack direction="row" gap="condensed">
            <Button size="small" variant="primary" onClick={save}>Save</Button>
            <Button size="small" onClick={() => { setEditing(false); setName(pool.name); setRoomIds(new Set(pool.room_ids)); }}>Cancel</Button>
          </Stack>
        </Stack>
      )}
    </div>
  );
}
