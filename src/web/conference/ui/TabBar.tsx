// Underline-style tab bar. The active tab is marked by a colored bottom
// border + bolder weight; inactive tabs are muted. Horizontal scroll kicks
// in if the row gets too wide for mobile.

export function TabBar<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
        overflowX: "auto",
      }}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "none",
              borderBottom: active
                ? "2px solid var(--borderColor-accent-emphasis, var(--uncon-primary, #2563eb))"
                : "2px solid transparent",
              marginBottom: -1, // overlap the container's bottom border
              color: active
                ? "var(--fgColor-default, var(--uncon-fg, inherit))"
                : "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              fontWeight: active ? 600 : 500,
              fontSize: 14,
              fontFamily: "inherit",
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "color 0.12s ease",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
