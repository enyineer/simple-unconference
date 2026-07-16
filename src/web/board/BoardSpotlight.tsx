// The pitch-circle spotlight overlay. When a mod spotlights a session it fills
// the wall: giant title, submitter, and a LIVE star count that bumps whenever
// it changes (people star it from their phones). A small QR repeats the join
// deep-link so latecomers can jump in. Fades/scales in and out over 300ms.

import { useEffect, useRef, useState } from "react";
import type { BoardSpotlightOut } from "../../shared/contract/types";
import { QrBlock } from "./QrBlock";

export function BoardSpotlight({
  spotlight,
  joinUrl,
}: {
  spotlight: BoardSpotlightOut | null;
  joinUrl: string;
}) {
  // Keep the last non-null spotlight so we can animate OUT after it clears.
  const [shown, setShown] = useState<BoardSpotlightOut | null>(spotlight);
  const [prev, setPrev] = useState<BoardSpotlightOut | null>(spotlight);
  const [leaving, setLeaving] = useState(false);

  // Adjust derived state when the prop changes — the render-phase pattern React
  // recommends over an effect (no cascading render, no lint flag). The exit
  // TIMER stays in an effect below, since timers belong there.
  if (spotlight !== prev) {
    setPrev(spotlight);
    if (spotlight) {
      setShown(spotlight);
      setLeaving(false);
    } else if (shown) {
      setLeaving(true);
    }
  }

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => { setShown(null); setLeaving(false); }, 300);
    return () => clearTimeout(t);
  }, [leaving]);

  if (!shown) return null;

  return (
    <div className={`board-spot-backdrop${leaving ? " is-out" : ""}`} role="dialog" aria-live="polite">
      <div className="board-spot-card">
        <span className="board-spot-eyebrow">◆ Now pitching</span>
        <h2 className="board-spot-title">{shown.title}</h2>
        {shown.submitter_name && <p className="board-spot-by">by {shown.submitter_name}</p>}
        <div className="board-spot-stars">
          <span className="board-spot-star-icon">★</span>
          <StarCount value={shown.star_count} />
        </div>
        <div className="board-spot-hint">
          <QrBlock value={joinUrl} label="Star it on your phone" size={76} />
        </div>
      </div>
    </div>
  );
}

// Renders the number and pulses it whenever the value increases or decreases.
function StarCount({ value }: { value: number }) {
  const [bumped, setBumped] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setBumped(true);
      const t = setTimeout(() => setBumped(false), 440);
      return () => clearTimeout(t);
    }
  }, [value]);
  return <span className={`board-spot-count${bumped ? " is-bumped" : ""}`}>{value}</span>;
}
