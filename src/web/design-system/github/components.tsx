// GitHub Primer implementation of the design-system contract.
//
// Primer 38's React package does NOT ship the design-token CSS — only the
// component CSS modules. We have to import `@primer/primitives` ourselves so
// that the actual `--bgColor-default`, `--fgColor-muted` etc. variables exist
// and respond to the `data-color-mode` / `data-light-theme` / `data-dark-theme`
// attributes that ThemeProvider sets. Without these imports BaseStyles falls
// back to its hardcoded light-mode default, which is why dark mode previously
// did nothing.

// Base primitives (motion, size, typography) — no color vars yet.
import "@primer/primitives/dist/css/primitives.css";
// Color themes. Both selectors are scoped by `[data-color-mode=...]`
// so we can load both simultaneously; only one wins at any time.
import "@primer/primitives/dist/css/functional/themes/light.css";
import "@primer/primitives/dist/css/functional/themes/dark.css";

import { useEffect, type ReactNode } from "react";
import type { ColorMode } from "../core/contract";
import { SheetShell } from "../core/sheet-shell";
import { DateTimeShell } from "../core/datetime-shell";
import {
  ThemeProvider as PrimerThemeProvider,
  BaseStyles,
  Button as PButton,
  TextInput as PTextInput,
  Textarea as PTextarea,
  Select as PSelect,
  Heading as PHeading,
  Text as PText,
  Link as PLink,
  Label,
  Flash,
  Spinner as PSpinner,
  FormControl,
} from "@primer/react";
import type { DesignSystem } from "../core/contract";

// Map our common ColorMode values onto Primer's vocabulary.
function primerColorMode(m: ColorMode | undefined): "auto" | "day" | "night" {
  if (m === "light") return "day";
  if (m === "dark") return "night";
  return "auto";
}

export const ThemeProvider = ({
  children, colorMode,
}: { children: ReactNode; colorMode?: ColorMode }) => {
  // Primer's ThemeProvider sets data-* attributes on a wrapper div, which
  // means its CSS variables only resolve INSIDE that subtree. Portal-rendered
  // content (e.g. our Sheet) lives outside it and would see undefined vars.
  // Mirror the same attributes onto <html> so the primitives CSS cascades
  // from the root and the portal can resolve `var(--bgColor-default)` etc.
  //
  // Also paint <html> with the theme background so the area exposed by
  // `viewport-fit=cover` (under the Android URL bar / iOS home-indicator
  // safe-area) renders the theme color rather than a default gray strip.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    const mode = colorMode === "light" ? "light"
      : colorMode === "dark" ? "dark"
      : "auto";
    html.setAttribute("data-color-mode", mode);
    html.setAttribute("data-light-theme", "light");
    html.setAttribute("data-dark-theme", "dark");
    html.style.background = "var(--bgColor-default)";
    document.body.style.background = "var(--bgColor-default)";
    return () => {
      // Don't strip on unmount — another plugin (or re-mount) may take over.
      // If user switches plugins, the new ThemeProvider's effect will overwrite.
    };
  }, [colorMode]);

  return (
    <PrimerThemeProvider colorMode={primerColorMode(colorMode)}>
      <BaseStyles>
        <div style={{
          background: "var(--bgColor-default)",
          color: "var(--fgColor-default)",
          minHeight: "100dvh",
        }}>
          {children}
        </div>
      </BaseStyles>
    </PrimerThemeProvider>
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
  const tag = ([null, "h1", "h2", "h3", "h4"] as const)[level]!;
  return <PHeading as={tag}>{children}</PHeading>;
};

export const Text: DesignSystem["Text"] = ({ children, muted }) => (
  <PText style={{ color: muted ? "var(--fgColor-muted)" : "var(--fgColor-default)" }}>{children}</PText>
);

export const Link: DesignSystem["Link"] = ({ href, onClick, children }) => (
  <PLink href={href} onClick={onClick}>{children}</PLink>
);

export const Button: DesignSystem["Button"] = ({
  children, onClick, type = "button", variant = "default", size, disabled, block,
}) => (
  <PButton
    onClick={onClick}
    type={type}
    variant={variant}
    size={size}
    disabled={disabled}
    block={block}
  >
    {children}
  </PButton>
);

