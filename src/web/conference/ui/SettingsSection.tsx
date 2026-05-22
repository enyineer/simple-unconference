// One settings card: title + description on the left, controls on the right
// on wide viewports, stacked on narrow ones. Matches GitHub-style settings
// pages — feels more like a configuration panel than a generic Card.

import { useInsertionEffect, type ReactNode } from "react";

// Inject a stylesheet once that drives the responsive grid. Pure inline
// styles can't express media queries, so the layout switches between two
// grid templates via a class. Below 640px the section stacks: the
// description sits above the controls (full width), instead of competing
// for a 280px column on a narrow screen.
const SETTINGS_STYLE_ID = "uncon-settings-section";
const settingsCss = `
.uncon-settings-section {
  display: grid;
  grid-template-columns: minmax(0, 280px) minmax(0, 1fr);
  gap: 16px 32px;
  padding: 20px;
  border-radius: 8px;
  border: 1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb));
  background: var(--bgColor-default, var(--uncon-bg, transparent));
}
@media (max-width: 640px) {
  .uncon-settings-section {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    padding: 16px;
  }
}
`;

function useSettingsStyles() {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(SETTINGS_STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = SETTINGS_STYLE_ID;
    el.textContent = settingsCss;
    document.head.appendChild(el);
  }, []);
}

export function SettingsSection({
  title, description, children, saved,
}: {
  title: string;
  description: string;
  children: ReactNode;
  /** When true, a brief animated checkmark appears next to the title to
   *  confirm a successful auto-save. Parent owns the lifetime (clear it
   *  after ~1.5s) so adjacent sections don't all light up at once. */
  saved?: boolean;
}) {
  useSettingsStyles();
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <div className="uncon-settings-section">
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <div style={{
          fontSize: 16, fontWeight: 600,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span>{title}</span>
          <SavedCheck show={saved ?? false} />
        </div>
        <div style={{ fontSize: 13, lineHeight: "18px", color: muted }}>{description}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}

// Animated checkmark used by the settings tab to confirm auto-saves. The
// `@keyframes` rule is injected once on first render so consumers don't have
// to wire anything up. We deliberately keep this self-contained (no design-
// system primitive) because it's tied to the settings card layout.
function SavedCheck({ show }: { show: boolean }) {
  return (
    <span
      aria-live="polite"
      aria-label={show ? "Saved" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18, height: 18,
        borderRadius: "50%",
        background: show
          ? "var(--bgColor-success-emphasis, #1a7f37)"
          : "transparent",
        color: "#fff",
        opacity: show ? 1 : 0,
        transform: show ? "scale(1)" : "scale(0.6)",
        transition:
          "opacity 180ms ease-out, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
        pointerEvents: "none",
      }}
    >
      <svg
        width={12} height={12} viewBox="0 0 16 16" aria-hidden
        style={{
          // Subtle stroke-draw on the check mark itself.
          strokeDasharray: 18,
          strokeDashoffset: show ? 0 : 18,
          transition: "stroke-dashoffset 260ms ease-out 80ms",
        }}
      >
        <path
          d="M3.5 8.5 L7 12 L13 5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
