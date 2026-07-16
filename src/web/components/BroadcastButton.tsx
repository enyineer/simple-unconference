// Mod-only day-of broadcast. A megaphone button in the conference header
// opens a small sheet with one textarea; sending fans the message out as an
// `announcement` notification to every conference identity (server side).
// Deliberately spartan — one field, a live counter, and a single send action
// with confirm-by-click (no second dialog). Use sparingly is the whole point,
// so the copy says so rather than adding friction.

import { useState } from "react";
import { Button, Sheet, Stack, Textarea } from "../design-system";
import { useToast } from "../design-system/hooks";
import { api, errorCode } from "../api";

const MAX_LEN = 300;

export function BroadcastButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const toast = useToast();

  const trimmed = message.trim();
  const overLimit = message.length > MAX_LEN;
  const canSend = trimmed.length > 0 && !overLimit && !sending;

  function close() {
    if (sending) return;
    setOpen(false);
    setMessage("");
  }

  async function send() {
    if (!canSend) return;
    setSending(true);
    try {
      await api.announcements.send({ slug, message: trimmed });
      toast.success("Announcement sent to everyone.");
      setOpen(false);
      setMessage("");
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setSending(false);
    }
  }

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const borderMuted = "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";
  const bgSubtle = "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))";
  const fgDefault = "var(--fgColor-default, var(--uncon-fg, inherit))";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send announcement"
        title="Send announcement"
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
            d="M12.5 2.5 5 5.5H3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h.7l.9 3.2a1 1 0 0 0 1 .8h.8a1 1 0 0 0 1-1.2L7.5 9.9l5 2.6a.6.6 0 0 0 .9-.5v-9a.6.6 0 0 0-.9-.5Z"
            fill="currentColor"
          />
        </svg>
      </button>

      <Sheet open={open} onClose={close} title="Send an announcement">
        <Stack gap="condensed">
          <Textarea
            label="Message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder="e.g. Lunch is served in the atrium — sessions resume at 14:00."
            block
          />
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 8, flexWrap: "wrap",
          }}>
            <span style={{ fontSize: 12, color: muted }}>
              Sends a notification to every participant — use sparingly.
            </span>
            <span style={{
              fontSize: 12, fontVariantNumeric: "tabular-nums",
              color: overLimit ? "var(--fgColor-danger, #cf222e)" : muted,
            }}>
              {message.length}/{MAX_LEN}
            </span>
          </div>
          <Stack direction="row" gap="condensed">
            <Button variant="primary" onClick={send} disabled={!canSend}>
              {sending ? "Sending…" : "Send announcement"}
            </Button>
            <Button onClick={close} disabled={sending}>Cancel</Button>
          </Stack>
        </Stack>
      </Sheet>
    </>
  );
}
