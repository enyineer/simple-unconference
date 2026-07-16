// Public Live Board (F1) — full-screen, no-login, projector-first.
//
// Reached at `/#/board/<slug>?t=<token>` (rendered OUTSIDE the conference shell
// by App.tsx). It owns its own dark palette (see boardStyles) and never imports
// the per-conference design system: the board is public and must look identical
// regardless of app theme. Data comes from the plain Hono route via
// `fetchBoardPayload`; live updates ride a single EventSource that forwards
// `agenda.changed` / `board.spotlight` (IDs only) and we refetch the snapshot
// debounced (1.5s). The payload is strictly public-safe (names, never emails).

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { BoardPayloadOut } from "../../shared/contract/types";
import { boardStreamUrl, fetchBoardPayload, type BoardFetchResult } from "../board/boardApi";
import { BOARD_STYLES } from "../board/boardStyles";
import { BoardGrid } from "../board/BoardGrid";
import { BoardSpotlight } from "../board/BoardSpotlight";
import { QrBlock } from "../board/QrBlock";
import { makeClockFmt, makeTimeFmt, timezoneLabel } from "../board/boardFormat";

const REFETCH_DEBOUNCE_MS = 1500;
const SLOT_TICK_MS = 30_000;
const AUTOSCROLL_MS = 5 * 60_000;

type Conn = "connecting" | "live" | "reconnecting";
type State =
  | { kind: "loading" }
  | { kind: "ok"; payload: BoardPayloadOut }
  | { kind: "not_active" }
  | { kind: "error" };

// Read `?t=<token>` out of the hash tail (same shape as Join.tsx / Login).
function readToken(): string | null {
  const hash = window.location.hash;
  const qIdx = hash.indexOf("?");
  if (qIdx === -1) return null;
  return new URLSearchParams(hash.slice(qIdx + 1)).get("t");
}

function scrollNowIntoView(): void {
  const el = document.querySelector("[data-board-now]");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Map a fetch result onto board state. A transient error keeps the last good
// snapshot on screen (the wall shouldn't blank out on one dropped request).
function applyResult(setState: Dispatch<SetStateAction<State>>, res: BoardFetchResult): void {
  if (res.kind === "ok") setState({ kind: "ok", payload: res.payload });
  else if (res.kind === "not_active") setState({ kind: "not_active" });
  else setState((s) => (s.kind === "ok" ? s : { kind: "error" }));
}

export function BoardPage({ slug }: { slug: string }) {
  const token = useMemo(() => readToken(), []);
  // Seed the no-token case up front so the load effect never has to setState
  // synchronously in its body (only after an awaited fetch).
  const [state, setState] = useState<State>(() =>
    readToken() ? { kind: "loading" } : { kind: "not_active" },
  );
  const [conn, setConn] = useState<Conn>("connecting");
  const [now, setNow] = useState(() => Date.now());

  // Fetch WITHOUT touching state — setState lives only in the `.then` callbacks
  // below (the codebase's accepted effect-fetch pattern), so nothing setStates
  // synchronously inside an effect body.
  const load = useCallback((): Promise<BoardFetchResult> => {
    if (!token) return Promise.resolve({ kind: "not_active" });
    return fetchBoardPayload(slug, token);
  }, [slug, token]);

  // Initial fetch.
  useEffect(() => {
    let cancelled = false;
    load().then((res) => { if (!cancelled) applyResult(setState, res); });
    return () => { cancelled = true; };
  }, [load]);

  // Slot-now tick (coarse — the wall clock re-renders on its own every second).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), SLOT_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // SSE stream — debounced refetch on any forwarded event; connection dot.
  useEffect(() => {
    if (!token) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { load().then((res) => applyResult(setState, res)); }, REFETCH_DEBOUNCE_MS);
    };
    const es = new EventSource(boardStreamUrl(slug, token), { withCredentials: true });
    es.onopen = () => setConn("live");
    es.onerror = () => setConn("reconnecting");
    es.addEventListener("agenda.changed", schedule);
    es.addEventListener("board.spotlight", schedule);
    return () => {
      if (debounce) clearTimeout(debounce);
      es.close();
    };
  }, [slug, token, load]);

  // Auto-scroll the current slot into view: once after first paint, then on a
  // slow cadence (never on every update — keeps a reader in control).
  const hasPayload = state.kind === "ok";
  useEffect(() => {
    if (!hasPayload) return;
    const first = setTimeout(scrollNowIntoView, 400);
    const id = setInterval(scrollNowIntoView, AUTOSCROLL_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [hasPayload]);

  if (state.kind === "loading") {
    return (
      <div className="board-center">
        <style>{BOARD_STYLES}</style>
        <div className="board-spinner" />
      </div>
    );
  }

  if (state.kind === "not_active" || state.kind === "error") {
    const isError = state.kind === "error";
    return (
      <div className="board-center">
        <style>{BOARD_STYLES}</style>
        <div className="board-center-card">
          <h1 className="board-center-title">
            {isError ? "The board is offline" : "This board link is not active."}
          </h1>
          <p className="board-center-body">
            {isError
              ? "We couldn't reach the live board. It will reconnect automatically."
              : "Ask the organizer for a current link, or check the schedule from your conference page."}
          </p>
        </div>
      </div>
    );
  }

  return <BoardView payload={state.payload} slug={slug} conn={conn} now={now} />;
}

function BoardView({
  payload,
  slug,
  conn,
  now,
}: {
  payload: BoardPayloadOut;
  slug: string;
  conn: Conn;
  now: number;
}) {
  const timeFmt = useMemo(() => makeTimeFmt(payload.timezone), [payload.timezone]);
  const joinUrl = `${window.location.origin}/#/conferences/${slug}`;
  const connLabel = conn === "live" ? "Live" : conn === "reconnecting" ? "Reconnecting" : "Connecting";

  return (
    <div className="board-root">
      <style>{BOARD_STYLES}</style>

      <header className="board-header">
        <div className="board-title-wrap">
          <span className="board-eyebrow">
            <span className={`board-conn is-${conn}`}>
              <span className="board-conn-dot" />
              {connLabel}
            </span>
          </span>
          <h1 className="board-title">{payload.name}</h1>
        </div>
        <div className="board-header-right">
          <div className="board-clock-wrap">
            <WallClock timezone={payload.timezone} />
            <span className="board-clock-tz">{timezoneLabel(payload.timezone)}</span>
          </div>
          <QrBlock value={joinUrl} label="Scan to open the schedule" />
        </div>
      </header>

      <BoardGrid payload={payload} now={now} timeFmt={timeFmt} />

      <BoardSpotlight spotlight={payload.spotlight} joinUrl={joinUrl} />
    </div>
  );
}

// Ticks every second in the conference timezone. Isolated so its re-render
// doesn't touch the grid.
function WallClock({ timezone }: { timezone: string }) {
  const fmt = useMemo(() => makeClockFmt(timezone), [timezone]);
  const [text, setText] = useState(() => fmt.format(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setText(fmt.format(Date.now())), 1000);
    return () => clearInterval(id);
  }, [fmt]);
  return <span className="board-clock">{text}</span>;
}
