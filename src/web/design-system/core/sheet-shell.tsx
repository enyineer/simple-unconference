// Shared Sheet implementation used by both plugins. The plugin gives us the
// background/text/border tokens (as CSS vars or hex), and we render the
// backdrop, focus container, escape handling, and a close button. Sheet panels
// slide in from the right on wide viewports and full-screen on narrow.

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface SheetShellTokens {
  bg: string;
  fg: string;
  fgMuted: string;
  border: string;
}

interface SheetShellProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  tokens: SheetShellTokens;
  children: ReactNode;
}

export function SheetShell({ open, onClose, title, tokens, children }: SheetShellProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    // Prevent body scroll while the sheet is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const node = (
    <div
      onClick={onClose}
      aria-modal="true"
      role="dialog"
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0, 0, 0, 0.45)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: tokens.bg,
          color: tokens.fg,
          width: "min(560px, 100vw)",
          maxWidth: "100vw",
          height: "100dvh",
          overflowY: "auto",
          boxShadow: "-8px 0 24px rgba(0, 0, 0, 0.18)",
          borderLeft: `1px solid ${tokens.border}`,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: `1px solid ${tokens.border}`,
          position: "sticky", top: 0,
          background: tokens.bg,
          zIndex: 1,
        }}>
          <strong style={{ fontSize: 16 }}>{title ?? ""}</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none", background: "transparent",
              color: tokens.fgMuted, cursor: "pointer",
              fontSize: 22, lineHeight: "22px", padding: 4,
            }}
          >×</button>
        </div>
        {/* Body laid out as a flex column with a default gap so consecutive
            top-level children (a Tip, a Banner, a Form, …) have consistent
            spacing without each call site needing to wrap them in a Stack. */}
        <div style={{
          padding: 16, flex: 1,
          display: "flex", flexDirection: "column", gap: 16,
          minHeight: 0,
        }}>{children}</div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
