// Two-line checkbox row: bold label on the first line next to the box,
// muted description aligned underneath. Replaces the older single-line
// "label — muted hint" layout, which crowded into a tiny column on the
// right of the box and wrapped awkwardly on narrow viewports.
export function CheckboxField({
  checked, onChange, label, description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        fontSize: 13,
        color: "var(--fgColor-default, var(--uncon-fg, inherit))",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, flexShrink: 0 }}
      />
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span
          style={{
            color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
            fontSize: 12,
            lineHeight: "16px",
          }}
        >
          {description}
        </span>
      </span>
    </label>
  );
}
