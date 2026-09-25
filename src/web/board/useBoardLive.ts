// React wrapper around the framework-free board stream monitor
// (see boardLive.ts). Owns nothing but the lifecycle: the EventSource, the
// stall watchdog and the polling fallback all live in startBoardLive.

import { useEffect, useRef, useState } from "react";
import { startBoardLive, type BoardConn } from "./boardLive";

export type { BoardConn };

export function useBoardLive(
  streamUrl: string | null,
  onEvent: () => void,
): BoardConn {
  const [conn, setConn] = useState<BoardConn>("connecting");
  // The scheduler identity can change per render; the monitor must not
  // restart because of it — route calls through a "latest" ref, kept fresh by
  // an effect (writing refs during render is a lint violation).
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    if (streamUrl === null) return;
    const handle = startBoardLive({
      streamUrl,
      onEvent: () => onEventRef.current(),
      onConn: setConn,
    });
    return () => handle.close();
  }, [streamUrl]);

  // No URL = no live channel at all — report the neutral state without a
  // setState-in-effect round trip.
  return streamUrl === null ? "connecting" : conn;
}
