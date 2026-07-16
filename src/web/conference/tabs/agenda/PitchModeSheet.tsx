// Pitch Mode control (mod-only). Lists published sessions newest-first with
// their star counts and a Spotlight button each. The spotlighted session shows
// large on the public Live Board, where people star it from their phones.
//
// The current spotlight comes from the server (`AgendaOut.spotlight_submission_id`
// via the parent's agenda data), so every moderator and device sees the real
// state. Setting/clearing writes through `api.agenda.spotlight` and refreshes
// the parent's data.

import { useState } from "react";
import { Button, Sheet, Stack, Text } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Submission } from "../../types";

const MUTED = "var(--fgColor-muted, var(--uncon-fg-muted, #6b7280))";
const BORDER = "var(--borderColor-default, var(--uncon-border, rgba(127,127,127,0.25)))";
const ACCENT = "var(--borderColor-accent-emphasis, var(--uncon-primary, #0969da))";
const ACCENT_BG = "var(--bgColor-accent-muted, rgba(64,132,246,0.12))";

export function PitchModeSheet({
  slug,
  open,
  onClose,
  subs,
  activeId,
  onChanged,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  subs: Submission[];
  /** The currently spotlighted submission (server truth via agenda.get). */
  activeId: number | null;
  /** Refetch the parent's agenda data after a spotlight change. */
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);

  const published = subs
    .filter((s) => s.status === "published")
    .sort((a, b) => b.created_at - a.created_at);

  async function spotlight(id: number | null, marker: number) {
    setBusyId(marker);
    try {
      await api.agenda.spotlight({ slug, submission_id: id });
      toast.success(id === null ? "Spotlight cleared." : "Session spotlighted on the board.");
      await onChanged();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusyId(null);
    }
  }

  const activeTitle = published.find((s) => s.id === activeId)?.title;

  return (
    <Sheet open={open} onClose={onClose} title="Pitch mode">
      <Stack gap="spacious">
        <Text muted>
          The spotlighted session appears large on the Live Board - people star it
          from their phones.
        </Text>

        {activeId !== null && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${ACCENT}`,
              background: ACCENT_BG,
            }}
          >
            <span style={{ minWidth: 0 }}>
              Spotlighting <strong>{activeTitle ?? "a session"}</strong>.
            </span>
            <Button size="small" onClick={() => spotlight(null, -1)} disabled={busyId !== null}>
              {busyId === -1 ? "Clearing…" : "Clear spotlight"}
            </Button>
          </div>
        )}

        {published.length === 0 ? (
          <Text muted>No published sessions yet. Publish a session to spotlight it.</Text>
        ) : (
          <Stack gap="condensed">
            {published.map((s) => {
              const active = s.id === activeId;
              return (
                <div
                  key={s.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: `1px solid ${active ? ACCENT : BORDER}`,
                    background: active ? ACCENT_BG : "transparent",
                  }}
                >
                  <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span
                      style={{
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.title}
                    </span>
                    <span style={{ fontSize: 12.5, color: MUTED }}>
                      {s.submitter_name ?? "Unknown"} · ★ {s.star_count}
                    </span>
                  </div>
                  <Button
                    size="small"
                    variant={active ? "default" : "primary"}
                    onClick={() => spotlight(s.id, s.id)}
                    disabled={busyId !== null || active}
                  >
                    {busyId === s.id ? "…" : active ? "On board" : "Spotlight"}
                  </Button>
                </div>
              );
            })}
          </Stack>
        )}
      </Stack>
    </Sheet>
  );
}
