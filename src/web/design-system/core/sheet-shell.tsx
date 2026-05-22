// Shared Sheet implementation used by both plugins. The plugin gives us the
// background/text/border tokens (as CSS vars or hex), and we render the
// backdrop, focus container, escape handling, and a close button. On wide
// viewports the sheet slides in from the right as a full-height drawer; on
// narrow viewports it sits at the bottom as a content-sized bottom sheet so
// short forms don't leave a massive empty void below the buttons.

import { useEffect, useInsertionEffect, type ReactNode } from "react";
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

// Pure-inline styles can't express media queries. Inject a stylesheet once
// that switches the panel between right-drawer (wide) and bottom-sheet
// (narrow). On narrow it sizes to content (max 92dvh) so short forms don't
// fill the screen with empty backdrop, and safe-area-inset-bottom is honored
// so the panel sits above the gesture/URL bar without leaving a gray strip.
const SHEET_STYLE_ID = "uncon-sheet-shell";
const sheetCss = `
.uncon-sheet-outer {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: flex-end;
  align-items: stretch;
}
.uncon-sheet-panel {
  width: min(560px, 100vw);
  max-width: 100vw;
  height: 100dvh;
  overflow: hidden;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
  border-left: 1px solid var(--uncon-sheet-border, transparent);
  display: flex;
  flex-direction: column;
}
.uncon-sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--uncon-sheet-border, transparent);
  flex-shrink: 0;
  padding-left: max(16px, env(safe-area-inset-left));
  padding-right: max(16px, env(safe-area-inset-right));
}
.uncon-sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  padding-left: max(20px, env(safe-area-inset-left));
  padding-right: max(20px, env(safe-area-inset-right));
  padding-bottom: max(40px, calc(env(safe-area-inset-bottom) + 24px));
}
@media (max-width: 640px) {
  .uncon-sheet-outer {
    align-items: flex-end;
    justify-content: stretch;
  }
  .uncon-sheet-panel {
    width: 100vw;
    height: auto;
    max-height: 92dvh;
    border-left: none;
    border-top-left-radius: 14px;
    border-top-right-radius: 14px;
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.24);
  }
  .uncon-sheet-body {
    flex: 0 1 auto;
  }
}
`;

function useSheetStyles() {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(SHEET_STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = SHEET_STYLE_ID;
    el.textContent = sheetCss;
    document.head.appendChild(el);
  }, []);
}

export function SheetShell({ open, onClose, title, tokens, children }: SheetShellProps) {
  useSheetStyles();
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

  // Border color is passed through a CSS custom property so the stylesheet
  // above can reference it without sacrificing per-plugin theming.
  const panelStyle = {
    background: tokens.bg,
    color: tokens.fg,
    ["--uncon-sheet-border" as string]: tokens.border,
  } as React.CSSProperties;

  const headerStyle = { background: tokens.bg } as React.CSSProperties;

  const node = (
    <div
      onClick={onClose}
      aria-modal="true"
      role="dialog"
      className="uncon-sheet-outer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="uncon-sheet-panel"
        style={panelStyle}
      >
        <div className="uncon-sheet-header" style={headerStyle}>
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
        {/* Body is the scrollable region. Flex column with a default gap so
            consecutive top-level children (a Tip, a Banner, a Form, …) have
            consistent spacing without each call site needing to wrap them
            in a Stack. The bottom padding includes safe-area-inset so the
            last action / paragraph has breathing room above the device's
            gesture bar or the browser's URL bar on iOS/Android. */}
        <div className="uncon-sheet-body">
          {children}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
