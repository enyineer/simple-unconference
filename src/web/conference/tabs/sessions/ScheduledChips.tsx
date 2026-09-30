import { useLayoutEffect, useRef, useState } from "react";
import { fmtTimeMaybeDay } from "../../helpers";
import type { Submission } from "../../types";

/**
 * The "Scheduled · [day time · room]" chip row on a SessionCard. Chips always
 * carry the day label (see SessionCard), so rows get long fast — instead of
 * wrapping by default, the row stays on one line and clips; only when the
 * chips actually overflow does a chevron toggle appear to expand the row
 * (wrap, everything visible) and collapse it again.
 */
export function ScheduledChips({
  items,
  timeZone,
}: {
  items: Submission["scheduled_in"];
  timeZone: string;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  // Overflow is only measurable in the collapsed layout: nowrap + clip makes
  // scrollWidth exceed clientWidth exactly when a chip doesn't fit. While
  // expanded the row wraps and that reading is meaningless, so the observer
  // is torn down and the toggle simply stays visible until collapsed.
  useLayoutEffect(() => {
    if (expanded) return;
    const el = rowRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, items]);

  if (items.length === 0) return null;

  const fadeRight =
    overflowing && !expanded
      ? {
          WebkitMaskImage:
            "linear-gradient(to right, black calc(100% - 28px), transparent)",
          maskImage:
            "linear-gradient(to right, black calc(100% - 28px), transparent)",
        }
      : {};

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: muted,
        minWidth: 0,
      }}
    >
      <div
        ref={rowRef}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          overflow: "hidden",
          flexWrap: expanded ? "wrap" : "nowrap",
          ...fadeRight,
        }}
      >
        <span
          style={{
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            flexShrink: 0,
          }}
        >
          Scheduled
        </span>
        {items.map((sch) => (
          <span
            key={sch.slot_id}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 8px",
              borderRadius: 999,
              background: "var(--bgColor-accent-muted, rgba(64,132,246,0.12))",
              color: "var(--fgColor-accent, #2563eb)",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtTimeMaybeDay(sch.starts_at, timeZone, true)}
            </span>
            <span aria-hidden style={{ opacity: 0.6 }}>·</span>
            <span>{sch.room_name}</span>
          </span>
        ))}
      </div>
      {(overflowing || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={expanded ? "Show fewer scheduled times" : "Show all scheduled times"}
          title={expanded ? "Show fewer" : "Show all"}
          style={{
            border: "none",
            background: "none",
            padding: 4,
            cursor: "pointer",
            color: muted,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              fontSize: 11,
              display: "inline-block",
              transition: "transform .15s ease",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            ▸
          </span>
        </button>
      )}
    </div>
  );
}
