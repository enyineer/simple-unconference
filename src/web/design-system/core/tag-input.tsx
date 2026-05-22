// Lightweight tag/chip input. Keeps a controlled array of strings and
// commits new chips on Enter, comma, or Tab. Backspace on an empty input
// removes the last chip (familiar from Slack / Linear / GitHub label
// pickers). Dedup + max-length + max-count enforced client-side.
//
// Styling uses the same Badge primitive other surfaces already use, so
// chips look identical to inline tag pills elsewhere in the app — this
// component owns only the row layout and the inline text input.

import { useState, type KeyboardEvent, type ChangeEvent } from "react";
import { Badge } from "../index";

// `lowercaseTrim` and any other normalizers live in ./normalize so this file
// stays component-only (Fast Refresh requires it).

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Maximum number of tags allowed (default: 20). */
  max?: number;
  /** Maximum length of a single tag (default: 48). */
  maxLength?: number;
  placeholder?: string;
  /** Field label rendered above the chip row. */
  label?: string;
  /** Inline error message rendered under the input. */
  error?: string;
  /** Disable both input and chip removal. */
  disabled?: boolean;
  /** Optional transform applied to each committed value before dedup +
   *  storage. When provided, dedup compares normalized values directly
   *  (caller chose the canonical form). Without it, dedup falls back to
   *  case-insensitive compare while preserving the user's casing. */
  normalize?: (raw: string) => string;
}

export function TagInput({
  value,
  onChange,
  max = 20,
  maxLength = 48,
  placeholder,
  label,
  error,
  disabled,
  normalize,
}: TagInputProps) {
  const [draft, setDraft] = useState("");

  function commit(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const next = normalize ? normalize(raw) : trimmed;
    if (!next) return;
    if (next.length > maxLength) return;
    if (value.length >= max) return;
    const isDuplicate = normalize
      ? value.some((t) => t === next)
      : value.some((t) => t.toLowerCase() === next.toLowerCase());
    if (isDuplicate) {
      // dedup — just drop the draft silently
      setDraft("");
      return;
    }
    onChange([...value, next]);
    setDraft("");
  }

  function removeAt(idx: number): void {
    if (disabled) return;
    onChange(value.filter((_, i) => i !== idx));
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (disabled) return;
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      // Only steal Tab when there's a draft to commit, so empty Tabs still
      // move focus naturally.
      if (e.key === "Tab" && !draft.trim()) return;
      e.preventDefault();
      commit(draft);
      return;
    }
    if (e.key === "Backspace" && draft === "" && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  function onChangeInput(e: ChangeEvent<HTMLInputElement>): void {
    setDraft(e.target.value);
  }

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const borderColor = error
    ? "var(--fgColor-danger, var(--uncon-danger, #cf222e))"
    : "var(--borderColor-default, var(--uncon-border, #d0d7de))";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label && (
        <label
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--fgColor-default, var(--uncon-fg, inherit))",
          }}
        >
          {label}
        </label>
      )}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          padding: 8,
          borderRadius: 6,
          border: `1px solid ${borderColor}`,
          background: "var(--bgColor-default, var(--uncon-bg, transparent))",
          minHeight: 36,
          alignItems: "center",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {value.map((t, i) => (
          <span
            key={`${t}-${i}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <Badge>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                {t}
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  aria-label={`Remove ${t}`}
                  disabled={disabled}
                  style={{
                    appearance: "none",
                    border: "none",
                    background: "transparent",
                    color: "inherit",
                    cursor: disabled ? "default" : "pointer",
                    fontSize: 14,
                    lineHeight: 1,
                    padding: 0,
                    marginLeft: 2,
                  }}
                >
                  ×
                </button>
              </span>
            </Badge>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={onChangeInput}
          onKeyDown={onKey}
          onBlur={() => { if (draft.trim()) commit(draft); }}
          placeholder={value.length === 0 ? placeholder : ""}
          disabled={disabled || value.length >= max}
          maxLength={maxLength}
          style={{
            flex: "1 1 120px",
            minWidth: 80,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "inherit",
            fontFamily: "inherit",
            fontSize: 14,
            padding: "2px 4px",
          }}
        />
      </div>
      {error && (
        <div
          style={{
            fontSize: 12,
            color: "var(--fgColor-danger, var(--uncon-danger, #cf222e))",
          }}
        >
          {error}
        </div>
      )}
      {!error && value.length >= max && (
        <div style={{ fontSize: 12, color: muted }}>
          Tag limit reached ({max}).
        </div>
      )}
    </div>
  );
}
