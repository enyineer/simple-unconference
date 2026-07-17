// One-time, dismissible "install this conference as an app" callout. Mounted
// once in the conference shell (below the header, all tabs) so a first-time
// visitor doesn't miss that the conference is installable. Shows at most once
// per (conference, device) — dismissal is a localStorage flag, mirroring
// WelcomeRail's precedent — and only when installing is actually possible
// (a captured native prompt OR iOS Safari, and not already installed).
//
// All the "whether to show" logic comes from the pure module via
// useInstallPrompt + shouldShowNudge; this component only renders + remembers
// the dismissal.

import { useState } from "react";
import { Button, Card, Heading, Stack, Text } from "../design-system";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { appleTouchIconHref, shouldShowNudge } from "../pwa/install";
import { IosInstallSteps } from "./InstallButton";

const STORAGE_PREFIX = "install-nudge:";

export function InstallNudge({
  slug,
  conferenceName,
  iconHash,
}: {
  slug: string;
  conferenceName: string;
  iconHash: string | null;
}) {
  const { affordance, promptInstall } = useInstallPrompt();
  const storageKey = STORAGE_PREFIX + slug;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const [showIosSteps, setShowIosSteps] = useState(false);

  if (!shouldShowNudge({ affordance, dismissed })) return null;

  function dismiss() {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // Private mode / storage disabled — degrade to in-memory dismissal.
    }
    setDismissed(true);
  }

  function onInstall() {
    if (affordance === "prompt") promptInstall();
    else setShowIosSteps(true);
  }

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  return (
    <Card>
      <Stack gap="condensed">
        <Stack direction="row" gap="normal" align="center" justify="between">
          <Stack direction="row" gap="normal" align="center">
            <img
              src={appleTouchIconHref(slug, iconHash)}
              alt=""
              width={44}
              height={44}
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                objectFit: "cover",
                flex: "0 0 auto",
                background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
                border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
              }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <Heading level={3}>Install {conferenceName} as an app</Heading>
              <Text muted>
                Open it straight from your home screen and get notifications.
              </Text>
            </div>
          </Stack>
          <Button size="small" variant="invisible" onClick={dismiss}>
            Dismiss
          </Button>
        </Stack>

        <Stack direction="row" gap="condensed" wrap>
          <Button variant="primary" size="small" onClick={onInstall}>
            Install
          </Button>
        </Stack>

        {showIosSteps && (
          <div
            style={{
              marginTop: 4,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
              background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.025)))",
              color: muted,
            }}
          >
            <IosInstallSteps conferenceName={conferenceName} />
          </div>
        )}
      </Stack>
    </Card>
  );
}
