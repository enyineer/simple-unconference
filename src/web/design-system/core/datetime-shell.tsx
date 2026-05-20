// Shared DateTime field used by both plugins. Wraps a native
// <input type="datetime-local"> so we get the platform's date+time picker on
// every browser and mobile OS, and converts between the input's local wall
// clock and an absolute epoch in a configurable IANA timezone.

import { useId, type ChangeEvent } from "react";
import { instantToWallClock, wallClockToInstant } from "../../../shared/tz";

export interface DateTimeShellTokens {
  bg: string;
  fg: string;
  fgMuted: string;
  border: string;
  borderDanger: string;
}

interface DateTimeShellProps {
  id?: string;
  name?: string;
  label?: string;
  value: number;
  onChange: (ms: number) => void;
  /** IANA timezone the wall clock is in. Defaults to the browser's local. */
  timeZone?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  block?: boolean;
  min?: number;
  max?: number;
  tokens: DateTimeShellTokens;
  fontStack: string;
}

export function DateTimeShell({
  id, name, label, value, onChange, timeZone,
  required, disabled, error, block, min, max,
  tokens, fontStack,
}: DateTimeShellProps) {
  const reactId = useId();
  const inputId = id ?? `dt-${reactId}`;
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  // Input stores a wall-clock string in the conference's timezone.
  const stringValue = Number.isFinite(value) ? instantToWallClock(value, tz) : "";
  const minStr = min !== undefined ? instantToWallClock(min, tz) : undefined;
  const maxStr = max !== undefined ? instantToWallClock(max, tz) : undefined;

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const wall = e.target.value;
    if (!wall) return;
    const ms = wallClockToInstant(wall, tz);
    if (Number.isFinite(ms)) onChange(ms);
  }

  return (
    <label htmlFor={inputId} style={{ display: "flex", flexDirection: "column", gap: 4, opacity: disabled ? 0.6 : 1 }}>
      {label && (
        <span style={{ fontSize: 13, fontWeight: 500, color: tokens.fg }}>
          {label}{required && <span style={{ color: tokens.borderDanger, marginLeft: 2 }}>*</span>}
        </span>
      )}
      <input
        id={inputId}
        name={name}
        type="datetime-local"
        value={stringValue}
        onChange={handleChange}
        min={minStr}
        max={maxStr}
        required={required}
        disabled={disabled}
        // The browser's spinner/picker decides minute granularity; 60s steps
        // align with how the calendar snaps drags (15 min) without forcing it.
        step={60}
        style={{
          border: `1px solid ${error ? tokens.borderDanger : tokens.border}`,
          borderRadius: 6,
          padding: "6px 10px",
          fontSize: 14,
          fontFamily: fontStack,
          background: tokens.bg,
          color: tokens.fg,
          width: block ?? true ? "100%" : undefined,
          boxSizing: "border-box",
          // Some browsers tint the picker icon based on color-scheme; the
          // page-level color-mode attribute we set on <html> handles that.
        }}
      />
      <span style={{ fontSize: 11, color: tokens.fgMuted }}>
        Times are in <strong>{tz}</strong>.
      </span>
      {error && <span style={{ fontSize: 12, color: tokens.borderDanger }}>{error}</span>}
    </label>
  );
}
