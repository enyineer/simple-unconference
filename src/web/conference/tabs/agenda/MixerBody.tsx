import { Button, Select, Stack, Text } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Room, Slot } from "../../types";
import { Tip } from "../../ui/Tip";
import { slotRoomBlockReason } from "../../roomConstraints";

// ---- Mixer slot body: room picker (mods) + room summary (everyone). ----
//
// Mods see every conference room as a toggleable card and can flip rooms
// in/out of the mixer right from the body — no separate "Configure" step
// for what is functionally the only mixer-specific setting.

export function MixerBody({
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
  const toast = useToast();

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
      toast.error(errorCode(e));
    }
  }

  // Rooms usable for THIS mixer: not reserved for experts and available at the
  // slot's time. Blocked rooms stay visible but can't be toggled in.
  const usableRooms = rooms.filter((r) => slotRoomBlockReason(r, slot) === null);

  async function toggleRoom(roomId: number) {
    const next = new Set(selected);
    if (next.has(roomId)) next.delete(roomId);
    else next.add(roomId);
    await setSelection(next);
  }
  async function selectAll() {
    await setSelection(new Set(usableRooms.map((r) => r.id)));
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
      toast.error(errorCode(e));
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
            disabled={usableRooms.length > 0 && usableRooms.every((r) => selected.has(r.id))}
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
        {rooms.map((r) => {
          const reason = slotRoomBlockReason(r, slot);
          const isSelected = selected.has(r.id);
          // Blocked-and-not-selected rooms are read-only (no toggle); a room
          // already selected but now blocked stays togglable so the mod can
          // remove it.
          const locked = reason !== null && !isSelected;
          return (
            <MixerRoomCard
              key={r.id}
              room={r}
              selected={isSelected}
              disabledReason={reason ?? undefined}
              onToggle={locked ? undefined : () => toggleRoom(r.id)}
            />
          );
        })}
      </Stack>
    </Stack>
  );
}

export function MixerRoomCard({
  room,
  selected,
  onToggle,
  disabledReason,
}: {
  room: Room;
  selected: boolean;
  onToggle?: () => Promise<void>;
  /** When set (and the card isn't interactive), explains why this room is
   *  off-limits for the mixer — shown as a chip + native tooltip. */
  disabledReason?: string;
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
      {onToggle ? (
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
      ) : disabledReason ? (
        <span
          style={{
            gridColumn: 2,
            gridRow: 1,
            fontSize: 11,
            color: muted,
            fontWeight: 500,
          }}
        >
          {disabledReason}
        </span>
      ) : null}
    </div>
  );

  if (!onToggle) {
    return disabledReason ? (
      <span title={disabledReason} style={{ display: "block" }}>
        {content}
      </span>
    ) : (
      content
    );
  }
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
