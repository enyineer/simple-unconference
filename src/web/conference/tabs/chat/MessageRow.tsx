// One message bubble. Sender-aligned right, receiver-aligned left.
// Kebab menu exposes Edit/Delete (own messages, within edit window) and
// Report (others' messages).

import { useState } from "react";
import { useNow } from "../../../useNow";
import type { MessageOut } from "./ConversationView";

interface MessageRowProps {
  message: MessageOut;
  slug: string;
  isMe: boolean;
  // True when previous message is from same sender within 5 min — drops
  // the avatar + name affordance for tighter visual grouping.
  groupedWithPrev: boolean;
  onReport: (messageId: number) => void;
  onEdit: (messageId: number, body: string) => Promise<void>;
  onDelete: (messageId: number) => Promise<void>;
}

const EDIT_WINDOW_MS = 15 * 60_000;

export function MessageRow({
  message, slug, isMe, groupedWithPrev, onReport, onEdit, onDelete,
}: MessageRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.body ?? "");
  const now = useNow();
  const isDeleted = message.deleted_at !== null;
  const canEdit = isMe && !isDeleted && (now - message.created_at < EDIT_WINDOW_MS);
  const canDelete = isMe && !isDeleted;
  const canReport = !isMe && !isDeleted;

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexDirection: isMe ? "row-reverse" : "row",
        // flex-start so the avatar sits next to the bubble itself, not next
        // to the timestamp/meta row below it.
        alignItems: "flex-start",
        marginTop: groupedWithPrev ? 0 : 6,
      }}
    >
      {!groupedWithPrev && !isMe && (
        <img
          src={`/api/avatars/${encodeURIComponent(slug)}/${message.sender_identity_id}`}
          alt=""
          width={28} height={28}
          style={{ borderRadius: "50%", flexShrink: 0 }}
        />
      )}
      {groupedWithPrev && !isMe && <div style={{ width: 28, flexShrink: 0 }} />}

      <div style={{ maxWidth: "70%", display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
        <div
          style={{
            background: isDeleted
              ? "transparent"
              : (isMe
                ? "var(--bgColor-accent-emphasis, #2563eb)"
                : "var(--bgColor-muted, #f0f0f0)"),
            color: isDeleted
              ? "var(--fgColor-muted, #6e7781)"
              : (isMe ? "white" : "var(--fgColor-default)"),
            borderRadius: 12,
            padding: isDeleted ? "4px 0" : "8px 12px",
            fontSize: 14,
            wordBreak: "break-word",
            fontStyle: isDeleted ? "italic" : "normal",
          }}
        >
          {isDeleted ? (
            <span>Message removed</span>
          ) : editing ? (
            <div style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                style={{
                  minWidth: 200, minHeight: 40, fontSize: 14,
                  background: "white", color: "black",
                  border: "1px solid white", borderRadius: 8,
                  padding: 6, resize: "vertical",
                }}
              />
              <button
                type="button"
                onClick={async () => {
                  await onEdit(message.id, editValue);
                  setEditing(false);
                }}
                style={{
                  padding: "4px 10px", borderRadius: 6, fontSize: 12,
                  background: "white", color: "var(--fgColor-accent, #2563eb)",
                  border: 0, cursor: "pointer",
                }}
              >Save</button>
              <button
                type="button"
                onClick={() => { setEditing(false); setEditValue(message.body ?? ""); }}
                style={{
                  padding: "4px 10px", borderRadius: 6, fontSize: 12,
                  background: "transparent", color: "white",
                  border: "1px solid white", cursor: "pointer",
                }}
              >Cancel</button>
            </div>
          ) : (
            <span>{message.body}</span>
          )}
        </div>
        <div style={{
          display: "flex", gap: 6, alignItems: "center",
          fontSize: 10, color: "var(--fgColor-muted, #6e7781)",
          marginTop: 2,
        }}>
          <span>{formatTime(message.created_at)}</span>
          {message.edited_at !== null && !isDeleted && <span>(edited)</span>}
          {isMe && message.read_at !== null && !isDeleted && <span>· Read</span>}
          {(canEdit || canDelete || canReport) && !editing && (
            <div style={{ position: "relative", display: "inline-block" }}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Message options"
                style={{
                  background: "transparent", border: 0, cursor: "pointer",
                  padding: 2, color: "var(--fgColor-muted)", fontSize: 12,
                }}
              >⋯</button>
              {menuOpen && (
                <div style={{
                  position: "absolute",
                  bottom: "100%",
                  [isMe ? "right" : "left"]: 0,
                  background: "var(--bgColor-default, white)",
                  border: "1px solid var(--borderColor-default, #d0d7de)",
                  borderRadius: 8,
                  padding: 4,
                  display: "flex",
                  flexDirection: "column",
                  zIndex: 10,
                  minWidth: 120,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                }}>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => { setEditing(true); setMenuOpen(false); }}
                      style={menuItemStyle()}
                    >Edit</button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => { void onDelete(message.id); setMenuOpen(false); }}
                      style={{ ...menuItemStyle(), color: "var(--fgColor-danger, #cf222e)" }}
                    >Delete</button>
                  )}
                  {canReport && (
                    <button
                      type="button"
                      onClick={() => { onReport(message.id); setMenuOpen(false); }}
                      style={{ ...menuItemStyle(), color: "var(--fgColor-attention, #9a6700)" }}
                    >Report</button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function menuItemStyle(): React.CSSProperties {
  return {
    background: "transparent",
    border: 0,
    cursor: "pointer",
    padding: "6px 10px",
    textAlign: "left",
    fontSize: 13,
    color: "var(--fgColor-default)",
    borderRadius: 4,
  };
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
