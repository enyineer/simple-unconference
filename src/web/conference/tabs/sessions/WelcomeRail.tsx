// Dismissible first-visit card for participants on the Sessions tab (mods
// have their own agenda-side OnboardingChecklist). Mirrors that component's
// localStorage-dismissal pattern so behavior stays consistent across the
// two rails.

import { useState } from "react";
import { Button, Card, Heading, Stack } from "../../../design-system";

const STORAGE_PREFIX = "welcome-rail:";

const STEPS = [
  "Sessions are proposed by everyone - including you.",
  "Star what you want to attend - stars literally build the schedule.",
  "Your day appears in the My schedule tab once seating runs.",
];

export function WelcomeRail({ slug }: { slug: string }) {
  const storageKey = STORAGE_PREFIX + slug;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  function dismiss() {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // Private mode / storage disabled — degrade to in-memory dismissal.
    }
    setDismissed(true);
  }

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  return (
    <Card>
      <Stack gap="condensed">
        <Stack direction="row" justify="between" align="center">
          <Heading level={3}>New to unconferences?</Heading>
          <Button size="small" variant="invisible" onClick={dismiss}>
            Dismiss
          </Button>
        </Stack>
        <Stack gap="condensed">
          {STEPS.map((step, i) => (
            <div
              key={step}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
                background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.025)))",
              }}
            >
              <span
                aria-hidden
                style={{
                  flex: "0 0 auto",
                  marginTop: 1,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 700,
                  color: muted,
                  border: "1.5px solid var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
                }}
              >
                {i + 1}
              </span>
              <div style={{ minWidth: 0, flex: 1, fontSize: 13, lineHeight: "19px" }}>
                {step}
              </div>
            </div>
          ))}
        </Stack>
      </Stack>
    </Card>
  );
}
