// Small rounded pill used for star counts, tags, requirements, room chips,
// etc. Variants — `default` (muted), `primary` (accent / blue), `success`
// (green, used for mixer assignments), and `attention` (amber, for required
// sessions / warnings).

import type { ReactNode } from "react";

export function Pill({
  children, variant = "default", wrap = false,
}: {
  children: ReactNode;
  variant?: "default" | "primary" | "success" | "attention";
  /** Allow the pill to wrap onto multiple lines. Off by default (short chips
   *  like "planned" / a star count stay on one line); turn ON for pills that
   *  carry long free text (a conflicting session title, a capacity warning) so
   *  they don't overflow their container on narrow screens. */
  wrap?: boolean;
}) {
  const bg = variant === "primary"
    ? "var(--bgColor-accent-muted, var(--uncon-badge-primary-bg, rgba(64,132,246,0.12)))"
    : variant === "success"
      ? "var(--bgColor-success-muted, rgba(26,127,55,0.12))"
      : variant === "attention"
        ? "var(--bgColor-attention-muted, rgba(212,167,44,0.18))"
        : "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.06)))";
  const fg = variant === "primary"
    ? "var(--fgColor-accent, var(--uncon-badge-primary-fg, #2563eb))"
    : variant === "success"
      ? "var(--fgColor-success, #1a7f37)"
      : variant === "attention"
        ? "var(--fgColor-attention, #9a6700)"
        : "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <span style={{
      display: "inline-block",
      maxWidth: "100%",
      padding: "1px 8px",
      borderRadius: wrap ? 10 : 999,
      fontSize: 11,
      fontWeight: 500,
      lineHeight: "16px",
      whiteSpace: wrap ? "normal" : "nowrap",
      overflowWrap: wrap ? "anywhere" : "normal",
      background: bg,
      color: fg,
    }}>
      {children}
    </span>
  );
}
