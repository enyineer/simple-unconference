// App-wide toast notification system. Errors / successes / info messages
// surface as floating cards anchored to the bottom of the viewport (full
// width on mobile, bottom-right on wide screens) so they're visible no
// matter how far the user has scrolled away from the action that produced
// them.
//
// The previous pattern — a centralized banner at the top of each tab —
// disappeared off-screen for users scrolled to a deep action like the
// Danger zone, which made errors silently invisible. Toasts decouple
// feedback from page scroll position.
//
// Implementation: shared primitive (not per-plugin) so both design-system
// plugins surface toasts identically. CSS vars defined by whichever plugin
// is active drive the colors; the toast itself is markup + a tiny class.
//
// The `useToast` hook lives in a separate file (`./use-toast`) so this
// file can export only React components — keeping the
// react-refresh/only-export-components rule happy and the HMR boundary
// clean.

import {
  useCallback, useEffect, useInsertionEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ToastCtx, type Toast, type ToastApi, type ToastKind } from "./toast-context";

// Default time-to-live. Errors hang around longer because the user often
// has to scroll back, retry, or fix something. Success/info auto-dismiss
// faster — they're just acknowledgments.
const TTL_MS: Record<ToastKind, number> = {
  error: 8000,
  // Warnings carry actionable detail (assignment results, partial failures)
  // so they hang around as long as errors before auto-dismissing.
  warning: 8000,
  success: 5000,
  info: 5000,
};

const STYLE_ID = "uncon-toast";
const toastCss = `
.uncon-toast-stack {
  position: fixed;
  bottom: max(16px, env(safe-area-inset-bottom));
  right: max(16px, env(safe-area-inset-right));
  left: auto;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
  pointer-events: none;
}
@media (max-width: 640px) {
  .uncon-toast-stack {
    left: max(16px, env(safe-area-inset-left));
    right: max(16px, env(safe-area-inset-right));
    max-width: none;
  }
}
.uncon-toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bgColor-default, var(--uncon-bg, #ffffff));
  border: 1px solid var(--borderColor-default, var(--uncon-border, #d0d7de));
  border-left-width: 3px;
  border-left-color: currentColor;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 13px;
  line-height: 18px;
  animation: uncon-toast-in 160ms ease-out;
}
.uncon-toast-error   { color: var(--fgColor-danger,    var(--uncon-danger,  #cf222e)); }
.uncon-toast-warning { color: var(--fgColor-attention, var(--uncon-warning, #9a6700)); }
.uncon-toast-success { color: var(--fgColor-success,   var(--uncon-success, #1a7f37)); }
.uncon-toast-info    { color: var(--fgColor-accent,    var(--uncon-primary, #2563eb)); }
.uncon-toast-message {
  flex: 1;
  min-width: 0;
  color: var(--fgColor-default, var(--uncon-fg, inherit));
  word-break: break-word;
}
.uncon-toast-close {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--fgColor-muted, var(--uncon-fg-muted, #6e7781));
  font-size: 18px;
  line-height: 18px;
  padding: 0 2px;
  flex-shrink: 0;
}
.uncon-toast-close:hover,
.uncon-toast-close:focus-visible {
  color: var(--fgColor-default, var(--uncon-fg, inherit));
}
@keyframes uncon-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
`;

function useToastStyles() {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = toastCss;
    document.head.appendChild(el);
  }, []);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  useToastStyles();
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track per-toast dismiss timers so manual dismiss can cancel the pending
  // auto-dismiss (and so cleanup-on-unmount doesn't leak timers).
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const t = timers.current.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback((kind: ToastKind, message: string) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, kind, message }]);
    timers.current.set(id, setTimeout(() => dismiss(id), TTL_MS[kind]));
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    error: (m) => show("error", m),
    warning: (m) => show("warning", m),
    success: (m) => show("success", m),
    info: (m) => show("info", m),
    dismiss,
  }), [show, dismiss]);

  // Clean up timers if the provider itself unmounts (test teardown, HMR).
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const stack = (
    <div className="uncon-toast-stack" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      {typeof document !== "undefined" && createPortal(stack, document.body)}
    </ToastCtx.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  // Errors + warnings are announced assertively (interrupting the screen
  // reader) since they typically need immediate attention; success/info are
  // polite so they don't interrupt other narration.
  const urgent = toast.kind === "error" || toast.kind === "warning";
  return (
    <div
      className={`uncon-toast uncon-toast-${toast.kind}`}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
    >
      <span className="uncon-toast-message">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="uncon-toast-close"
      >
        ×
      </button>
    </div>
  );
}
