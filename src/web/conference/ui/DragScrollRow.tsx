// A horizontally-scrollable row that hides the native scrollbar and lets
// the user drag the contents around with the pointer ("grab to scroll").
//
// Used in the Calendar for slot rows where sessions overflow horizontally —
// the native scrollbar steals 12-15px of vertical space on every overflowing
// row, which on a busy day adds up to a lot of lost real estate. With this
// wrapper the row keeps its full height; users drag to pan, and child
// clicks that follow a drag are suppressed so dragging doesn't trigger
// the slot's open-sheet behavior.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

// Beyond this many pixels of pointer motion, we consider the interaction
// a drag (not a click). Smaller values feel snappier but cause more
// accidental click-suppression; 5px matches typical native drag thresholds.
const DRAG_THRESHOLD = 5;

const STYLE = `
.drag-scroll-row {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.drag-scroll-row::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
`;

let injected = false;
function ensureStyles() {
  if (injected || typeof document === "undefined") return;
  const tag = document.createElement("style");
  tag.setAttribute("data-source", "DragScrollRow");
  tag.textContent = STYLE;
  document.head.appendChild(tag);
  injected = true;
}

export function DragScrollRow({
  children, style, onClick,
}: {
  children: ReactNode;
  /** Forwarded onto the scroll container. */
  style?: CSSProperties;
  /** Click handler — only fires when the pointer didn't drag. Useful for
   * letting the row open a sheet when tapped, while dragging is silent. */
  onClick?: () => void;
}) {
  useEffect(() => { ensureStyles(); }, []);
  const ref = useRef<HTMLDivElement>(null);
  // Track whether the current pointer interaction has moved past the
  // drag threshold — if so, suppress the click that follows pointer-up.
  // Kept on a ref so updates don't re-render and lose drag state.
  const movedRef = useRef(false);
  const dragRef = useRef<
    { startX: number; startScroll: number; pointerId: number } | null
  >(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Left click only — let middle/right pass through.
    if (e.button !== 0) return;
    const el = ref.current!;
    movedRef.current = false;
    dragRef.current = {
      startX: e.clientX,
      startScroll: el.scrollLeft,
      pointerId: e.pointerId,
    };
    el.style.cursor = "grabbing";
    el.style.userSelect = "none";
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) > DRAG_THRESHOLD) movedRef.current = true;
    ref.current!.scrollLeft = d.startScroll - dx;
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const el = ref.current!;
    el.style.cursor = "grab";
    el.style.userSelect = "";
    try { el.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    dragRef.current = null;
    // Reset moved flag a tick later so the click handler below can read it.
    setTimeout(() => { movedRef.current = false; }, 0);
  }

  // Capture-phase click filter — runs before any descendant `onClick`,
  // so dragging over an embedded card doesn't navigate.
  function onClickCapture(e: React.MouseEvent<HTMLDivElement>) {
    if (movedRef.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  function onClickOwn(e: React.MouseEvent<HTMLDivElement>) {
    // Only fire the row's own click when the user actually clicked (didn't drag).
    if (movedRef.current || !onClick) return;
    onClick();
    e.stopPropagation();
  }

  return (
    <div
      ref={ref}
      className="drag-scroll-row"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={onClickCapture}
      onClick={onClickOwn}
      style={{
        cursor: "grab",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
