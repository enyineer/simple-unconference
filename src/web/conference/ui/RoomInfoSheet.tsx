// Sheet that surfaces all the practical details about a room — capacity,
// description, tags. Used anywhere a room is referenced (e.g. My Schedule).
// Renders nothing when `room` is null so callers can drive open/close just
// by setting state.

import { Sheet, Stack, Text } from "../../design-system";
import type { Room } from "../types";
import { Pill } from "./Pill";

export function RoomInfoSheet({
  room, onClose,
}: {
  room: Room | null;
  onClose: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <Sheet open={!!room} onClose={onClose} title={room?.name ?? ""}>
      {room && (
        <Stack gap="spacious">
          <Stack gap="condensed">
            <div style={{
              fontSize: 12, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: 0.6,
              color: muted,
            }}>
              Capacity
            </div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{room.capacity}</div>
          </Stack>

          {room.description ? (
            <Stack gap="condensed">
              <div style={{
                fontSize: 12, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: 0.6,
                color: muted,
              }}>
                Description
              </div>
              <div style={{ fontSize: 14, lineHeight: "20px", whiteSpace: "pre-wrap" }}>
                {room.description}
              </div>
            </Stack>
          ) : (
            <Text muted>No description provided.</Text>
          )}

          {room.tags.length > 0 && (
            <Stack gap="condensed">
              <div style={{
                fontSize: 12, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: 0.6,
                color: muted,
              }}>
                Tags
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {room.tags.map((t) => <Pill key={t} variant="primary">{t}</Pill>)}
              </div>
            </Stack>
          )}
        </Stack>
      )}
    </Sheet>
  );
}
