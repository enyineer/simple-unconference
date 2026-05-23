// Shared state machine for every server-paginated list in the conference
// UI. Owns the query string (with debounce), the cursor stack so Prev
// works in O(1), stale-fetch suppression, and a `refresh` hook so realtime
// bus events can re-fetch the current page without resetting search state.
//
// Usage:
//   const list = usePaginatedList(
//     (input) => api.rooms.list({ slug, ...input }),
//     { pageSize: 25 },
//   );
//   <input value={list.q} onChange={(e) => list.setQ(e.target.value)} />
//   {list.items.map(...)}
//   <Pager page={list.page} pageSize={list.pageSize} total={list.total} ... />

import { useCallback, useEffect, useRef, useState } from "react";
import type { Page } from "../../shared/contract";

export interface PaginatedFetchInput {
  q: string;
  cursor: string | undefined;
  limit: number;
}

export interface UsePaginatedListOptions {
  /** Items per page. Server clamps to [1, 100]; default 25. */
  pageSize?: number;
  /** Search debounce in ms. Default 200. */
  debounceMs?: number;
}

export interface UsePaginatedListResult<T> {
  items: T[];
  total: number;
  /** 1-based current page. */
  page: number;
  pageSize: number;
  loading: boolean;
  error: unknown;
  q: string;
  setQ: (next: string) => void;
  hasPrev: boolean;
  hasNext: boolean;
  prev: () => void;
  next: () => void;
  /** Re-fetch the current page without resetting `q`. */
  refresh: () => void;
  /** Reset to page 1 and clear `q`. */
  reset: () => void;
}

export function usePaginatedList<T>(
  fetcher: (input: PaginatedFetchInput) => Promise<Page<T>>,
  options: UsePaginatedListOptions = {},
): UsePaginatedListResult<T> {
  const pageSize = options.pageSize ?? 25;
  const debounceMs = options.debounceMs ?? 200;

  // Cursor stack: stack[i] is the cursor that loaded page (i+1).
  // stack[0] is always `undefined` (page 1). New search resets to [undefined].
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([
    undefined,
  ]);
  const [pageIdx, setPageIdx] = useState(0);
  const [q, setQRaw] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  // Page, error, and the inputs they were loaded for live in one object so
  // a single setResult() inside the fetch callback flips everything atomically.
  // `loading` is derived from (result.key !== currentKey) below, which is why
  // the fetch effect never has to call setState synchronously — react-hooks/
  // set-state-in-effect would otherwise flag it as a cascading-render hazard.
  const [result, setResult] = useState<{
    key: string;
    page: Page<T>;
    error: unknown;
  }>({
    key: "",
    page: { items: [], total: 0, next_cursor: null },
    error: null,
  });
  const [refreshTick, setRefreshTick] = useState(0);

  // Debounce `q` -> `debouncedQ`. Reset paging when query changes.
  useEffect(() => {
    if (q === debouncedQ) return;
    const id = setTimeout(() => {
      setDebouncedQ(q);
      setCursorStack([undefined]);
      setPageIdx(0);
    }, debounceMs);
    return () => clearTimeout(id);
  }, [q, debouncedQ, debounceMs]);

  // Stale-fetch suppression: each fetch claims a sequence number; only the
  // latest one is allowed to apply its result.
  const fetchSeqRef = useRef(0);

  const cursor = cursorStack[pageIdx];
  const currentKey = `${debouncedQ}|${cursor ?? ""}|${pageSize}|${refreshTick}`;
  const loading = result.key !== currentKey;

  useEffect(() => {
    const seq = ++fetchSeqRef.current;
    const key = `${debouncedQ}|${cursor ?? ""}|${pageSize}|${refreshTick}`;
    fetcher({ q: debouncedQ, cursor, limit: pageSize })
      .then((page) => {
        if (fetchSeqRef.current !== seq) return;
        setResult({ key, page, error: null });
      })
      .catch((err) => {
        if (fetchSeqRef.current !== seq) return;
        setResult((prev) => ({ key, page: prev.page, error: err }));
      });
    // `fetcher` is intentionally omitted: callers commonly inline an arrow
    // function, and we don't want every render to re-fetch. Effect identity
    // is driven by debouncedQ, cursor, pageSize, and refreshTick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, cursor, pageSize, refreshTick]);

  const setQ = useCallback((next: string) => setQRaw(next), []);

  const prev = useCallback(() => {
    setPageIdx((idx) => Math.max(0, idx - 1));
  }, []);

  const next = useCallback(() => {
    const nextCursor = result.page.next_cursor;
    if (nextCursor === null) return;
    setCursorStack((stack) =>
      stack.length > pageIdx + 1 ? stack : [...stack, nextCursor],
    );
    setPageIdx((idx) => idx + 1);
  }, [result.page.next_cursor, pageIdx]);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);
  const reset = useCallback(() => {
    setQRaw("");
    setDebouncedQ("");
    setCursorStack([undefined]);
    setPageIdx(0);
    setRefreshTick((t) => t + 1);
  }, []);

  return {
    items: result.page.items,
    total: result.page.total,
    page: pageIdx + 1,
    pageSize,
    loading,
    error: result.error,
    q,
    setQ,
    hasPrev: pageIdx > 0,
    hasNext: result.page.next_cursor !== null,
    prev,
    next,
    refresh,
    reset,
  };
}
