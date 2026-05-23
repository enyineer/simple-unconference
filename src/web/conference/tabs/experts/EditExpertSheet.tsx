import { useState } from "react";
import { Button, Form, Select, Sheet, Stack, Textarea } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Room } from "../../types";
import { SearchableSelect } from "../../ui/SearchableSelect";
import { RoomCheckboxes } from "./RoomCheckboxes";
import { humanError } from "./helpers";
import type { Expert, ExpertPool } from "./types";

export function EditExpertSheet({
  open, slug, expert, rooms, pools, onClose, onDone,
}: {
  open: boolean;
  slug: string;
  expert: Expert;
  rooms: Room[];
  pools: ExpertPool[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [bio, setBio] = useState(expert.bio ?? "");
  const [mode, setMode] = useState<"pool" | "rooms">(expert.pool_id !== null ? "pool" : "rooms");
  const [poolId, setPoolId] = useState<string>(expert.pool_id !== null ? String(expert.pool_id) : "");
  const [roomIds, setRoomIds] = useState<Set<number>>(new Set(expert.room_ids));
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.experts.update({
        slug,
        id: expert.id,
        bio: bio.trim() || null,
        pool_id: mode === "pool" && poolId ? Number(poolId) : null,
        room_ids: mode === "rooms" ? [...roomIds] : [],
      });
      onDone();
    } catch (err) { toast.error(humanError(errorCode(err))); }
  }

  const display = expert.name || expert.email || `Expert #${expert.id}`;
  return (
    <Sheet open={open} onClose={onClose} title={`Edit ${display}`}>
      <Form onSubmit={submit}>
        <Textarea
          label="Bio"
          rows={3}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
        />
        <Select
          label="Rooms for bookings"
          value={mode}
          onChange={(e) => setMode(e.target.value as "pool" | "rooms")}
          options={[
            { value: "pool", label: "From a pool" },
            { value: "rooms", label: "Specific rooms" },
          ]}
        />
        {mode === "pool" ? (
          <SearchableSelect
            label="Pool"
            value={poolId}
            onChange={setPoolId}
            options={[
              { value: "", label: "— No pool —" },
              ...pools.map((p) => ({
                value: String(p.id),
                label: p.name,
                hint: `${p.room_ids.length} room${p.room_ids.length === 1 ? "" : "s"}`,
              })),
            ]}
            placeholder="Search pools…"
          />
        ) : (
          <RoomCheckboxes rooms={rooms} value={roomIds} onChange={setRoomIds} />
        )}
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary">Save</Button>
          <Button onClick={onClose}>Cancel</Button>
        </Stack>
      </Form>
    </Sheet>
  );
}
