// Minimal design-system implementation — no vendor lib, just plain HTML +
// CSS variables. Honors `prefers-color-scheme: dark` automatically. Demonstrates
// that the contract is implementable without bringing in @primer/react.

import { useEffect, type ReactNode } from "react";
import type { DesignSystem, ButtonProps, ColorMode } from "../core/contract";
import { SheetShell } from "../core/sheet-shell";
import { DateTimeShell } from "../core/datetime-shell";

// CSS variables are wired by `ThemeProvider` via a <style> tag. ColorMode is
// driven by `data-uncon-color-mode` set on <html>:
//   - "auto"  → follow OS via @media (prefers-color-scheme: dark)
//   - "light" → force light
//   - "dark"  → force dark
const STYLE_ID = "uncon-minimal-vars";

// Define the dark vars in one place and reuse them via comma-separated selector
// (auto+os-dark, explicit dark).
const DARK_VARS = `
  --uncon-bg: #0d1117;
  --uncon-bg-subtle: #161b22;
  --uncon-fg: #e6edf3;
  --uncon-fg-muted: #8b949e;
  --uncon-border: #30363d;
  --uncon-border-muted: #21262d;
  --uncon-primary: #4f93ff;
  --uncon-primary-fg: #ffffff;
  --uncon-danger: #f47067;
  --uncon-success: #56d364;
  --uncon-warning: #e3b341;
  --uncon-info: #4f93ff;
  --uncon-badge-default-bg: #21262d;
  --uncon-badge-default-fg: #c9d1d9;
  --uncon-badge-primary-bg: #1f3a68;
  --uncon-badge-primary-fg: #79b8ff;
  --uncon-badge-success-bg: #1c3a2a;
  --uncon-badge-success-fg: #7ee787;
  --uncon-badge-danger-bg:  #4a2225;
  --uncon-badge-danger-fg:  #ffa198;
  --uncon-badge-attention-bg: #4d3a14;
  --uncon-badge-attention-fg: #ffd685;
`;

const cssVars = `
:root[data-uncon-theme="minimal"] {
  --uncon-bg: #ffffff;
  --uncon-bg-subtle: #f8fafc;
  --uncon-fg: #111418;
  --uncon-fg-muted: #5d6471;
  --uncon-border: #d1d5db;
  --uncon-border-muted: #e5e7eb;
  --uncon-primary: #2563eb;
  --uncon-primary-fg: #ffffff;
  --uncon-danger: #dc2626;
  --uncon-success: #16a34a;
  --uncon-warning: #d97706;
  --uncon-info: #2563eb;
  --uncon-badge-default-bg: #e5e7eb;
  --uncon-badge-default-fg: #374151;
  --uncon-badge-primary-bg: #dbeafe;
  --uncon-badge-primary-fg: #1d4ed8;
  --uncon-badge-success-bg: #dcfce7;
  --uncon-badge-success-fg: #166534;
  --uncon-badge-danger-bg:  #fee2e2;
  --uncon-badge-danger-fg:  #991b1b;
  --uncon-badge-attention-bg: #fef3c7;
  --uncon-badge-attention-fg: #92400e;
}

/* Forced dark (regardless of OS). */
:root[data-uncon-theme="minimal"][data-uncon-color-mode="dark"] {${DARK_VARS}}

/* Auto: follow OS dark mode. */
@media (prefers-color-scheme: dark) {
  :root[data-uncon-theme="minimal"][data-uncon-color-mode="auto"] {${DARK_VARS}}
}

@keyframes uncon-spin { to { transform: rotate(360deg); } }
`;

const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;

function installStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = cssVars;
  document.head.appendChild(el);
}

export const ThemeProvider = ({
  children, colorMode,
}: { children: ReactNode; colorMode?: ColorMode }) => {
  installStyle();
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-uncon-theme", "minimal");
    document.documentElement.setAttribute("data-uncon-color-mode", colorMode ?? "auto");
  }
  // Paint <html> and <body> with the theme bg so the area exposed by
  // `viewport-fit=cover` (under the Android URL bar / iOS home-indicator
  // safe-area) renders the theme color rather than a default gray strip.
  // Assignments must happen in an effect (react-hooks/immutability).
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.background = "var(--uncon-bg)";
    document.body.style.background = "var(--uncon-bg)";
  }, [colorMode]);
  return (
    <div style={{
      fontFamily: FONT_STACK,
      color: "var(--uncon-fg)",
      background: "var(--uncon-bg)",
      minHeight: "100dvh",
    }}>
      {children}
    </div>
  );
};

