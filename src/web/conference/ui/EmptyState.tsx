// Dashed-border empty-state tile. Used for "no sessions / no rooms / nothing
// scheduled yet" placeholders so the layout doesn't look broken when a tab
// has no content.

import type { ReactNode } from "react";

export function EmptyState({
  message,
  action,
}: {
  message: string;
  /** Optional CTA rendered below the message (e.g. "Clear filters"). */
  action?: ReactNode;
}) {
  return (
    <div style={{
      padding: 24,
      borderRadius: 8,
      border: "1px dashed var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
      color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
      fontSize: 13,
      textAlign: "center",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 12,
    }}>
      <div>{message}</div>
      {action}
    </div>
  );
}
