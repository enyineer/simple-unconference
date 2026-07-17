// Header install affordance. A round icon-button next to the notification
// bell (mirrors BroadcastButton's styling) that either fires the native
// install prompt (Android/desktop Chromium) or, on iOS Safari, opens a short
// "Add to Home Screen" sheet. Renders nothing when the app is already
// installed or there's no install path (e.g. desktop Firefox). All the
// decision logic lives in the pure module behind useInstallPrompt.

import { useState } from "react";
import { Sheet, Stack, Text } from "../design-system";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { desktopInstallKind } from "../pwa/install";

export function InstallButton({ conferenceName }: { conferenceName: string }) {
  const { affordance, promptInstall } = useInstallPrompt();
  const [hintOpen, setHintOpen] = useState(false);

  if (affordance === "none") return null;

  const borderMuted = "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";
  const bgSubtle = "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))";
  const fgDefault = "var(--fgColor-default, var(--uncon-fg, inherit))";

  function onClick() {
    // Native prompt when we have one; otherwise open the platform hint
    // (iOS Add-to-Home-Screen, or the desktop "use your browser" steps).
    if (affordance === "prompt") promptInstall();
    else setHintOpen(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label="Install app"
        title="Install app"
        style={{
          appearance: "none",
          width: 32, height: 32, padding: 0,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          borderRadius: "50%",
          border: `1px solid ${borderMuted}`,
          background: bgSubtle,
          color: fgDefault,
          cursor: "pointer",
          transition: "border-color 120ms, background 120ms",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path
            d="M8 1.75v7.5m0 0 2.75-2.75M8 9.25 5.25 6.5"
            fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round"
          />
          <path
            d="M2.75 10.5v1.75a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V10.5"
            fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>

      <Sheet open={hintOpen} onClose={() => setHintOpen(false)} title="Install this app">
        {affordance === "ios-hint" ? (
          <IosInstallSteps conferenceName={conferenceName} />
        ) : affordance === "firefox-hint" ? (
          <FirefoxInstallSteps conferenceName={conferenceName} />
        ) : (
          <DesktopInstallSteps conferenceName={conferenceName} />
        )}
      </Sheet>
    </>
  );
}

// Desktop fallback steps: shown when the browser can install a web app but
// didn't hand us a `beforeinstallprompt` (Chrome fires it only heuristically).
// Detects the browser so it shows ONE clear path (not a list of every browser),
// pointing at that browser's own install control.
export function DesktopInstallSteps({ conferenceName }: { conferenceName: string }) {
  const kind =
    typeof navigator === "undefined" ? "chromium" : desktopInstallKind(navigator.userAgent);

  return (
    <Stack gap="condensed">
      <Text>
        Install <strong>{conferenceName}</strong> and it opens in its own window,
        launches from your dock, and can show notifications.
      </Text>
      {kind === "chromium" ? (
        <>
          <Text>
            Click the <strong>install icon</strong> at the right of the address
            bar &mdash; or open the browser menu (<strong>&#8942;</strong>) and
            choose <strong>Install {conferenceName}</strong>.
          </Text>
          <Text muted>
            Don&apos;t see the icon yet? Browsers reveal it after a moment on the
            page &mdash; give it a few seconds and check again.
          </Text>
        </>
      ) : (
        <Text>
          Open the <strong>Share</strong> menu in the Safari toolbar and choose{" "}
          <strong>Add to Dock</strong>.
        </Text>
      )}
    </Stack>
  );
}

// Firefox can't install web apps (Mozilla dropped that support), so there's no
// install path we can trigger. Instead of showing nothing, explain it and point
// at a browser that can. Shown from the header button only, never the nudge.
export function FirefoxInstallSteps({ conferenceName }: { conferenceName: string }) {
  return (
    <Stack gap="condensed">
      <Text>
        Firefox can&apos;t install web apps. To use <strong>{conferenceName}</strong>{" "}
        as its own app, open it in <strong>Chrome</strong>, <strong>Edge</strong>,
        or <strong>Safari</strong> and install it from there.
      </Text>
      <Text muted>
        In Firefox you can still bookmark this page (or pin the tab) to keep it
        one click away.
      </Text>
    </Stack>
  );
}

// The iOS "Add to Home Screen" walkthrough, reused by the header button's sheet
// and the nudge's expandable steps so the wording stays identical.
export function IosInstallSteps({ conferenceName }: { conferenceName: string }) {
  return (
    <Stack gap="condensed">
      <Text>
        On iPhone or iPad, add <strong>{conferenceName}</strong> to your Home
        Screen so it opens like an app:
      </Text>
      <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: "22px", color: "var(--fgColor-default, var(--uncon-fg, inherit))" }}>
        <li>Tap the <strong>Share</strong> button in Safari&apos;s toolbar.</li>
        <li>Choose <strong>Add to Home Screen</strong>.</li>
        <li>Tap <strong>Add</strong> to confirm.</li>
      </ol>
      <Text muted>
        This only works in Safari - other iOS browsers can&apos;t add apps to
        the Home Screen.
      </Text>
    </Stack>
  );
}
