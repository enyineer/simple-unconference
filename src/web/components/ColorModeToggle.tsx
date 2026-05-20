// Compact segmented control for Auto / Light / Dark.
// Rendered as a single rounded container with the active option lifted via a
// subtle background fill — feels like a settings switch, not three CTAs.

import type { ColorMode } from "../design-system/core/contract";

const OPTIONS: { value: ColorMode; label: string; symbol: string }[] = [
  { value: "auto",  label: "Auto",  symbol: "◐" },
  { value: "light", label: "Light", symbol: "☀" },
  { value: "dark",  label: "Dark",  symbol: "☾" },
];

interface Props {
  value: ColorMode;
  onChange: (next: ColorMode) => void;
}

export function ColorModeToggle({ value, onChange }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Color mode"
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 2,
        borderRadius: 999,
        border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
        background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.04)))",
      }}
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            title={opt.label}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 10px",
              border: "none",
              borderRadius: 999,
              background: active
                ? "var(--bgColor-default, var(--uncon-bg, #fff))"
                : "transparent",
              color: active
                ? "var(--fgColor-default, var(--uncon-fg, inherit))"
                : "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              boxShadow: active ? "0 1px 2px rgba(0, 0, 0, 0.08)" : "none",
              fontSize: 12,
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: "pointer",
              transition: "background 0.12s ease, color 0.12s ease",
            }}
          >
            <span aria-hidden style={{ fontSize: 13 }}>{opt.symbol}</span>
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
