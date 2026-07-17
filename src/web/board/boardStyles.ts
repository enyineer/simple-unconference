// Page-scoped styles for the public Live Board. Standalone + projector-first,
// so it owns its own dark palette rather than importing the per-conference
// design system (the board is public and must look identical regardless of
// which theme the app is in). Everything is namespaced `.board-*` so it can't
// leak into the rest of the SPA. Fonts stay on the app's system stack for
// consistency; colors are self-owned tokens tuned for a wall projection:
// deep near-black ground, calm surfaces, and the calendar's own accent
// language (unconference = blue, mixer = green, planned = neutral).

export const BOARD_STYLES = `
.board-root {
  --bd-bg: #0a0d12;
  --bd-bg-2: #0e131b;
  --bd-surface: #141b25;
  --bd-surface-2: #1a2330;
  --bd-border: rgba(255,255,255,0.08);
  --bd-border-strong: rgba(255,255,255,0.16);
  --bd-fg: #e9eef5;
  --bd-fg-muted: #8b97a7;
  --bd-fg-faint: #55606f;
  --bd-unconf: #58a6ff;
  --bd-unconf-soft: rgba(88,166,255,0.14);
  --bd-mixer: #3fb950;
  --bd-mixer-soft: rgba(63,185,80,0.14);
  --bd-planned: #adbac7;
  --bd-planned-soft: rgba(173,186,199,0.10);
  --bd-star: #e3b341;
  --bd-live: #3fb950;

  position: fixed;
  inset: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(1200px 700px at 82% -8%, rgba(88,166,255,0.10), transparent 60%),
    radial-gradient(1000px 620px at 4% 108%, rgba(63,185,80,0.06), transparent 55%),
    linear-gradient(180deg, var(--bd-bg-2), var(--bd-bg));
  color: var(--bd-fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
}

/* ---- header ---- */
.board-header {
  flex-shrink: 0;
  z-index: 5;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 28px 40px 22px;
  background: linear-gradient(180deg, rgba(10,13,18,0.94), rgba(10,13,18,0.62) 70%, transparent);
  backdrop-filter: blur(6px);
}
.board-title-wrap { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.board-eyebrow {
  display: inline-flex; align-items: center; gap: 10px;
  font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--bd-fg-muted);
}

/* Prominent header wayfinding: the day + "Rooms X of Y" + time window on screen.
   Centered between the title and the clock — the first thing the room reads. */
.board-nav {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  text-align: center; flex-shrink: 0; padding-top: 2px;
}
.board-nav-day {
  font-size: 27px; font-weight: 800; letter-spacing: -0.01em;
  color: var(--bd-fg); line-height: 1; white-space: nowrap;
}
.board-nav-detail {
  display: inline-flex; align-items: center; gap: 12px;
  font-size: 16px; font-weight: 700; letter-spacing: 0.01em; white-space: nowrap;
}
.board-nav-rooms {
  color: var(--bd-unconf);
  padding: 3px 12px; border-radius: 999px;
  background: var(--bd-unconf-soft);
  border: 1px solid rgba(88,166,255,0.28);
}
.board-nav-time {
  color: var(--bd-fg-muted); font-variant-numeric: tabular-nums;
}
/* Understated maker credit, pinned to the bottom corner — a footnote, not a
   header element. */
.board-credit {
  position: absolute; right: 22px; bottom: 12px; z-index: 4;
  font-size: 11px; letter-spacing: 0.02em;
  color: var(--bd-fg-faint); text-decoration: none; opacity: 0.7;
  transition: opacity 200ms ease, color 200ms ease;
}
.board-credit:hover { opacity: 1; color: var(--bd-fg-muted); }
.board-title {
  margin: 0;
  font-size: clamp(30px, 4vw, 60px);
  font-weight: 800;
  line-height: 1.02;
  letter-spacing: -0.025em;
  color: var(--bd-fg);
  text-wrap: balance;
}
.board-header-right { display: flex; align-items: center; gap: 24px; flex-shrink: 0; }
.board-clock-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.board-clock {
  font-size: clamp(26px, 3vw, 44px);
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1;
  color: var(--bd-fg);
}
.board-clock-tz { font-size: 12px; color: var(--bd-fg-muted); letter-spacing: 0.04em; }

.board-conn {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--bd-fg-muted);
}
.board-conn-dot {
  width: 8px; height: 8px; border-radius: 999px;
  background: var(--bd-fg-faint);
  transition: background 300ms ease, box-shadow 300ms ease;
}
.board-conn.is-live .board-conn-dot {
  background: var(--bd-live);
  box-shadow: 0 0 0 0 rgba(63,185,80,0.5);
  animation: boardPulseDot 2.4s ease-out infinite;
}
.board-conn.is-reconnecting .board-conn-dot { background: var(--bd-star); }
@keyframes boardPulseDot {
  0% { box-shadow: 0 0 0 0 rgba(63,185,80,0.45); }
  70% { box-shadow: 0 0 0 7px rgba(63,185,80,0); }
  100% { box-shadow: 0 0 0 0 rgba(63,185,80,0); }
}

/* ---- QR block ---- */
.board-qr {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 10px; border-radius: 14px;
  background: var(--bd-surface);
  border: 1px solid var(--bd-border);
}
.board-qr img { display: block; width: 92px; height: 92px; border-radius: 6px; }
.board-qr-label { font-size: 10.5px; color: var(--bd-fg-muted); letter-spacing: 0.02em; max-width: 96px; text-align: center; line-height: 1.3; }

/* ---- grid (paginated projector matrix) ---- */
/* The region fills the space below the header and never scrolls; one page's
   rooms/slots are sized to fit it exactly (see useBoardPages). */
.board-page {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 12px;
  padding: 8px 40px 18px;
  overflow: hidden;
}
/* A page's head + body wrapper, keyed per page so a rotation replays the
   entrance animation. Fills the region so its body grid can stretch rows. */
.board-page-anim {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 12px;
  animation: boardPageIn 520ms cubic-bezier(0.16,0.84,0.44,1) both;
}
@keyframes boardPageIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}
/* Body grid takes the remaining height; rows share it (minmax(84px,1fr)). */
.board-grid { flex: 1; min-height: 0; display: grid; gap: 12px; align-items: stretch; }
.board-grid-head {
  flex-shrink: 0;
  display: grid; gap: 12px; align-items: stretch;
  padding: 2px 0 6px;
}
.board-corner {
  display: flex; align-items: flex-end;
  font-size: 12px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bd-fg-faint);
  padding-bottom: 4px;
}
.board-room-head {
  display: flex; flex-direction: column; gap: 3px;
  padding: 10px 14px; border-radius: 12px;
  background: var(--bd-surface);
  border: 1px solid var(--bd-border);
}
.board-room-name { font-size: 16px; font-weight: 700; color: var(--bd-fg); line-height: 1.15; }
.board-room-cap { font-size: 12px; color: var(--bd-fg-muted); }

.board-row { display: grid; gap: 12px; align-items: stretch; }
.board-row.is-now .board-slot-rail { border-color: var(--bd-unconf); box-shadow: -3px 0 0 0 var(--bd-unconf) inset; }

.board-slot-rail {
  display: flex; flex-direction: column; gap: 6px; justify-content: center;
  padding: 14px 16px; border-radius: 12px;
  background: var(--bd-surface);
  border: 1px solid var(--bd-border);
}
.board-slot-time { font-size: 19px; font-weight: 700; color: var(--bd-fg); letter-spacing: -0.01em; }
.board-slot-title { font-size: 13px; color: var(--bd-fg-muted); line-height: 1.3; }
.board-slot-type {
  display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
  margin-top: 2px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
}
.board-slot-type::before { content: ""; width: 8px; height: 8px; border-radius: 3px; background: currentColor; }
.board-now-tag {
  align-self: flex-start; margin-top: 4px;
  font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bd-unconf);
  display: inline-flex; align-items: center; gap: 6px;
}
.board-now-tag::before {
  content: ""; width: 7px; height: 7px; border-radius: 999px; background: var(--bd-unconf);
  animation: boardPulseDot 2s ease-out infinite;
}

/* ---- cells ---- */
.board-cell {
  position: relative; min-height: 84px;
  border-radius: 12px;
  border: 1px solid var(--bd-border);
  background: var(--bd-surface);
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 6px;
  overflow: hidden;
  transition: border-color 200ms ease, transform 200ms ease, background 200ms ease;
}
.board-cell.is-empty {
  background: transparent;
  border-style: dashed;
  border-color: rgba(255,255,255,0.05);
}
.board-cell.is-empty::after {
  content: "";
  position: absolute; inset: 0; margin: auto; width: 22px; height: 1.5px;
  background: var(--bd-fg-faint); opacity: 0.35; border-radius: 2px;
}
.board-cell.kind-unconf { border-left: 3px solid var(--bd-unconf); background: linear-gradient(180deg, var(--bd-unconf-soft), transparent 70%), var(--bd-surface); }
.board-cell.kind-mixer { border-left: 3px solid var(--bd-mixer); background: linear-gradient(180deg, var(--bd-mixer-soft), transparent 70%), var(--bd-surface); }
.board-cell.kind-planned { border-left: 3px solid var(--bd-planned); background: linear-gradient(180deg, var(--bd-planned-soft), transparent 70%), var(--bd-surface); }

.board-cell-in { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; animation: boardCellIn 260ms cubic-bezier(0.16,0.84,0.44,1) both; }
@keyframes boardCellIn {
  from { opacity: 0; transform: translateY(6px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.board-cell-title {
  font-size: 16px; font-weight: 700; line-height: 1.2; color: var(--bd-fg);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.board-cell-by { font-size: 12.5px; color: var(--bd-fg-muted); line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.board-cell-meta { margin-top: auto; display: flex; align-items: center; gap: 12px; font-size: 12.5px; }
.board-cell-stars { display: inline-flex; align-items: center; gap: 4px; color: var(--bd-star); font-weight: 700; }
.board-cell-seats { display: inline-flex; align-items: center; gap: 4px; color: var(--bd-fg-muted); font-weight: 600; }
.board-cell-badge {
  align-self: flex-start; font-size: 9.5px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 2px 6px; border-radius: 999px; color: #0a0d12; background: var(--bd-planned);
}

/* ---- pager (page rotation indicator) ---- */
.board-pager {
  flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; gap: 16px;
  padding: 2px 0 0;
}
.board-pager-dots { display: inline-flex; align-items: center; gap: 8px; }
.board-pager-dot {
  width: 8px; height: 8px; border-radius: 999px;
  background: var(--bd-fg-faint); opacity: 0.45;
  transition: background 300ms ease, opacity 300ms ease, transform 300ms ease;
}
.board-pager-dot.is-active {
  background: var(--bd-unconf); opacity: 1; transform: scale(1.2);
}
.board-pager-label {
  font-size: 12.5px; font-weight: 600; letter-spacing: 0.04em;
  color: var(--bd-fg-muted); font-variant-numeric: tabular-nums;
}

/* Reduced motion: still rotate on the same calm cadence, but cross-fade the
   pages (opacity only) instead of the vertical slide. */
@media (prefers-reduced-motion: reduce) {
  .board-page-anim { animation: boardPageFade 520ms ease both; }
  @keyframes boardPageFade { from { opacity: 0; } to { opacity: 1; } }
}

/* ---- stacked (mobile) ---- */
.board-stack { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; padding: 8px 18px 56px; }
.board-stack-slot { border-radius: 14px; border: 1px solid var(--bd-border); background: var(--bd-surface); overflow: hidden; }
.board-stack-slot.is-now { border-color: var(--bd-unconf); box-shadow: 0 0 0 1px var(--bd-unconf); }
.board-stack-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--bd-border); }
.board-stack-time { font-size: 18px; font-weight: 700; }
.board-stack-body { display: flex; flex-direction: column; }
.board-stack-cell { padding: 12px 16px; border-bottom: 1px solid var(--bd-border); display: flex; flex-direction: column; gap: 4px; }
.board-stack-cell:last-child { border-bottom: none; }
.board-stack-room { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--bd-fg-faint); }

/* ---- states ---- */
.board-center {
  position: fixed; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 18px; padding: 32px;
  background: linear-gradient(180deg, var(--bd-bg-2), var(--bd-bg));
  color: var(--bd-fg); text-align: center;
}
.board-center-card {
  max-width: 440px; display: flex; flex-direction: column; align-items: center; gap: 14px;
  padding: 40px 36px; border-radius: 18px;
  background: var(--bd-surface); border: 1px solid var(--bd-border);
}
.board-center-title { font-size: 22px; font-weight: 700; margin: 0; }
.board-center-body { font-size: 15px; color: var(--bd-fg-muted); margin: 0; line-height: 1.5; }
.board-spinner {
  width: 34px; height: 34px; border-radius: 999px;
  border: 3px solid rgba(255,255,255,0.14); border-top-color: var(--bd-unconf);
  animation: boardSpin 0.8s linear infinite;
}
@keyframes boardSpin { to { transform: rotate(360deg); } }

.board-empty-note { padding: 60px 24px; text-align: center; color: var(--bd-fg-muted); font-size: 15px; }

/* ---- spotlight overlay ---- */
.board-spot-backdrop {
  position: fixed; inset: 0; z-index: 20;
  display: flex; align-items: center; justify-content: center; padding: 40px;
  background: radial-gradient(1000px 700px at 50% 40%, rgba(10,13,18,0.72), rgba(6,8,12,0.92));
  backdrop-filter: blur(10px);
  animation: boardSpotIn 300ms ease both;
}
.board-spot-backdrop.is-out { animation: boardSpotOut 300ms ease both; }
@keyframes boardSpotIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes boardSpotOut { from { opacity: 1; } to { opacity: 0; } }
.board-spot-card {
  position: relative; max-width: 1100px; width: 100%;
  display: flex; flex-direction: column; align-items: center; gap: 22px; text-align: center;
  padding: 56px 48px;
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(26,35,48,0.9), rgba(20,27,37,0.9));
  border: 1px solid var(--bd-border-strong);
  box-shadow: 0 40px 120px -40px rgba(0,0,0,0.8);
  animation: boardSpotCardIn 320ms cubic-bezier(0.16,0.84,0.44,1) both;
}
@keyframes boardSpotCardIn { from { opacity: 0; transform: translateY(14px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
.board-spot-eyebrow {
  font-size: 13px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: var(--bd-unconf);
  display: inline-flex; align-items: center; gap: 10px;
}
.board-spot-title {
  margin: 0; font-size: clamp(38px, 6vw, 88px); font-weight: 800; line-height: 1.02;
  letter-spacing: -0.03em; color: var(--bd-fg); text-wrap: balance;
}
.board-spot-by { font-size: clamp(16px, 2vw, 22px); color: var(--bd-fg-muted); margin: 0; }
.board-spot-stars { display: inline-flex; align-items: center; gap: 14px; margin-top: 4px; }
.board-spot-star-icon { font-size: clamp(40px, 5vw, 64px); color: var(--bd-star); line-height: 1; }
.board-spot-count {
  font-size: clamp(54px, 8vw, 120px); font-weight: 800; line-height: 1; color: var(--bd-fg);
  letter-spacing: -0.03em; transition: color 200ms ease;
}
.board-spot-count.is-bumped { animation: boardCountBump 420ms cubic-bezier(0.16,0.84,0.44,1); }
@keyframes boardCountBump {
  0% { transform: scale(1); color: var(--bd-fg); }
  35% { transform: scale(1.18); color: var(--bd-star); }
  100% { transform: scale(1); color: var(--bd-fg); }
}
.board-spot-hint {
  display: flex; align-items: center; gap: 16px; margin-top: 8px;
  font-size: 15px; color: var(--bd-fg-muted);
}
.board-spot-hint .board-qr { background: var(--bd-surface-2); }

@media (max-width: 720px) {
  .board-header { padding: 18px 18px 14px; gap: 14px; }
  .board-header-right { gap: 14px; }
  .board-qr img { width: 72px; height: 72px; }
}
@media (max-width: 480px) {
  .board-header { flex-direction: column; align-items: stretch; }
  .board-header-right { justify-content: space-between; }
}
`;
