import { useState } from "react";
import { Stack } from "../../../design-system";
import { SLOT_TYPE_GUIDES, type SlotTypeGuide } from "../../ui/agendaGuide";
import type { SlotKind } from "./types";

// ---- Slot-type chooser: one selectable card per slot type. ----
//
// Replaces the plain <Select label="Type">. Each card shows the glyph, label,
// tagline ("what it is") and whenToUse ("use it when…") so a non-technical
// moderator can pick by reading, not by knowing the jargon. The selected /
// unselected visual treatment mirrors MixerBody's room cards.
export function SlotTypeChooser({
  value,
  onChange,
}: {
  value: SlotKind;
  onChange: (next: SlotKind) => void;
}) {
  return (
    <Stack gap="condensed">
      {SLOT_TYPE_GUIDES.map((guide) => (
        <SlotTypeCard
          key={guide.key}
          guide={guide}
          selected={guide.key === value}
          onSelect={() => onChange(guide.key)}
        />
      ))}
    </Stack>
  );
}

function SlotTypeCard({
  guide,
  selected,
  onSelect,
}: {
  guide: SlotTypeGuide;
  selected: boolean;
  onSelect: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  // `all: unset` clears the native focus ring, so render our own when the
  // button is keyboard-focused (keyboard users otherwise get no indicator).
  const [focused, setFocused] = useState(false);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      onFocus={(e) => setFocused(e.currentTarget.matches(":focus-visible"))}
      onBlur={() => setFocused(false)}
      style={{
        all: "unset",
        display: "block",
        cursor: "pointer",
        borderRadius: 8,
        outline: focused
          ? "2px solid var(--fgColor-accent, #2563eb)"
          : "none",
        outlineOffset: 2,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          gap: "4px 12px",
          padding: 12,
          borderRadius: 8,
          border: `1px solid ${
            selected
              ? guide.accentVar
              : "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))"
          }`,
          background: selected
            ? "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.04)))"
            : "var(--bgColor-default, var(--uncon-bg, transparent))",
          boxShadow: selected ? `inset 0 0 0 1px ${guide.accentVar}` : "none",
          opacity: selected ? 1 : 0.85,
          transition: "opacity 120ms, border-color 120ms",
        }}
      >
        <span
          aria-hidden
          style={{ gridColumn: 1, gridRow: "1 / span 2", fontSize: 22, lineHeight: "22px" }}
        >
          {guide.glyph}
        </span>
        <span
          style={{
            gridColumn: 2,
            gridRow: 1,
            fontSize: 14,
            fontWeight: 600,
            color: "var(--fgColor-default, var(--uncon-fg, inherit))",
          }}
        >
          {guide.label}
        </span>
        <span
          style={{
            gridColumn: 3,
            gridRow: 1,
            fontSize: 11,
            fontWeight: 500,
            color: selected ? guide.accentVar : muted,
          }}
        >
          {selected ? "✓ selected" : "choose"}
        </span>
        <span
          style={{
            gridColumn: 2,
            gridRow: 2,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            fontSize: 13,
            lineHeight: "18px",
            color: muted,
          }}
        >
          <span>{guide.tagline}</span>
          <span style={{ opacity: 0.85 }}>{guide.whenToUse}</span>
        </span>
      </div>
    </button>
  );
}
