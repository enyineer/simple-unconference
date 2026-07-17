// Public Live Board (F1) — full-screen, no-login, projector-first.
//
// Reached at `/board/<slug>?t=<token>` (rendered OUTSIDE the conference shell
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
import { BoardGrid, type BoardNav } from "../board/BoardGrid";
import { BoardSpotlight } from "../board/BoardSpotlight";
import { QrBlock } from "../board/QrBlock";
import { makeClockFmt, makeTimeFmt, timezoneLabel } from "../board/boardFormat";

const REFETCH_DEBOUNCE_MS = 1500;
const SLOT_TICK_MS = 30_000;

type Conn = "connecting" | "live" | "reconnecting";
type State =
  | { kind: "loading" }
  | { kind: "ok"; payload: BoardPayloadOut }
  | { kind: "not_active" }
  | { kind: "error" };

// Read `?t=<token>` from the URL query. Routing is path-based, so the token is a
// real search param (/board/<slug>?t=…), not part of a hash fragment.
function readToken(): string | null {
  return new URLSearchParams(window.location.search).get("t");
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
  const joinUrl = `${window.location.origin}/conferences/${slug}/`;
  const connLabel = conn === "live" ? "Live" : conn === "reconnecting" ? "Reconnecting" : "Connecting";
  // The visible page's day / rooms / time, reported up from the grid so it can
  // headline the header — the wayfinding a projector audience actually needs.
  const [nav, setNav] = useState<BoardNav | null>(null);

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
        {nav && <BoardHeaderNav nav={nav} />}
        <div className="board-header-right">
          <div className="board-clock-wrap">
            <WallClock timezone={payload.timezone} />
            <span className="board-clock-tz">{timezoneLabel(payload.timezone)}</span>
          </div>
          <QrBlock value={joinUrl} label="Scan to open the schedule" />
        </div>
      </header>

      <BoardGrid payload={payload} now={now} timeFmt={timeFmt} onNav={setNav} />

      <BoardSpotlight spotlight={payload.spotlight} joinUrl={joinUrl} />

      {/* Small credit footnote — deliberately understated; the schedule is the
          star of a projector wall, not the maker's byline. */}
      <a className="board-credit" href="https://enking.dev" target="_blank" rel="noreferrer">
        Crafted by enking.dev
      </a>
    </div>
  );
}

// Prominent "where am I looking" indicator, centered in the header: the current
// day (multi-day only), the room span ("Rooms 1–6 of 8", only when paginated),
// and the time window on screen. This is the headline wayfinding for the room.
function BoardHeaderNav({ nav }: { nav: BoardNav }) {
  return (
    <div className="board-nav">
      {nav.day && <span className="board-nav-day">{nav.day}</span>}
      <span className="board-nav-detail">
        {nav.rooms && <span className="board-nav-rooms">{nav.rooms}</span>}
        <span className="board-nav-time">{nav.time}</span>
      </span>
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
