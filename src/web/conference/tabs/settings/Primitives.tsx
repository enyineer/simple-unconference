// ---------------------------------------------------------------------------
// Small presentational helpers, scoped to this tab so they don't pollute the
// design system. They mirror the look + token usage of the design system's
// own primitives.

export function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 8, height: 8, borderRadius: "50%",
        background: on
          ? "var(--fgColor-success, var(--bgColor-success-emphasis, #1a7f37))"
          : "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
        boxShadow: on ? "0 0 0 3px var(--bgColor-success-muted, rgba(26,127,55,0.15))" : "none",
        display: "inline-block",
      }}
    />
  );
}

export function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{
      display: "flex", flexDirection: "column", gap: 4,
      fontSize: 13, minWidth: 0, flex: "0 1 auto",
    }}>
      <span style={{
        fontWeight: 600,
        color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
        fontSize: 12,
      }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const nativeInputBaseStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
  borderRadius: 6,
  background: "var(--bgColor-default, var(--uncon-bg, #fff))",
  color: "var(--fgColor-default, var(--uncon-fg, inherit))",
  font: "inherit",
  fontSize: 13,
  lineHeight: "20px",
  minHeight: 32,
  boxSizing: "border-box",
};

export function NativeInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { style, ...rest } = props;
  return <input {...rest} style={{ ...nativeInputBaseStyle, ...style }} />;
}

export function ReadonlyUrlInput({ value }: { value: string }) {
  return (
    <input
      readOnly
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      style={{
        ...nativeInputBaseStyle,
        flex: 1,
        minWidth: 0,
        width: "100%",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
        cursor: "text",
      }}
    />
  );
}

export function Divider() {
  return (
    <div
      aria-hidden
      style={{
        height: 1, width: "100%",
        background: "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
      }}
    />
  );
}
