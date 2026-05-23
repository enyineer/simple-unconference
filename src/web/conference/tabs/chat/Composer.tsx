// Multiline composer for the chat view. Enter sends; Shift+Enter inserts
// newline. Shows a character counter as you approach the 4096-char limit.
// Disabled state renders an inline reason instead of the textarea.

import { useRef, useState } from "react";
import { Button } from "../../../design-system";

const MAX_CHARS = 4096;

interface ComposerProps {
  slug: string;
  disabled: boolean;
  disabledReason: string | null;
  onSend: (body: string) => Promise<{ ok: true } | { error: string }>;
}

export function Composer({ slug, disabled, disabledReason, onSend }: ComposerProps) {
  // slug retained for future affordances (e.g. emoji-picker linking to
  // conference assets); currently unused.
  void slug;
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  if (disabled) {
    return (
      <div style={{
        padding: 12,
        borderTop: "1px solid var(--borderColor-muted, #e5e7eb)",
        color: "var(--fgColor-muted, #6e7781)",
        fontSize: 13,
        textAlign: "center",
        fontStyle: "italic",
      }}>
        {disabledReason ?? "Sending disabled"}
      </div>
    );
  }

  async function trySend() {
    const body = value.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await onSend(body);
      if ("ok" in res) {
        setValue("");
      } else {
        setError(humanError(res.error));
      }
    } finally {
      setSending(false);
      // Textarea is `disabled` while sending, which strips focus. Restore it
      // after React re-enables the element so the user can keep typing.
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void trySend();
    }
  }

  const remaining = MAX_CHARS - value.length;
  return (
    <div style={{
      borderTop: "1px solid var(--borderColor-muted, #e5e7eb)",
      padding: 8,
      display: "flex",
      gap: 8,
      flexDirection: "column",
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, MAX_CHARS))}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Type a message…"
          style={{
            flex: 1,
            resize: "vertical",
            minHeight: 40,
            maxHeight: 200,
            padding: 8,
            border: "1px solid var(--borderColor-default, #d0d7de)",
            borderRadius: 8,
            fontSize: 14,
            background: "var(--bgColor-default, white)",
            color: "var(--fgColor-default)",
          }}
          disabled={sending}
        />
        <Button
          variant="primary"
          onClick={() => void trySend()}
          disabled={sending || value.trim().length === 0}
        >
          Send
        </Button>
      </div>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        fontSize: 11,
        color: error ? "var(--fgColor-danger, #cf222e)" : "var(--fgColor-muted, #6e7781)",
      }}>
        <span>{error ?? "Enter to send · Shift+Enter for newline"}</span>
        {remaining < 200 && <span>{remaining} left</span>}
      </div>
    </div>
  );
}

function humanError(code: string): string {
  switch (code) {
    case "message_too_long": return "Message is too long.";
    case "chat_banned": return "You're banned from chatting in this conference.";
    case "chat_disabled": return "The recipient has chat turned off.";
    case "blocked": return "You can't message this user.";
    case "rate_limited": return "You're sending too fast — slow down a moment.";
    default: return "Couldn't send. Try again.";
  }
}
