// Small inline tip — a gentle hint shown above a form field or group. Subtle
// bordered card with a stroked info icon. Keep children to one sentence; for
// anything longer (or higher-severity) use a Banner instead.

import type { ReactNode } from "react";

export function Tip({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 12px",
        borderRadius: 6,
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0, 0, 0, 0.025)))",
        fontSize: 12,
        lineHeight: "18px",
        color: "var(--fgColor-default, var(--uncon-fg, inherit))",
      }}
    >
      <svg
        width="14" height="14" viewBox="0 0 16 16" fill="none"
        aria-hidden
        style={{
          flex: "0 0 auto",
          marginTop: 2,
          color: "var(--fgColor-accent, var(--uncon-primary, #2563eb))",
        }}
      >
        <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.25" />
        <path d="M8 7v4.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="5" r="0.85" fill="currentColor" />
      </svg>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}
