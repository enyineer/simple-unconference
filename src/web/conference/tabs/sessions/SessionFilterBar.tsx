import { useState } from "react";

// Search + tag + starred filter bar. Single rounded container that adapts
// from a horizontal row on desktop to a stacked layout on mobile via the
// `--uncon-filter-stack` media query rule below. All controls operate on
// client-side state in SessionsTab; nothing here hits the network.
export function SessionFilterBar({
  query,
  onQueryChange,
  availableTags,
  selectedTags,
  onToggleTag,
  starredOnly,
  onStarredOnlyChange,
  totalCount,
  visibleCount,
  anyFilterActive,
  onClear,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  availableTags: string[];
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  starredOnly: boolean;
  onStarredOnlyChange: (v: boolean) => void;
  totalCount: number;
  visibleCount: number;
  anyFilterActive: boolean;
  onClear: () => void;
}) {
  const border =
    "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";
  const borderFocus =
    "var(--borderColor-accent-emphasis, var(--uncon-accent, #0969da))";
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const fg = "var(--fgColor-default, var(--uncon-fg, inherit))";
  const bg = "var(--bgColor-default, var(--uncon-bg, transparent))";
  const bgSubtle =
    "var(--bgColor-subtle, var(--uncon-bg-subtle, rgba(0,0,0,0.025)))";

  const selectedSet = new Set(selectedTags);
  const [focused, setFocused] = useState(false);
  const showTagBlock = availableTags.length > 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 12,
        borderRadius: 10,
        border,
        background: bgSubtle,
      }}
    >
      {/* Row 1: search input + starred toggle.
            On mobile (`flexWrap`), the toggle drops to its own line. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            position: "relative",
            flex: "1 1 220px",
            minWidth: 0,
          }}
        >
          {/* Inline search glyph, left-aligned inside the input padding. */}
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: muted,
              pointerEvents: "none",
              display: "inline-flex",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="7" cy="7" r="5" />
              <line x1="11" y1="11" x2="14" y2="14" />
            </svg>
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search by title, speaker, tag…"
            aria-label="Filter sessions"
            style={{
              width: "100%",
              padding: "8px 32px 8px 32px",
              borderRadius: 8,
              border: `1px solid ${focused ? borderFocus : "var(--borderColor-default, var(--uncon-border, #d0d7de))"}`,
              boxShadow: focused
                ? `0 0 0 3px var(--bgColor-accent-muted, rgba(9,105,218,0.18))`
                : "none",
              background: bg,
              color: fg,
              fontSize: 14,
              outline: "none",
              transition: "border-color 120ms, box-shadow 120ms",
              WebkitAppearance: "none",
              appearance: "none",
            }}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onQueryChange("")}
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                width: 22,
                height: 22,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                color: muted,
                cursor: "pointer",
                borderRadius: 999,
                padding: 0,
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="3" y1="3" x2="13" y2="13" />
                <line x1="13" y1="3" x2="3" y2="13" />
              </svg>
            </button>
          )}
        </div>
        <button
          type="button"
          aria-pressed={starredOnly}
          onClick={() => onStarredOnlyChange(!starredOnly)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            border: `1px solid ${starredOnly ? borderFocus : "var(--borderColor-default, var(--uncon-border, #d0d7de))"}`,
            background: starredOnly
              ? "var(--bgColor-accent-muted, rgba(9,105,218,0.14))"
              : bg,
            color: starredOnly
              ? "var(--fgColor-accent, var(--uncon-accent, #0969da))"
              : fg,
            whiteSpace: "nowrap",
            transition: "background 120ms, border-color 120ms, color 120ms",
          }}
        >
          <span aria-hidden="true">{starredOnly ? "★" : "☆"}</span>
          Starred
        </button>
      </div>

      {/* Row 2: tag chips. Hidden when no session in the visible set has
          any tag — keeps the bar compact for brand-new conferences. */}
      {showTagBlock && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: muted,
              marginRight: 2,
            }}
          >
            Tags
          </span>
          {availableTags.map((tag) => {
            const on = selectedSet.has(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={on}
                onClick={() => onToggleTag(tag)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "4px 10px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  border: `1px solid ${on ? borderFocus : "var(--borderColor-default, var(--uncon-border, #d0d7de))"}`,
                  background: on
                    ? "var(--bgColor-accent-muted, rgba(9,105,218,0.14))"
                    : bg,
                  color: on
                    ? "var(--fgColor-accent, var(--uncon-accent, #0969da))"
                    : fg,
                  transition: "background 120ms, border-color 120ms, color 120ms",
                }}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {/* Row 3: result count + clear. Only renders when a filter is active so
          the bar is visually quiet at rest. */}
      {anyFilterActive && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            fontSize: 12,
            color: muted,
            borderTop: border,
            paddingTop: 10,
          }}
        >
          <span>
            Showing <span style={{ fontWeight: 600, color: fg }}>{visibleCount}</span>{" "}
            of {totalCount} {totalCount === 1 ? "session" : "sessions"}
          </span>
          <button
            type="button"
            onClick={onClear}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fgColor-accent, var(--uncon-accent, #0969da))",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 500,
              padding: 0,
            }}
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
