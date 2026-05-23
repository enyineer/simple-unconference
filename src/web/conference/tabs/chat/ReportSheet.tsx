// Modal sheet for reporting a chat message. Submits to chat.reportMessage
// with a free-text reason; closes on success.

import { useState } from "react";
import { api } from "../../../api";
import { Button, Sheet, Textarea } from "../../../design-system";

interface ReportSheetProps {
  slug: string;
  messageId: number;
  onClose: () => void;
}

export function ReportSheet({ slug, messageId, onClose }: ReportSheetProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function submit() {
    if (!reason.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.chat.reportMessage({ slug, message_id: messageId, reason: reason.trim() });
      setSubmitted(true);
      setTimeout(onClose, 1500);
    } catch {
      setError("Couldn't submit the report. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title="Report message">
      {submitted ? (
        <div style={{ padding: 24, textAlign: "center" }}>
          Thanks. Moderators have been notified.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
          <p style={{ fontSize: 14, color: "var(--fgColor-muted)" }}>
            Tell moderators why this message violates the conference&apos;s
            conduct rules. Your name is shared with moderators.
          </p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value.slice(0, 500))}
            rows={4}
            placeholder="What's wrong with this message?"
          />
          <div style={{ fontSize: 11, color: "var(--fgColor-muted)" }}>
            {500 - reason.length} characters left
          </div>
          {error && (
            <div style={{ color: "var(--fgColor-danger, #cf222e)", fontSize: 13 }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => void submit()}
              disabled={submitting || reason.trim().length === 0}
            >
              Send report
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
