import { useMemo, useState } from "react";
import { Button, Form, Select, Sheet, Stack, Textarea } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Room, Participant } from "../../types";
import { SearchableSelect } from "../../ui/SearchableSelect";
import { RoomCheckboxes } from "./RoomCheckboxes";
import { humanError } from "./helpers";
import type { ExpertPool } from "./types";

export function PromoteExpertSheet({
  open, slug, rooms, pools, people, existingExpertIdentityIds, onClose, onDone,
}: {
  open: boolean;
  slug: string;
  rooms: Room[];
  pools: ExpertPool[];
  people: Participant[];
  existingExpertIdentityIds: Set<number>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [identityId, setIdentityId] = useState<string>("");
  const [bio, setBio] = useState("");
  const [mode, setMode] = useState<"pool" | "rooms">("pool");
  const [poolId, setPoolId] = useState<string>("");
  const [roomIds, setRoomIds] = useState<Set<number>>(new Set());
  const toast = useToast();

  const candidates = useMemo(
    () => people.filter((p) => !existingExpertIdentityIds.has(p.user_id)),
    [people, existingExpertIdentityIds],
  );

  // Reset fields when the sheet closes. Detected via the "previous value"
  // pattern (adjusting state during render) rather than an effect so the
  // next render already shows the cleared values when the user reopens.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setIdentityId(""); setBio(""); setMode("pool");
      setPoolId(""); setRoomIds(new Set());
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!identityId) { toast.error("Pick a member."); return; }
    try {
      await api.experts.promote({
        slug,
        identity_id: Number(identityId),
        bio: bio.trim() || undefined,
        pool_id: mode === "pool" && poolId ? Number(poolId) : null,
        room_ids: mode === "rooms" ? [...roomIds] : undefined,
      });
      onDone();
    } catch (err) { toast.error(humanError(errorCode(err))); }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Promote to expert">
      <Form onSubmit={submit}>
        <SearchableSelect
          label="Member"
          value={identityId}
          onChange={setIdentityId}
          options={[
            { value: "", label: "Pick a conference member…" },
            ...candidates.map((p) => ({
              value: String(p.user_id),
              label: p.name && p.name.trim() ? p.name : p.email,
              hint: p.name && p.name.trim() ? p.email : undefined,
            })),
          ]}
          placeholder="Search by name or email…"
        />
        <Textarea
          label="Bio / expertise (shown to all members)"
          rows={3}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="e.g. 10y Rust, distributed systems, happy to talk about anything"
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
              { value: "", label: "— No pool (booking will fail) —" },
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
          <Button type="submit" variant="primary">Promote</Button>
          <Button onClick={onClose}>Cancel</Button>
        </Stack>
      </Form>
    </Sheet>
  );
}
