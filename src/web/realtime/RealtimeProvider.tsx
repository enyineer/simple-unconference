// Owns the single EventSource for this tab. Mounts inside the
// authenticated branch of App.tsx (above the router). Reconnects with
// exponential backoff on transport errors; EventSource auto-resends
// Last-Event-ID so missed events backfill via the server's replay path.
//
// Components don't import this — they subscribe via realtimeBus.

import { useEffect } from "react";
import { realtimeBus, type ClientBusEventMap } from "./realtimeBus";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

// Bus kinds we expect from the server. Keep in sync with BusEvent in
// src/server/realtime/bus.ts.
const SERVER_KINDS: Array<keyof ClientBusEventMap> = [
  "message.created",
  "message.edited",
  "message.deleted",
  "message.read",
  "notification.upserted",
  "notification.read",
];

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let disposed = false;

    function connect() {
      if (disposed) return;
      es = new EventSource("/api/realtime/stream", { withCredentials: true });

      es.onopen = () => {
        backoff = INITIAL_BACKOFF_MS;
        realtimeBus.emit("connection.open", {});
      };
      es.onerror = () => {
        realtimeBus.emit("connection.close", { reason: "transport_error" });
        es?.close();
        es = null;
        if (disposed) return;
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };

      for (const kind of SERVER_KINDS) {
        // Each server event uses `event: <kind>`, so we register named
        // listeners. The default `message` listener is only triggered for
        // events without an explicit `event:` field — we never send those.
        es.addEventListener(kind, (raw: MessageEvent) => {
          try {
            const payload = JSON.parse(raw.data) as ClientBusEventMap[typeof kind];
            // Typed dispatch into the bus.
            (realtimeBus.emit as (k: typeof kind, p: ClientBusEventMap[typeof kind]) => void)(kind, payload);
          } catch (e) {
            console.error(`[realtime] failed to parse ${kind} event`, e);
          }
        });
      }
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  return <>{children}</>;
}
