import { Text } from "../../../design-system";

// Mod- and participant-facing reminder of the per-user submission cap on
// this conference. The count includes rejected/finished sessions since
// those still occupy quota slots on the server (participants would not see
// them in `submissions.list`, hence the explicit prop instead of filtering
// the visible list).
export function MySessionQuotaHint({ current, limit }: { current: number; limit: number }) {
  const remaining = Math.max(0, limit - current);
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const accent = remaining === 0
    ? "var(--fgColor-danger, #cf222e)"
    : remaining <= Math.max(1, Math.floor(limit * 0.2))
      ? "var(--fgColor-attention, #9a6700)"
      : muted;
  const message = remaining === 0
    ? `You've used all ${limit} of your session submissions for this conference. Delete one of yours to free up a slot.`
    : `${current} of ${limit} session submissions used (${remaining} remaining).`;
  return (
    <Text>
      <span style={{ color: accent, fontSize: 13 }}>{message}</span>
    </Text>
  );
}
