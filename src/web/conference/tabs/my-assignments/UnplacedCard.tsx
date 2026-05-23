import { Button } from "../../../design-system";
import { fmtTimeShort } from "../../helpers";
import type { Slot } from "../../types";

// Polished unplaced-slots card. One card, attention-color stripe, with a
// compact list of slots inside. No fat Banner above — the card itself
// carries the warning context. Each row leans on typography hierarchy
// rather than borders/backgrounds to feel less heavy.
export function UnplacedCard({
  slotIds, slotById, timeZone, onPick,
}: {
  slotIds: number[];
  slotById: Map<number, Slot>;
  timeZone: string;
  onPick: (slotId: number) => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const attention = "var(--fgColor-attention, var(--uncon-warning-fg, #9a6700))";
  const attentionBg = "var(--bgColor-attention-muted, rgba(187, 128, 9, 0.10))";
  const attentionBorder = "var(--borderColor-attention-muted, rgba(187, 128, 9, 0.45))";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr",
      gap: "0 12px",
      padding: 16,
      borderRadius: 10,
      border: `1px solid ${attentionBorder}`,
      background: attentionBg,
    }}>
      {/* Compact warning glyph in the left rail. Single triangle + dot,
          drawn inline so we don't depend on an icon library. */}
      <svg
        width="18" height="18" viewBox="0 0 16 16" aria-hidden
        style={{ marginTop: 2, color: attention }}
      >
        <path d="M8 1.5 L15 14 L1 14 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M8 6 L8 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="8" cy="12" r="0.9" fill="currentColor" />
      </svg>

      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 600, lineHeight: "20px",
          color: "var(--fgColor-default, var(--uncon-fg, inherit))",
        }}>
          {slotIds.length === 1 ? "Pick a session" : `Pick a session for ${slotIds.length} slots`}
        </div>
        <div style={{ fontSize: 13, color: muted, marginTop: 2 }}>
          Your starred sessions filled up. Switch into any non-full session below.
        </div>

        <div style={{
          display: "flex", flexDirection: "column",
          marginTop: 12,
          borderTop: `1px solid ${attentionBorder}`,
        }}>
          {slotIds.map((sid, i) => {
            const slot = slotById.get(sid);
            return (
              <div
                key={sid}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 12, flexWrap: "wrap",
                  paddingTop: i === 0 ? 12 : 10,
                  paddingBottom: i === slotIds.length - 1 ? 0 : 10,
                  borderBottom: i === slotIds.length - 1
                    ? "none"
                    : `1px solid ${attentionBorder}`,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  {slot ? (
                    <span style={{
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 14, fontWeight: 600,
                      color: "var(--fgColor-default, var(--uncon-fg, inherit))",
                    }}>
                      {fmtTimeShort(slot.starts_at, timeZone)}
                      <span style={{ color: muted, margin: "0 6px", fontWeight: 400 }}>→</span>
                      {fmtTimeShort(slot.ends_at, timeZone)}
                    </span>
                  ) : (
                    <span style={{ color: muted }}>—</span>
                  )}
                  <span style={{ fontSize: 12, color: muted }}>
                    {slot?.title ?? "Unconference slot"}
                  </span>
                </div>
                <Button size="small" variant="primary" onClick={() => onPick(sid)}>
                  Pick a session
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
