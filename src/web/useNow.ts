import { useEffect, useState } from "react";

// Returns the current wall-clock time, refreshed roughly once per minute.
// Use for "is past" / "is expired" comparisons in render where calling
// Date.now() directly would violate react-hooks/purity. Aligned to whole
// minutes so multiple consumers tick in lockstep.
export function useNow(): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    const timeout = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 60_000);
    }, msToNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  return now;
}
