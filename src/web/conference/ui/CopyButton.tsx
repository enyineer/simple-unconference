// Shared copy-to-clipboard button used everywhere the app exposes a
// shareable URL (join link, invite link, calendar feed, …).
//
// Two layered affordances confirm the action:
//   - inline label change ("Copy" → "✓ Copied") for 1.5s,
//   - toast `success` so the confirmation is consistent with every other
//     user-facing action in the app.
//
// When the clipboard API is unavailable (older browsers, insecure context),
// we fall back to a native `prompt()` with the value preselected and still
// fire a toast so the user gets the same shape of feedback they would on a
// successful copy.

import { useState } from "react";
import { useToast } from "../../design-system/hooks";

interface CopyButtonProps {
  /** The text to put on the clipboard. */
  value: string;
  /** Visible label before a copy (default: "Copy"). */
  label?: string;
  /** Visible label for ~1.5s after a successful copy (default: "✓ Copied"). */
  copiedLabel?: string;
  /** Toast text on success (default: "Copied to clipboard"). */
  successMessage?: string;
  /** Prompt label shown when the clipboard API is blocked. The value is
   *  pre-selected so the user can copy it manually. */
  fallbackPromptLabel?: string;
  /** Disable the button (e.g. while a parent operation is in-flight). */
  disabled?: boolean;
  /** Visual variant. "inset" matches the in-input chip used by the
   *  iCal-subscribe panel; "inline" is a standalone pill-style button used
   *  beside an invite list / settings row. */
  variant?: "inline" | "inset";
}

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "✓ Copied",
  successMessage = "Copied to clipboard.",
  fallbackPromptLabel,
  disabled,
  variant = "inline",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success(successMessage);
    } catch {
      // Clipboard blocked (insecure context / Safari permission denial /
      // older browsers). The native prompt gives the user a selectable
      // copy of the value so the affordance still works.
      window.prompt(fallbackPromptLabel ?? "Copy this:", value);
    }
  }

  if (variant === "inset") {
    // Right-aligned chip inside an inline input row. Matches the calendar-
    // subscribe panel: square left edge with a vertical divider so it reads
    // as part of the input container.
    return (
      <button
        type="button"
        onClick={copy}
        disabled={disabled || !value}
        style={{
          flex: "0 0 auto",
          padding: "0 12px",
          border: "none",
          borderLeft: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
          background: "var(--bgColor-default, var(--uncon-bg, #fff))",
          color: copied
            ? "var(--fgColor-success, #1a7f37)"
            : "var(--fgColor-default, var(--uncon-fg, inherit))",
          fontFamily: "inherit",
          fontSize: 12,
          fontWeight: 600,
          cursor: disabled ? "default" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {copied ? copiedLabel : label}
      </button>
    );
  }
  // Standalone pill button. Sized to sit alongside other small text actions.
  return (
    <button
      type="button"
      onClick={copy}
      disabled={disabled || !value}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 10px",
        borderRadius: 6,
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
        color: copied
          ? "var(--fgColor-success, #1a7f37)"
          : "var(--fgColor-default, var(--uncon-fg, inherit))",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
