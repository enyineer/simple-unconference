import { useState } from "react";
import { Badge } from "../../design-system";

// Disclosure — a styled native <details>/<summary>. Keeps secondary content
// available but collapsed by default so the surrounding surface isn't a wall
// of text. `modOnly` adds the same "Moderator" pill the rules modal's Section
// header uses. Originally local to AssignmentRulesModal; lifted here so other
// surfaces (e.g. the by-hand placement author) share one implementation.
export function Disclosure({
  summary, children, modOnly, defaultOpen,
}: {
  summary: string;
  children: React.ReactNode;
  modOnly?: boolean;
  defaultOpen?: boolean;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  // Track open state so the chevron can rotate — native <details> doesn't let
  // us style the marker from inline styles alone. `defaultOpen` still seeds the
  // element's own `open` attribute so it works even before any toggle event.
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <details
      open={defaultOpen}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      style={{
        borderRadius: 8,
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      <summary
        style={{
          listStyle: "none",
          cursor: "pointer",
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1.3,
          userSelect: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            color: muted,
            fontSize: 11,
            transition: "transform .15s ease",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          ▸
        </span>
        {/* dangerouslySetInnerHTML avoided — the summary strings here may carry
            an HTML entity ("&amp;"); decode it for plain text rendering. */}
        <span style={{ flex: 1 }}>{summary.replace(/&amp;/g, "&")}</span>
        {modOnly && <Badge variant="attention">Moderator</Badge>}
      </summary>
      <div style={{ padding: "0 14px 14px" }}>
        {children}
      </div>
    </details>
  );
}
