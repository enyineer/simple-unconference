// Sheet for self-service session switching in an unconference slot. Lists
// every placed submission with its remaining capacity; the user picks one
// to lock themselves into. Their current pick (if any) is highlighted and
// can be unlocked.

import { useState } from "react";
import { Banner, Button, Sheet, Stack, Text } from "../../design-system";
import { api, ApiError } from "../../api";
import type { Room, Submission } from "../types";
import { Tip } from "./Tip";
import { useRequirementsConfirm } from "./RequirementsConfirm";

interface Placement {
  slot_id: number;
  submission_id: number;
  room_id: number;
  attendee_count: number;
}

export function SessionPicker({
  open, onClose, slug, slotId, placements, subs, rooms,
  currentSubmissionId, onChanged,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  slotId: number;
  /** Only the placements for this slot. */
  placements: Placement[];
  subs: Submission[];
  rooms: Room[];
  /** The user's current pick — highlighted and locked-in chip shown. */
  currentSubmissionId: number | null;
  /** Called after a successful PUT/DELETE so the parent can refresh. */
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const subById = new Map(subs.map((s) => [s.id, s]));
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  const requirementsConfirm = useRequirementsConfirm();

  async function pick(submissionId: number) {
    // Run the actual switch through the server. Wrapped so the requirements
    // confirmation can defer + call this on user OK.
    const doPick = async () => {
      setBusyId(submissionId);
      try {
        await api.agenda.pickAssignment({ slug, slot_id: slotId, submission_id: submissionId });
        await onChanged();
        onClose();
      } catch (e) {
        if (e instanceof ApiError && e.message === "session_full") {
          setError("That session just filled up. Pick another.");
        } else {
          setError(e instanceof ApiError ? e.message : "error");
        }
      } finally {
        setBusyId(null);
      }
    };
    setError(null);
    const sub = subById.get(submissionId);
    requirementsConfirm.request({
      title: sub?.title ?? "Session",
      requirements: sub?.requirements ?? [],
      onConfirm: doPick,
    });
  }

  async function unlock() {
    setError(null);
    try {
      await api.agenda.unpickAssignment({ slug, slot_id: slotId });
      await onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "error");
    }
  }

  // Sort: current pick first, then placements with remaining capacity, then full ones.
  const items = [...placements].sort((a, b) => {
    if (a.submission_id === currentSubmissionId) return -1;
    if (b.submission_id === currentSubmissionId) return 1;
    const ra = remainingFor(a, roomById);
    const rb = remainingFor(b, roomById);
    return (rb > 0 ? 1 : 0) - (ra > 0 ? 1 : 0);
  });

  return (
    <>
    {requirementsConfirm.modal}
    <Sheet open={open} onClose={onClose} title="Pick a session">
      <Tip>
        Your pick is locked in — moderators re-running assignment won&apos;t move you out.
        Sessions that are already full are dimmed.
      </Tip>
      {error && <Banner variant="critical">{error}</Banner>}
      <Stack gap="condensed">
        {items.length === 0 ? (
          <Text muted>No sessions are placed in this slot yet.</Text>
        ) : (
          items.map((p) => {
            const sub = subById.get(p.submission_id);
            const room = roomById.get(p.room_id);
            const capacity = room?.capacity ?? 0;
            const remaining = Math.max(0, capacity - p.attendee_count);
            const isCurrent = p.submission_id === currentSubmissionId;
            const isFull = !isCurrent && remaining <= 0;
            return (
              <PickCard
                key={p.submission_id}
                title={sub?.title ?? `#${p.submission_id}`}
                speaker={sub?.submitter_name ?? null}
                roomName={room?.name ?? "?"}
                remaining={remaining}
                capacity={capacity}
                isCurrent={isCurrent}
                isFull={isFull}
                busy={busyId === p.submission_id}
                onPick={() => pick(p.submission_id)}
              />
            );
          })
        )}
      </Stack>
      {currentSubmissionId !== null && (
        <Stack direction="row" gap="condensed">
          <Button variant="invisible" onClick={unlock}>Unlock my pick</Button>
        </Stack>
      )}
    </Sheet>
    </>
  );
}

function remainingFor(p: Placement, roomById: Map<number, Room>): number {
  const cap = roomById.get(p.room_id)?.capacity ?? 0;
  return Math.max(0, cap - p.attendee_count);
}

function PickCard({
  title, speaker, roomName, remaining, capacity,
  isCurrent, isFull, busy, onPick,
}: {
  title: string;
  speaker: string | null;
  roomName: string;
  remaining: number;
  capacity: number;
  isCurrent: boolean;
  isFull: boolean;
  busy: boolean;
  onPick: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const accent = isCurrent
    ? "var(--borderColor-accent-emphasis, #0969da)"
    : "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr auto",
      gap: "4px 12px",
      padding: 12,
      borderRadius: 8,
      border: `1px solid ${accent}`,
      background: isCurrent
        ? "var(--bgColor-accent-muted, rgba(64,132,246,0.08))"
        : "var(--bgColor-default, var(--uncon-bg, transparent))",
      opacity: isFull ? 0.6 : 1,
    }}>
      <div style={{ gridColumn: 1, gridRow: 1, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "2px 8px", borderRadius: 999,
          background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
          color: muted,
          fontSize: 11, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: 0.4,
        }}>
          <span style={{
            display: "inline-block", width: 6, height: 6, borderRadius: "50%",
            background: "var(--borderColor-neutral-emphasis, var(--uncon-fg-muted, #6e7781))",
          }} />
          {roomName}
        </span>
        <span style={{ fontSize: 11, color: muted }}>
          {isFull ? "Full" : `${remaining} of ${capacity} seat${capacity === 1 ? "" : "s"} left`}
        </span>
        {isCurrent && (
          <span style={{
            padding: "1px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
            background: "var(--bgColor-accent-muted, rgba(64,132,246,0.12))",
            color: "var(--fgColor-accent, #2563eb)",
          }}>
            Your pick
          </span>
        )}
      </div>
      <div style={{ gridColumn: 2, gridRow: 1 }}>
        <Button
          size="small"
          variant={isCurrent ? "default" : "primary"}
          onClick={onPick}
          disabled={isFull || isCurrent || busy}
        >
          {isCurrent ? "Picked" : "Switch here"}
        </Button>
      </div>
      <div style={{
        gridColumn: "1 / -1", gridRow: 2,
        fontSize: 15, fontWeight: 600, lineHeight: "20px",
        wordBreak: "break-word",
      }}>
        {title}
      </div>
      {speaker && (
        <div style={{ gridColumn: "1 / -1", gridRow: 3, color: muted, fontSize: 13 }}>
          {speaker}
        </div>
      )}
    </div>
  );
}
