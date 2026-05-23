// Compact pager footer shared by every server-paginated list view. Renders
// "Showing X-Y of N" with Prev/Next buttons (and Page X/Y when known).
// Designed to be drop-in for `usePaginatedList`.

import { Button, Stack } from "../../design-system";

export function Pager({
  page,
  pageSize,
  total,
  loading,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  noun = "items",
}: {
  /** 1-based current page index. */
  page: number;
  pageSize: number;
  total: number;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  /** Plural noun for the count label ("sessions", "rooms"). */
  noun?: string;
}) {
  if (total === 0) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, (page - 1) * pageSize + pageSize);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <Stack
      direction="row"
      justify="between"
      align="center"
      wrap
      gap="condensed"
    >
      <span
        style={{
          fontSize: 12,
          color:
            "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
        }}
      >
        Showing {start}-{end} of {total} {noun}
        {pageCount > 1 ? ` · Page ${page}/${pageCount}` : ""}
      </span>
      <Stack direction="row" gap="condensed" align="center">
        <Button
          size="small"
          onClick={onPrev}
          disabled={!hasPrev || loading}
        >
          Prev
        </Button>
        <Button
          size="small"
          onClick={onNext}
          disabled={!hasNext || loading}
        >
          Next
        </Button>
      </Stack>
    </Stack>
  );
}