export const TextInput: DesignSystem["TextInput"] = ({
  id, name, label, placeholder, type = "text", value, defaultValue,
  onChange, onBlur, required, disabled, error, block,
}) => (
  <FormControl required={required} disabled={disabled}>
    {label && <FormControl.Label>{label}</FormControl.Label>}
    <PTextInput
      id={id} name={name} placeholder={placeholder} type={type}
      value={value} defaultValue={defaultValue}
      onChange={onChange}
      onBlur={onBlur}
      block={block ?? true}
      validationStatus={error ? "error" : undefined}
    />
    {error && <FormControl.Validation variant="error">{error}</FormControl.Validation>}
  </FormControl>
);

export const Textarea: DesignSystem["Textarea"] = ({
  id, name, label, placeholder, value, defaultValue, onChange, rows = 4,
  required, disabled, error, block,
}) => (
  <FormControl required={required} disabled={disabled}>
    {label && <FormControl.Label>{label}</FormControl.Label>}
    <PTextarea
      id={id} name={name} placeholder={placeholder} rows={rows}
      value={value} defaultValue={defaultValue}
      onChange={onChange}
      block={block ?? true}
    />
    {error && <FormControl.Validation variant="error">{error}</FormControl.Validation>}
  </FormControl>
);

export const Select: DesignSystem["Select"] = ({
  id, name, label, value, defaultValue, onChange, options, disabled, error, block,
}) => (
  <FormControl disabled={disabled}>
    {label && <FormControl.Label>{label}</FormControl.Label>}
    <PSelect
      id={id} name={name} value={value} defaultValue={defaultValue}
      onChange={onChange} block={block ?? true}
    >
      {options.map((o) => (
        <PSelect.Option key={o.value} value={o.value}>{o.label}</PSelect.Option>
      ))}
    </PSelect>
    {error && <FormControl.Validation variant="error">{error}</FormControl.Validation>}
  </FormControl>
);

export const Card: DesignSystem["Card"] = ({ title, footer, children }) => (
  <div style={{
    border: "1px solid var(--borderColor-default)",
    borderRadius: 6, padding: 16, marginBottom: 16,
    background: "var(--bgColor-muted)",
    color: "var(--fgColor-default)",
  }}>
    {title && <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>}
    {children}
    {footer && (
      <div style={{
        marginTop: 16, paddingTop: 8,
        borderTop: "1px solid var(--borderColor-muted)",
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
  const variantMap = {
    info: "default", success: "success",
    warning: "warning", critical: "danger",
  } as const;
  return (
    <Flash variant={variantMap[variant]} style={{ marginBottom: 12 }}>
      {title && <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>}
      {children}
    </Flash>
  );
};

export const Form: DesignSystem["Form"] = ({ onSubmit, children }) => (
  <form onSubmit={onSubmit}>
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
  </form>
);

export const Spinner: DesignSystem["Spinner"] = ({ size = "medium", label }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
    <PSpinner size={size} />
    {label && <span style={{ color: "var(--fgColor-muted)" }}>{label}</span>}
  </span>
);

export const Badge: DesignSystem["Badge"] = ({ children, variant = "default" }) => {
  const scheme = {
    default: "secondary", primary: "accent", success: "success",
    danger: "danger", attention: "attention",
  } as const;
  return <Label variant={scheme[variant]}>{children}</Label>;
};

export const Sheet: DesignSystem["Sheet"] = ({ open, onClose, title, children }) => (
  <SheetShell
    open={open}
    onClose={onClose}
    title={title}
    tokens={{
      bg: "var(--bgColor-default)",
      fg: "var(--fgColor-default)",
      fgMuted: "var(--fgColor-muted)",
      border: "var(--borderColor-default)",
    }}
  >
    {children}
  </SheetShell>
);

export const DateTime: DesignSystem["DateTime"] = (props) => (
  <DateTimeShell
    {...props}
    tokens={{
      bg: "var(--bgColor-default)",
      fg: "var(--fgColor-default)",
      fgMuted: "var(--fgColor-muted)",
      border: "var(--borderColor-default)",
      borderDanger: "var(--fgColor-danger, #d1242f)",
    }}
    fontStack={`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`}
  />
);

