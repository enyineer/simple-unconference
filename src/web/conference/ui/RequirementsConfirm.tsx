// Hook + sheet that gates "star this session" actions behind a requirements
// confirmation. Sessions/tracks can list prerequisites (laptop, GitHub account,
// etc.); when a user tries to add one to their schedule we want them to
// explicitly acknowledge they can meet those requirements.
//
// Usage:
//   const { request, modal } = useRequirementsConfirm();
//   ...
//   <button onClick={() => request({ title, requirements, onConfirm })} />
//   ...
//   {modal}
//
// `request` is a no-op pass-through when `requirements` is empty.

import { useState, type ReactNode } from "react";
import { Button, Sheet, Stack } from "../../design-system";
import { Tip } from "./Tip";

interface PendingConfirm {
  title: string;
  requirements: string[];
  onConfirm: () => void | Promise<void>;
}

export interface UseRequirementsConfirm {
  /** Trigger the confirmation flow. If requirements is empty, calls
   *  onConfirm() immediately. */
  request: (opts: {
    title: string;
    requirements: string[];
    onConfirm: () => void | Promise<void>;
  }) => void;
  /** Mount this once at the top of the component tree using the hook. */
  modal: ReactNode;
}

export function useRequirementsConfirm(): UseRequirementsConfirm {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [busy, setBusy] = useState(false);

  function request(opts: PendingConfirm) {
    if (opts.requirements.length === 0) {
      // Nothing to confirm — perform the action without UI.
      void opts.onConfirm();
      return;
    }
    setPending(opts);
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try { await pending.onConfirm(); }
    finally {
      setBusy(false);
      setPending(null);
    }
  }

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  const modal = (
    <Sheet
      open={pending !== null}
      onClose={() => { if (!busy) setPending(null); }}
      title="Confirm prerequisites"
    >
      <Tip>
        This session expects you to come prepared. Make sure you can meet
        the listed prerequisites before adding it to your schedule.
      </Tip>
      {pending && (
        <Stack gap="condensed">
          <div style={{
            padding: 12,
            borderRadius: 8,
            border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
            background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.03)))",
          }}>
            <div style={{
              fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
              textTransform: "uppercase", color: muted, marginBottom: 4,
            }}>
              Session
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: "20px", wordBreak: "break-word" }}>
              {pending.title}
            </div>
          </div>

          <div>
            <div style={{
              fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
              textTransform: "uppercase", color: muted, marginBottom: 6,
            }}>
              You&apos;ll need
            </div>
            <ul style={{
              listStyle: "none", padding: 0, margin: 0,
              display: "flex", flexDirection: "column", gap: 6,
            }}>
              {pending.requirements.map((r) => (
                <li
                  key={r}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    fontSize: 14, lineHeight: "20px",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 14, height: 14, flexShrink: 0,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      borderRadius: "50%",
                      background: "var(--bgColor-accent-muted, rgba(64,132,246,0.12))",
                      color: "var(--fgColor-accent, #2563eb)",
                      fontSize: 10, fontWeight: 700,
                    }}
                  >
                    ✓
                  </span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>

          <Stack direction="row" gap="condensed">
            <Button variant="primary" onClick={confirm} disabled={busy}>
              I meet these requirements
            </Button>
            <Button onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
          </Stack>
        </Stack>
      )}
    </Sheet>
  );

  return { request, modal };
}
