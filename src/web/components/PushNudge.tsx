// Proactive, one-time "turn on notifications" callout. Web Push has a persistent
// on/off toggle in the notification bell (PushOptIn) that users easily miss, so
// this surfaces the ask prominently the first time. Dismissible, remembered per
// (conference, device) in localStorage (mirroring InstallNudge / WelcomeRail),
// and shown ONLY when push can actually be enabled. Defers to the install nudge
// so the two never stack — install first, since an installed app is the better
// (and, on iOS, the only) place for background push.
//
// "Whether to show" is the pure shouldShowPushNudge; the subscribe wiring is the
// shared usePushOptIn hook. This component just renders + remembers dismissal.

import { useState } from "react";
import { Button, Card, Stack, Text } from "../design-system";
import { usePushOptIn } from "../hooks/usePushOptIn";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { shouldShowNudge, shouldShowPushNudge } from "../pwa/install";

const STORAGE_PREFIX = "push-nudge:";
// InstallNudge's own dismissal key — read to tell whether it's currently showing.
const INSTALL_NUDGE_PREFIX = "install-nudge:";

function readDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function PushNudge({
  slug,
  conferenceName,
}: {
  slug: string;
  conferenceName: string;
}) {
  const { available, subscribed, denied, busy, enable } = usePushOptIn(slug);
  const { affordance } = useInstallPrompt();
  const storageKey = STORAGE_PREFIX + slug;
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed(storageKey));

  const installNudgeShowing = shouldShowNudge({
    affordance,
    dismissed: readDismissed(INSTALL_NUDGE_PREFIX + slug),
  });

  if (
    !shouldShowPushNudge({
      available: available === true,
      subscribed,
      denied,
      dismissed,
      installNudgeShowing,
    })
  ) {
    return null;
  }

  function dismiss() {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // Private mode / storage disabled — degrade to in-memory dismissal.
    }
    setDismissed(true);
  }

  const borderMuted = "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";
  const accent = "var(--fgColor-accent, var(--uncon-badge-primary-fg, #2563eb))";

  return (
    <div style={{ marginTop: 20 }}>
      <Card>
        <Stack gap="condensed">
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div
              aria-hidden
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                flex: "0 0 auto",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: accent,
                background: "var(--bgColor-accent-muted, rgba(64,132,246,0.12))",
                border: `1px solid ${borderMuted}`,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 1.75a3.75 3.75 0 0 0-3.75 3.75c0 2.2-.6 3.5-1.1 4.2-.26.36 0 .8.44.8h8.82c.44 0 .7-.44.44-.8-.5-.7-1.1-2-1.1-4.2A3.75 3.75 0 0 0 8 1.75Z"
                  stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
                />
                <path
                  d="M6.5 12.75a1.5 1.5 0 0 0 3 0"
                  stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
                />
              </svg>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 auto" }}>
              <div style={{ fontSize: 15, fontWeight: 600, lineHeight: "20px", wordBreak: "break-word" }}>
                Turn on notifications
              </div>
              <Text muted>
                Get announcements, schedule changes, and chat replies for{" "}
                {conferenceName} even when the app is closed.
              </Text>
            </div>
          </div>

          <Stack direction="row" gap="condensed" justify="end" align="center" wrap>
            <Button size="small" variant="invisible" onClick={dismiss} disabled={busy}>
              Not now
            </Button>
            <Button variant="primary" size="small" onClick={() => void enable()} disabled={busy}>
              Turn on
            </Button>
          </Stack>
        </Stack>
      </Card>
    </div>
  );
}
