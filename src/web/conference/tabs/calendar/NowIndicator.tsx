import { useEffect, useState } from "react";
import { PX_PER_MIN } from "./constants";
import { fmtTime, startOfDay } from "./helpers";

// ----- now indicator -------------------------------------------------------

// A themed horizontal bar at the current time, visible only when the day
// being rendered is today. Ticks every minute so it slides down the column.
export function NowIndicator({
  dayMs, windowStartMin, windowEndMin, timeZone,
}: { dayMs: number; windowStartMin: number; windowEndMin: number; timeZone: string }) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    // Align ticks to the next whole minute so the bar moves predictably.
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    let interval: ReturnType<typeof setInterval> | null = null;
    const timeout = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 60_000);
    }, msToNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  // Only show on today's column (where "today" is *in the conference TZ*).
  if (startOfDay(now, timeZone) !== dayMs) return null;

  const nowMin = (now - dayMs) / 60_000;
  if (nowMin < windowStartMin || nowMin > windowEndMin) return null;

  const topPx = (nowMin - windowStartMin) * PX_PER_MIN;

  return (
    <div
      aria-label="Current time"
      style={{
        position: "absolute",
        left: 0, right: 0,
        top: topPx,
        height: 0,
        borderTop: "2px solid var(--fgColor-danger, var(--uncon-danger, #d1242f))",
        zIndex: 4,
        pointerEvents: "none",
      }}
    >
      {/* round nub on the left edge */}
      <div
        style={{
          position: "absolute",
          left: -5, top: -6,
          width: 10, height: 10,
          borderRadius: "50%",
          background: "var(--fgColor-danger, var(--uncon-danger, #d1242f))",
        }}
      />
      {/* time label */}
      <div
        style={{
          position: "absolute",
          right: 4, top: -18,
          fontSize: 10, fontWeight: 600,
          padding: "1px 6px",
          borderRadius: 10,
          background: "var(--fgColor-danger, var(--uncon-danger, #d1242f))",
          color: "var(--fgColor-onEmphasis, #fff)",
          whiteSpace: "nowrap",
        }}
      >
        {fmtTime(now, timeZone)}
      </div>
    </div>
  );
}
