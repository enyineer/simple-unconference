// One-time, dismissible "install this conference as an app" callout. Mounted
// once in the conference shell (below the header, all tabs) so a first-time
// visitor doesn't miss that the conference is installable. Shows at most once
// per (conference, device) — dismissal is a localStorage flag, mirroring
// WelcomeRail's precedent — and only when installing is actually possible
// (a captured native prompt, iOS Safari, or a desktop browser that can install;
// and not already installed).
//
// All the "whether to show" logic comes from the pure module via
// useInstallPrompt + shouldShowNudge; this component only renders + remembers
// the dismissal.

import { useState } from "react";
import { Button, Card, Stack, Text } from "../design-system";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { appleTouchIconHref, shouldShowNudge } from "../pwa/install";
import { AndroidInstallSteps, DesktopInstallSteps, IosInstallSteps } from "./InstallButton";

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
  const [showSteps, setShowSteps] = useState(false);

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
    // Native prompt when captured; otherwise reveal the platform steps inline.
    if (affordance === "prompt") promptInstall();
    else setShowSteps(true);
  }

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  return (
    <div style={{ marginTop: 20 }}>
    <Card>
      <Stack gap="condensed">
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <img
            src={appleTouchIconHref(slug, iconHash)}
            alt=""
            width={40}
            height={40}
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              objectFit: "cover",
              flex: "0 0 auto",
              background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
              border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 auto" }}>
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: "20px", wordBreak: "break-word" }}>
              Install {conferenceName} as an app
            </div>
            <Text muted>
              Open it in its own window from your dock or home screen, and get
              notifications even when it isn&apos;t open.
            </Text>
          </div>
        </div>

        <Stack direction="row" gap="condensed" justify="end" align="center" wrap>
          <Button size="small" variant="invisible" onClick={dismiss}>
            Dismiss
          </Button>
          <Button variant="primary" size="small" onClick={onInstall}>
            Install
          </Button>
        </Stack>

        {showSteps && (
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
            {affordance === "ios-hint" ? (
              <IosInstallSteps conferenceName={conferenceName} />
            ) : affordance === "android-hint" ? (
              <AndroidInstallSteps conferenceName={conferenceName} />
            ) : (
              <DesktopInstallSteps conferenceName={conferenceName} />
            )}
          </div>
        )}
      </Stack>
    </Card>
    </div>
  );
}
