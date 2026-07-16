import { clipToMinute } from "../../../../shared/tz";
import { MIN_SLOT_HEIGHT_PX, PX_PER_MIN } from "./constants";
import type { CalSlot, SlotLayout } from "./types";

// A slot block never paints shorter than MIN_SLOT_HEIGHT_PX (see DayCalendar's
// `heightPx` clamp). So for overlap purposes a slot occupies at least that many
// pixels — i.e. `MIN_SLOT_HEIGHT_PX / PX_PER_MIN` minutes — regardless of its
// real duration. `effEndMs` returns the later of the real end and that
// rendered-height floor so a clamped block shares columns with whatever starts
// inside its painted area instead of overlapping it.
const MIN_SLOT_SPAN_MS = (MIN_SLOT_HEIGHT_PX / PX_PER_MIN) * 60_000;

// For each slot, decide which sub-column index it gets within its overlap
// cluster, and how many sub-columns the cluster has total.
export function layoutSlots(slots: CalSlot[]): SlotLayout[] {
  // Calendar labels show HH:MM, so overlap decisions need to match minute
  // granularity. Without this, a slot ending at 18:07:30 (labelled "18:07")
  // and a slot starting at 18:07:15 (also labelled "18:07") get rendered
  // side-by-side because they technically overlap by 15s — visually
  // confusing because the labels read as adjacent. `clipToMinute` (shared
  // with the MyAssignments conflict detector and the server-side time
  // normalization) makes the layout align with what the user can see.
  const startMin = (s: CalSlot) => clipToMinute(s.starts_at);
  const endMin = (s: CalSlot) => clipToMinute(s.ends_at);
  const effEnd = (s: CalSlot) => Math.max(endMin(s), startMin(s) + MIN_SLOT_SPAN_MS);

  const sorted = [...slots].sort((a, b) => a.starts_at - b.starts_at);
  const out: SlotLayout[] = [];

  let cluster: { slot: CalSlot; col: number }[] = [];
  let clusterEnd = -Infinity;
  let colEnds: number[] = []; // colEnds[i] = latest effective end-minute of slots placed in col i (within cluster)

  const flush = () => {
    const cols = Math.max(1, colEnds.length);
    for (const c of cluster) out.push({ slot: c.slot, col: c.col, cols });
    cluster = [];
    colEnds = [];
    clusterEnd = -Infinity;
  };

  for (const s of sorted) {
    const sStart = startMin(s);
    const sEnd = effEnd(s);
    if (sStart >= clusterEnd) flush();
    // pick the first column whose last slot ended by the time this one starts
    let col = colEnds.findIndex((end) => end <= sStart);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(sEnd);
    } else {
      colEnds[col] = sEnd;
    }
    cluster.push({ slot: s, col });
    clusterEnd = Math.max(clusterEnd, sEnd);
  }
  flush();
  return out;
}
