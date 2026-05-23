// Client-side pub/sub mirroring the server bus. Components subscribe via
// `realtimeBus.on(kind, handler)` in useEffect and never touch EventSource
// directly. RealtimeProvider owns the single EventSource and emits into
// this bus on each `addEventListener("kind", ...)` callback.

export interface ClientBusEventMap {
  "message.created": { messageId: number; recipientId: number; conversationId?: number };
  "message.edited":  { messageId: number; recipientId: number };
  "message.deleted": { messageId: number; recipientId: number };
  "message.read":    { conversationId: number; recipientId: number };
  "notification.upserted": { notificationId: number; recipientId: number };
  "notification.read":     { conversationId: number | null; recipientId: number };
  "connection.open":  Record<string, never>;
  "connection.close": { reason: string };
}

type Handler<E> = (event: E) => void;

class ClientBus {
  private handlers = new Map<keyof ClientBusEventMap, Set<Handler<unknown>>>();

  on<K extends keyof ClientBusEventMap>(kind: K, h: Handler<ClientBusEventMap[K]>): () => void {
    let set = this.handlers.get(kind);
    if (!set) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    set.add(h as Handler<unknown>);
    return () => {
      const s = this.handlers.get(kind);
      if (!s) return;
      s.delete(h as Handler<unknown>);
      if (s.size === 0) this.handlers.delete(kind);
    };
  }

  emit<K extends keyof ClientBusEventMap>(kind: K, payload: ClientBusEventMap[K]): void {
    const set = this.handlers.get(kind);
    if (!set) return;
    for (const h of set) {
      try {
        (h as Handler<ClientBusEventMap[K]>)(payload);
      } catch (e) {
        // Handlers shouldn't throw; log and continue so a buggy subscriber
        // doesn't break siblings.
        console.error("[realtimeBus] handler threw", e);
      }
    }
  }
}

export const realtimeBus = new ClientBus();
