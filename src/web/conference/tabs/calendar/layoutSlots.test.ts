import { describe, expect, test } from "bun:test";
import { layoutSlots } from "./layoutSlots";
import type { CalSlot } from "./types";

const MIN = 60_000;

// A fixed arbitrary day base — layoutSlots only cares about relative
// start/end minutes, so the absolute epoch is irrelevant.
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

function slot(id: number, startMin: number, endMin: number): CalSlot {
  return {
    id,
    type: "normal",
    title: `#${id}`,
    starts_at: BASE + startMin * MIN,
    ends_at: BASE + endMin * MIN,
  };
}

// Look up the layout entry for a given slot id.
function forId(layout: ReturnType<typeof layoutSlots>, id: number) {
  const l = layout.find((x) => x.slot.id === id);
  if (!l) throw new Error(`no layout for slot ${id}`);
  return l;
}

describe("layoutSlots", () => {
  test("15-min slot back-to-back with next slot → separate clusters, single column each", () => {
    // 13:00–13:15 renders at exactly its 15px floor, so its effective end is
    // still 13:15 and it does NOT overlap a slot starting at 13:15.
    const a = slot(1, 13 * 60, 13 * 60 + 15); // 13:00–13:15
    const b = slot(2, 13 * 60 + 15, 14 * 60 + 15); // 13:15–14:15
    const layout = layoutSlots([a, b]);

    expect(forId(layout, 1)).toMatchObject({ col: 0, cols: 1 });
    expect(forId(layout, 2)).toMatchObject({ col: 0, cols: 1 });
  });

  test("sub-15-min slot overlaps a block starting inside its rendered height → two columns", () => {
    // A 10-min slot paints 15px tall (clamped), so its effective end is
    // 13:15 even though it really ends 13:10. A slot starting at 13:10 lands
    // inside that painted area and must get its own column.
    const a = slot(1, 13 * 60, 13 * 60 + 10); // 13:00–13:10 (clamps to 13:15)
    const b = slot(2, 13 * 60 + 10, 14 * 60); // 13:10–14:00
    const layout = layoutSlots([a, b]);

    expect(forId(layout, 1).cols).toBe(2);
    expect(forId(layout, 2).cols).toBe(2);
    expect(forId(layout, 1).col).not.toBe(forId(layout, 2).col);
  });

  test("genuinely time-overlapping slots get side-by-side columns (unchanged)", () => {
    const a = slot(1, 13 * 60, 14 * 60); // 13:00–14:00
    const b = slot(2, 13 * 60 + 30, 14 * 60 + 30); // 13:30–14:30
    const layout = layoutSlots([a, b]);

    expect(forId(layout, 1).cols).toBe(2);
    expect(forId(layout, 2).cols).toBe(2);
    expect(forId(layout, 1).col).not.toBe(forId(layout, 2).col);
  });

  test("non-overlapping 60-min back-to-back slots → separate clusters, single column each", () => {
    const a = slot(1, 13 * 60, 14 * 60); // 13:00–14:00
    const b = slot(2, 14 * 60, 15 * 60); // 14:00–15:00
    const layout = layoutSlots([a, b]);

    expect(forId(layout, 1)).toMatchObject({ col: 0, cols: 1 });
    expect(forId(layout, 2)).toMatchObject({ col: 0, cols: 1 });
  });
});