export const PageLayout: DesignSystem["PageLayout"] = ({ children }) => (
  <div style={{
    maxWidth: 960,
    margin: "0 auto",
    padding: "24px max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left))",
  }}>{children}</div>
);

export const Heading: DesignSystem["Heading"] = ({ children, level = 1 }) => {
  const sizes = { 1: 28, 2: 22, 3: 18, 4: 16 } as const;
  const style: React.CSSProperties = {
    fontSize: sizes[level], margin: "0 0 8px",
    fontWeight: 600, color: "var(--uncon-fg)",
  };
  switch (level) {
    case 1: return <h1 style={style}>{children}</h1>;
    case 2: return <h2 style={style}>{children}</h2>;
    case 3: return <h3 style={style}>{children}</h3>;
    case 4: return <h4 style={style}>{children}</h4>;
  }
};

export const Text: DesignSystem["Text"] = ({ children, muted }) => (
  <span style={{ color: muted ? "var(--uncon-fg-muted)" : "var(--uncon-fg)" }}>{children}</span>
);

export const Link: DesignSystem["Link"] = ({ href, onClick, children }) => (
  <a href={href} onClick={onClick} style={{ color: "var(--uncon-primary)", textDecoration: "none" }}>
    {children}
  </a>
);

function buttonStyle(variant: NonNullable<ButtonProps["variant"]>, disabled?: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    border: "1px solid",
    borderRadius: 6, padding: "6px 14px",
    fontFamily: FONT_STACK, fontSize: 14, fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: "background 0.1s",
  };
  switch (variant) {
    case "primary":
      return { ...base, background: "var(--uncon-primary)", color: "var(--uncon-primary-fg)", borderColor: "var(--uncon-primary)" };
    case "danger":
      return { ...base, background: "var(--uncon-bg)", color: "var(--uncon-danger)", borderColor: "var(--uncon-danger)" };
    case "invisible":
      return { ...base, background: "transparent", color: "var(--uncon-fg)", borderColor: "transparent" };
    case "default":
    default:
      return { ...base, background: "var(--uncon-bg)", color: "var(--uncon-fg)", borderColor: "var(--uncon-border)" };
  }
}

export const Button: DesignSystem["Button"] = ({
  children, onClick, type = "button", variant = "default", disabled, block,
}) => (
  <button
    type={type} onClick={onClick} disabled={disabled}
    style={{ ...buttonStyle(variant, disabled), width: block ? "100%" : undefined }}
  >
    {children}
  </button>
);

function FieldShell({
  label, error, children, required, disabled,
}: { label?: string; error?: string; children: ReactNode; required?: boolean; disabled?: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, opacity: disabled ? 0.6 : 1 }}>
      {label && (
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--uncon-fg)" }}>
          {label}{required && <span style={{ color: "var(--uncon-danger)", marginLeft: 2 }}>*</span>}
        </span>
      )}
      {children}
      {error && <span style={{ fontSize: 12, color: "var(--uncon-danger)" }}>{error}</span>}
    </label>
  );
}

function inputStyle(error?: string, block?: boolean): React.CSSProperties {
  return {
    border: `1px solid ${error ? "var(--uncon-danger)" : "var(--uncon-border)"}`,
    borderRadius: 6, padding: "6px 10px",
    fontSize: 14, fontFamily: FONT_STACK,
    background: "var(--uncon-bg)",
    color: "var(--uncon-fg)",
    width: block ? "100%" : undefined,
    boxSizing: "border-box",
  };
}

export const TextInput: DesignSystem["TextInput"] = ({
  id, name, label, placeholder, type = "text", value, defaultValue,
  onChange, onBlur, required, disabled, error, block,
}) => (
  <FieldShell label={label} error={error} required={required} disabled={disabled}>
    <input
      id={id} name={name} placeholder={placeholder} type={type}
      value={value} defaultValue={defaultValue}
      onChange={onChange} onBlur={onBlur} required={required} disabled={disabled}
      style={inputStyle(error, block ?? true)}
    />
  </FieldShell>
);

export const Textarea: DesignSystem["Textarea"] = ({
  id, name, label, placeholder, value, defaultValue, onChange, rows = 4,
  required, disabled, error, block,
}) => (
  <FieldShell label={label} error={error} required={required} disabled={disabled}>
    <textarea
      id={id} name={name} placeholder={placeholder} rows={rows}
      value={value} defaultValue={defaultValue}
      onChange={onChange} required={required} disabled={disabled}
      style={{ ...inputStyle(error, block ?? true), resize: "vertical" }}
    />
  </FieldShell>
);

