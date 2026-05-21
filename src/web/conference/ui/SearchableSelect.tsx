// Filterable, keyboard-friendly single-select. Mirrors the design-system
// Select API (label / value / options / onChange) so it can drop in where
// the option list is long enough that scanning is painful — rooms,
// participants, submissions, timezones, expert pools, etc.
//
// Implementation notes:
//   - Plugin-agnostic: only uses CSS vars exposed by both design-system
//     plugins (github + minimal). Falls back to neutral defaults so it
//     still renders if a var is missing.
//   - Single-select only. For multi-select we have `RoomTagPicker` and
//     `RoomCheckboxes` patterns elsewhere; don't shoehorn this into them.
//   - Keyboard: ArrowUp/Down to move the highlight, Enter to commit,
//     Escape to close. Type-to-filter is just the input.

import {
  useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent,
} from "react";

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Optional second line shown muted under the label (e.g. an email
   * under a display name, or capacity under a room name). */
  hint?: string;
}

interface Props {
  label?: string;
  value: string;
  onChange: (next: string) => void;
  options: SearchableSelectOption[];
  /** Shown inside the input when no value is selected. */
  placeholder?: string;
  disabled?: boolean;
  /** Block-level layout (full width). Matches the Select prop name. */
  block?: boolean;
  /** Empty-state message shown when nothing matches the query. */
  emptyLabel?: string;
}

export function SearchableSelect({
  label,
  value,
  onChange,
  options,
  placeholder = "Type to search…",
  disabled = false,
  block = true,
  emptyLabel = "No matches.",
}: Props) {
  const inputId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  // `query` is the live filter text. When closed, the input shows the
  // current selection's label so the field reads as a normal control;
  // opening (or typing) switches it to the filter buffer.
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      if (o.label.toLowerCase().includes(q)) return true;
      if (o.hint && o.hint.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [query, options]);

  // Reset the highlight when the filter changes so it never points off
  // the end of the visible list. Adjusts state during render (React's
  // recommended pattern for prop-derived resets) rather than running an
  // effect after paint.
  const [lastResetKey, setLastResetKey] = useState<string>(`${query}|${open}`);
  const resetKey = `${query}|${open}`;
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey);
    setHighlight(0);
  }

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        commitClose();
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
     
  }, [open]);

  function commitClose() {
    setOpen(false);
    setQuery("");
  }

  function commit(next: string) {
    onChange(next);
    commitClose();
    // Return focus to the input so the user can keep navigating with the
    // keyboard if they want to.
    inputRef.current?.blur();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      if (open && filtered[highlight]) {
        e.preventDefault();
        commit(filtered[highlight]!.value);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        commitClose();
      }
    } else if (e.key === "Tab") {
      // Let Tab move focus normally, but close the dropdown so the next
      // field isn't hidden behind it.
      if (open) commitClose();
    }
  }

  // Style tokens reused across both design-system plugins. Each pulls from
  // a Primer-style var with a generic fallback for plugins that don't
  // expose it.
  const border = "var(--borderColor-default, var(--uncon-border, #d0d7de))";
  const borderHighlight = "var(--borderColor-accent-emphasis, #0969da)";
  const bg = "var(--bgColor-default, var(--uncon-bg, #fff))";
  const bgMuted = "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.04)))";
  const bgHighlight = "var(--bgColor-accent-muted, rgba(9,105,218,0.14))";
  const fg = "var(--fgColor-default, var(--uncon-fg, inherit))";
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  const inputValue = open ? query : (selected?.label ?? "");

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        display: block ? "flex" : "inline-flex",
        flexDirection: "column",
        gap: 4,
        width: block ? "100%" : undefined,
      }}
    >
      {label && (
        <label
          htmlFor={inputId}
          style={{ fontSize: 13, fontWeight: 500, color: fg }}
        >
          {label}
        </label>
      )}
      <div style={{ position: "relative" }}>
        <input
          id={inputId}
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          value={inputValue}
          placeholder={selected ? selected.label : placeholder}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          style={{
            width: "100%",
            padding: "6px 28px 6px 10px",
            borderRadius: 6,
            border: `1px solid ${open ? borderHighlight : border}`,
            background: bg,
            color: fg,
            fontSize: 14,
            outline: "none",
            opacity: disabled ? 0.6 : 1,
            cursor: disabled ? "not-allowed" : "text",
          }}
        />
        {/* Chevron */}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: 10,
            top: "50%",
            transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
            color: muted,
            fontSize: 10,
            pointerEvents: "none",
            transition: "transform 120ms",
          }}
        >
          {"▼"}
        </span>
      </div>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 4,
            maxHeight: 240,
            overflowY: "auto",
            zIndex: 20,
            borderRadius: 6,
            border: `1px solid ${border}`,
            background: bg,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: 13, color: muted }}>
              {emptyLabel}
            </div>
          ) : (
            filtered.map((o, i) => {
              const isHighlight = i === highlight;
              const isSelected = o.value === value;
              return (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(e) => {
                    // Use mousedown not click — click fires after the
                    // input's blur, which would close us first.
                    e.preventDefault();
                    commit(o.value);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  style={{
                    padding: "6px 10px",
                    cursor: "pointer",
                    background: isHighlight
                      ? bgHighlight
                      : isSelected
                        ? bgMuted
                        : "transparent",
                    color: fg,
                    fontSize: 14,
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    borderBottom: `1px solid ${border}`,
                  }}
                >
                  <span style={{ fontWeight: isSelected ? 600 : 400 }}>
                    {o.label}
                  </span>
                  {o.hint && (
                    <span style={{ fontSize: 12, color: muted }}>{o.hint}</span>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
