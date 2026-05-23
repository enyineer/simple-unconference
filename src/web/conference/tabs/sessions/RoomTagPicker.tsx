import { Stack, Text } from "../../../design-system";

// Multi-tag picker for "required room features". Only renders tags that
// actually exist on at least one room in the conference; selecting a tag
// no room carries would make the session unplaceable, so we don't offer
// free-text input. Renders a notice when the conference has no room tags
// at all (the picker is a no-op until a mod tags some rooms).
export function RoomTagPicker({
  availableTags, selected, onChange, disabled,
}: {
  availableTags: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  if (availableTags.length === 0) {
    return (
      <Stack gap="condensed">
        <div style={{ fontSize: 13, fontWeight: 500 }}>Required room features</div>
        <Text muted>
          No room has any feature tags yet. Ask a moderator to tag rooms
          (e.g. &quot;projector&quot;, &quot;whiteboard&quot;) in the Rooms tab to enable this.
        </Text>
      </Stack>
    );
  }
  const selectedSet = new Set(selected);
  function toggle(tag: string) {
    if (disabled) return;
    if (selectedSet.has(tag)) onChange(selected.filter((t) => t !== tag));
    else onChange([...selected, tag]);
  }
  return (
    <Stack gap="condensed">
      <div style={{ fontSize: 13, fontWeight: 500 }}>Required room features</div>
      <div style={{ fontSize: 12, color: muted }}>
        The assigned room must have all selected features. Leave empty if any
        room works.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {availableTags.map((tag) => {
          const on = selectedSet.has(tag);
          return (
            <label
              key={tag}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 8px",
                borderRadius: 999,
                fontSize: 12,
                border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
                background: on
                  ? "var(--bgColor-accent-muted, rgba(9,105,218,0.15))"
                  : "var(--bgColor-default, transparent)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.6 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={() => toggle(tag)}
                style={{ margin: 0 }}
              />
              {tag}
            </label>
          );
        })}
      </div>
    </Stack>
  );
}
