import { describe, expect, test, beforeEach } from "bun:test";
import { isBusMessage, makeBus, __resetBusForTests } from "./bus";
import type { BusEvent } from "./bus";

describe("InProcessBus", () => {
  beforeEach(() => __resetBusForTests());

  test("publish dispatches to subscribed handler", () => {
    const bus = makeBus();
    const received: BusEvent[] = [];
    bus.subscribe(42, (e) => received.push(e));
    bus.publish({ kind: "message.created", recipientId: 42, messageId: 1, conversationId: 7 });
    expect(received).toEqual([{ kind: "message.created", recipientId: 42, messageId: 1, conversationId: 7 }]);
  });

  test("publish does not dispatch to other recipients", () => {
    const bus = makeBus();
    const received: BusEvent[] = [];
    bus.subscribe(99, (e) => received.push(e));
    bus.publish({ kind: "message.created", recipientId: 42, messageId: 1, conversationId: 7 });
    expect(received).toHaveLength(0);
  });

  test("multiple subscribers for same recipient all fire", () => {
    const bus = makeBus();
    let a = 0;
    let b = 0;
    bus.subscribe(42, () => a++);
    bus.subscribe(42, () => b++);
    bus.publish({ kind: "message.created", recipientId: 42, messageId: 1, conversationId: 7 });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test("unsubscribe stops further calls", () => {
    const bus = makeBus();
    let count = 0;
    const off = bus.subscribe(42, () => count++);
    bus.publish({ kind: "message.created", recipientId: 42, messageId: 1, conversationId: 7 });
    off();
    bus.publish({ kind: "message.created", recipientId: 42, messageId: 2, conversationId: 7 });
    expect(count).toBe(1);
  });

  test("throwing handler does not break siblings", () => {
    const bus = makeBus();
    let sibling = 0;
    bus.subscribe(42, () => {
      throw new Error("boom");
    });
    bus.subscribe(42, () => sibling++);
    bus.publish({ kind: "message.created", recipientId: 42, messageId: 1, conversationId: 7 });
    expect(sibling).toBe(1);
  });
});

describe("isBusMessage", () => {
  test("accepts well-formed message", () => {
    expect(
      isBusMessage({
        type: "bus",
        event: { kind: "message.created", recipientId: 42, messageId: 1, conversationId: 7 },
      }),
    ).toBe(true);
  });

  test("rejects wrong type field", () => {
    expect(isBusMessage({ type: "something-else", event: {} })).toBe(false);
  });

  test("rejects missing event", () => {
    expect(isBusMessage({ type: "bus" })).toBe(false);
  });

  test("rejects non-object", () => {
    expect(isBusMessage(null)).toBe(false);
    expect(isBusMessage("string")).toBe(false);
    expect(isBusMessage(undefined)).toBe(false);
  });

  test("rejects event missing kind / recipientId", () => {
    expect(isBusMessage({ type: "bus", event: { recipientId: 42 } })).toBe(false);
    expect(isBusMessage({ type: "bus", event: { kind: "foo" } })).toBe(false);
  });
});