export const Select: DesignSystem["Select"] = ({
  id, name, label, value, defaultValue, onChange, options, disabled, error, block,
}) => (
  <FieldShell label={label} error={error} disabled={disabled}>
    <select
      id={id} name={name} value={value} defaultValue={defaultValue}
      onChange={onChange} disabled={disabled}
      style={inputStyle(error, block ?? true)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  </FieldShell>
);

export const Card: DesignSystem["Card"] = ({ title, footer, children }) => (
  <div style={{
    border: "1px solid var(--uncon-border)",
    borderRadius: 8, padding: 16, marginBottom: 16,
    background: "var(--uncon-bg-subtle)",
    color: "var(--uncon-fg)",
  }}>
    {title && <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>}
    {children}
    {footer && (
      <div style={{
        marginTop: 16, paddingTop: 8,
        borderTop: "1px solid var(--uncon-border-muted)",
      }}>{footer}</div>
    )}
  </div>
);

export const Stack: DesignSystem["Stack"] = ({
  children, direction = "column", gap = "normal", align, justify, wrap,
}) => {
  const gapPx = gap === "condensed" ? 8 : gap === "spacious" ? 24 : 16;
  const justifyContent = justify === "between" ? "space-between" : justify ? `flex-${justify}` : undefined;
  // CSS align-items: "center" and "stretch" are bare keywords; only "start"
  // and "end" take the `flex-` prefix. (Writing `flex-center` produces an
  // invalid value, which silently falls back to "stretch".)
  const alignItems = align === "stretch" || align === "center"
    ? align
    : align ? `flex-${align}` : undefined;
  return (
    <div style={{
      display: "flex", flexDirection: direction, gap: gapPx,
      alignItems, justifyContent,
      flexWrap: wrap ? "wrap" : undefined,
    }}>
      {children}
    </div>
  );
};

export const Banner: DesignSystem["Banner"] = ({ variant = "info", title, children }) => {
  const colorVar = ({
    info: "var(--uncon-info)", success: "var(--uncon-success)",
    warning: "var(--uncon-warning)", critical: "var(--uncon-danger)",
  } as const)[variant];
  return (
    <div style={{
      border: `1px solid ${colorVar}`,
      borderLeft: `4px solid ${colorVar}`,
      borderRadius: 6, padding: 12, marginBottom: 12,
      background: "var(--uncon-bg-subtle)",
      color: "var(--uncon-fg)",
    }}>
      {title && <div style={{ fontWeight: 600, marginBottom: 4, color: colorVar }}>{title}</div>}
      {children}
    </div>
  );
};

export const Form: DesignSystem["Form"] = ({ onSubmit, children }) => (
  <form onSubmit={onSubmit}>
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
  </form>
);

export const Spinner: DesignSystem["Spinner"] = ({ size = "medium", label }) => {
  const sizePx = size === "small" ? 14 : size === "large" ? 32 : 20;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{
        display: "inline-block",
        width: sizePx, height: sizePx,
        border: "2px solid var(--uncon-border-muted)",
        borderTopColor: "var(--uncon-primary)",
        borderRadius: "50%",
        animation: "uncon-spin 0.8s linear infinite",
      }} />
      {label && <span style={{ color: "var(--uncon-fg-muted)" }}>{label}</span>}
    </span>
  );
};

export const Badge: DesignSystem["Badge"] = ({ children, variant = "default" }) => {
  const bg = `var(--uncon-badge-${variant}-bg)`;
  const fg = `var(--uncon-badge-${variant}-fg)`;
  return (
    <span style={{
      background: bg, color: fg,
      borderRadius: 999, padding: "2px 8px",
      fontSize: 12, fontWeight: 500, whiteSpace: "nowrap",
    }}>{children}</span>
  );
};

export const Sheet: DesignSystem["Sheet"] = ({ open, onClose, title, children }) => (
  <SheetShell
    open={open}
    onClose={onClose}
    title={title}
    tokens={{
      bg: "var(--uncon-bg)",
      fg: "var(--uncon-fg)",
      fgMuted: "var(--uncon-fg-muted)",
      border: "var(--uncon-border)",
    }}
  >
    {children}
  </SheetShell>
);

export const DateTime: DesignSystem["DateTime"] = (props) => (
  <DateTimeShell
    {...props}
    tokens={{
      bg: "var(--uncon-bg)",
      fg: "var(--uncon-fg)",
      fgMuted: "var(--uncon-fg-muted)",
      border: "var(--uncon-border)",
      borderDanger: "var(--uncon-danger)",
    }}
    fontStack={FONT_STACK}
  />
);

