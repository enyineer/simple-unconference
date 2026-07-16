import { Text } from "../../../design-system";
import type { Room } from "../../types";

export function RoomCheckboxes({
  rooms, value, onChange,
}: {
  rooms: Room[];
  value: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  if (rooms.length === 0) {
    return <Text muted>No rooms yet — add some on the Rooms tab first.</Text>;
  }
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
      gap: 6,
    }}>
      {rooms.map((r) => {
        const on = value.has(r.id);
        // A room already used by the agenda (a planned track or an
        // unconference placement) can't be reserved for experts. Keep it
        // visible but unselectable so the mod sees why it's off-limits.
        const blocked = r.slot_used && !on;
        return (
          <label
            key={r.id}
            title={
              blocked
                ? "Used by the agenda (e.g. a talk or session placement) - clear its assignments to reserve this room for experts."
                : undefined
            }
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: 8, borderRadius: 6,
              border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
              background: on ? "var(--bgColor-accent-muted, rgba(64,132,246,0.08))" : "transparent",
              cursor: blocked ? "not-allowed" : "pointer",
              opacity: blocked ? 0.5 : 1,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={on}
              disabled={blocked}
              onChange={() => {
                const next = new Set(value);
                if (on) next.delete(r.id); else next.add(r.id);
                onChange(next);
              }}
            />
            <span>{r.name}</span>
            {blocked && (
              <span style={{ color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))", fontSize: 11 }}>
                in use
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}
