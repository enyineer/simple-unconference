import { useEffect, useState } from "react";
import { useToast } from "../../../design-system/hooks";
import { Spinner } from "../../../design-system";
import { api, errorCode } from "../../../api";
import { CopyButton } from "../../ui/CopyButton";

// ---------------------------------------------------------------------------
// Subscribe-in-your-calendar card. One URL per user that works across every
// conference they're in — calendar apps subscribe and poll on their own.

export function CalendarSubscribe({ slug }: { slug: string }) {
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.conferences.getCalendar({ slug })
      .then((r) => setPath(r.path))
      .catch((e: unknown) => toast.error(errorCode(e)));
  }, [slug, toast]);

  const url = path ? `${window.location.origin}${path}` : "";
  // webcal:// scheme makes most native calendar apps offer one-click subscribe
  // on link click (Apple Calendar, Outlook, Thunderbird, Chrome Android).
  // Firefox Android deliberately blocks dispatch of non-allowlisted schemes
  // to external apps (Mozilla policy, not a per-device bug), so the click is
  // silently dropped there. Serving https:// instead would just download a
  // one-time .ics snapshot — losing the auto-update behavior promised by
  // the panel — so we show paste-by-URL instructions on Firefox Android
  // rather than a button that imports without subscribing.
  const isFirefoxAndroid = typeof navigator !== "undefined"
    && /Firefox/.test(navigator.userAgent)
    && /Android/.test(navigator.userAgent);
  const webcalUrl = path
    ? `webcal://${window.location.host}${path}`
    : "";

  async function reset() {
    if (!confirm("Generate a new link? Any calendar app currently subscribed will stop syncing until you give it the new URL.")) return;
    setBusy(true);
    try {
      const r = await api.conferences.resetCalendar({ slug });
      setPath(r.path);
    } catch (e) {
      toast.error(errorCode(e));
    } finally { setBusy(false); }
  }

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  // Compact calendar glyph drawn inline so we don't depend on an icon library.
  const icon = (
    <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden style={{ color: muted }}>
      <rect x="1.75" y="3" width="12.5" height="11.25" rx="1.5"
        fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.75 6.5 H14.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 1.5 V4.25 M11 1.5 V4.25"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );

  return (
    <div style={{
      padding: 16,
      borderRadius: 10,
      border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
      background: "var(--bgColor-default, var(--uncon-bg, transparent))",
    }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: "0 12px",
      }}>
        <div style={{ paddingTop: 1 }}>{icon}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14, lineHeight: "20px" }}>Sync to your calendar</strong>
            <span style={{ fontSize: 12, color: muted }}>
              iCalendar feed · updates automatically
            </span>
          </div>
          <div style={{ fontSize: 13, color: muted, marginTop: 2 }}>
            Subscribe in Apple Calendar, Google Calendar, Outlook, Thunderbird, or any iCal app.
          </div>

          {!path ? (
            <div style={{ marginTop: 12 }}><Spinner label="Loading…" /></div>
          ) : (
            <>
              {/* URL field with an inline Copy affordance on the right —
                  visually one element so the action is right where the URL is. */}
              <div style={{
                display: "flex", alignItems: "stretch",
                marginTop: 12,
                border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
                borderRadius: 8,
                background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.03)))",
                overflow: "hidden",
              }}>
                <input
                  type="text"
                  value={url}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Subscription URL"
                  style={{
                    flex: 1, minWidth: 0,
                    padding: "8px 10px",
                    border: "none",
                    background: "transparent",
                    color: "var(--fgColor-default, var(--uncon-fg, inherit))",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 12,
                    outline: "none",
                  }}
                />
                <CopyButton
                  variant="inset"
                  value={url}
                  disabled={busy}
                  successMessage="Calendar subscription URL copied."
                  fallbackPromptLabel="Copy this calendar subscription URL:"
                />
              </div>

              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 8, marginTop: 10, flexWrap: "wrap",
              }}>
                {isFirefoxAndroid ? (
                  // Firefox for Android can't launch external apps from
                  // webcal:// links, and importing the https:// .ics would
                  // be a one-time snapshot — not the subscription this
                  // panel promises. So instead of a broken/misleading
                  // button, tell the user how to subscribe manually using
                  // the URL above.
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      color: muted,
                      lineHeight: "16px",
                    }}
                  >
                    Firefox for Android can&apos;t open calendar links
                    directly. Copy the URL above and paste it into your
                    calendar app&apos;s &quot;Add by URL&quot; / &quot;Add
                    subscription&quot; setting to subscribe with
                    auto-updates.
                  </div>
                ) : (
                  // Rendered as a real anchor (not a button calling
                  // `window.location.assign`) so the browser treats the
                  // click as a normal link navigation. The webcal:// scheme
                  // is dispatched to the OS intent resolver, which hands
                  // off to Apple Calendar / Outlook / Google Calendar etc.
                  <a
                    href={webcalUrl}
                    aria-disabled={busy || undefined}
                    style={{
                      display: "inline-block",
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: "1px solid rgba(27,31,36,0.15)",
                      background: busy
                        ? "var(--bgColor-disabled, var(--uncon-bg-subtle, #6e7781))"
                        : "var(--button-primary-bgColor-rest, var(--bgColor-success-emphasis, #1f883d))",
                      color: "var(--button-primary-fgColor-rest, #ffffff)",
                      fontFamily: "inherit",
                      fontSize: 12,
                      fontWeight: 600,
                      lineHeight: "20px",
                      textDecoration: "none",
                      cursor: busy ? "default" : "pointer",
                      pointerEvents: busy ? "none" : undefined,
                    }}
                  >
                    Open in calendar app
                  </a>
                )}
                <button
                  type="button"
                  onClick={reset}
                  disabled={busy}
                  style={{
                    background: "transparent", border: "none", padding: 0,
                    color: muted,
                    fontFamily: "inherit", fontSize: 12,
                    cursor: busy ? "default" : "pointer",
                    textDecoration: "underline",
                  }}
                  title="Generate a new URL and revoke this one"
                >
                  Reset link
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
