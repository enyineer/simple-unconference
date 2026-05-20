// The design-system contract. Plugins implement this interface; the app
// imports component wrappers (Button, Card, etc.) that read the active impl
// from React context — so the underlying lib can be swapped at runtime.

import type { ReactNode, FormEvent, ChangeEvent, FocusEvent } from "react";

export interface BaseProps {
  children?: ReactNode;
  className?: string;
}

export interface ButtonProps extends BaseProps {
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
  variant?: "primary" | "default" | "danger" | "invisible";
  size?: "small" | "medium" | "large";
  disabled?: boolean;
  block?: boolean;
}

export interface TextInputProps {
  id?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  type?: "text" | "email" | "password" | "number" | "url";
  value?: string;
  defaultValue?: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  block?: boolean;
}

export interface TextareaProps {
  id?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  block?: boolean;
}

export interface SelectProps {
  id?: string;
  name?: string;
  label?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  error?: string;
  block?: boolean;
}

export interface StackProps extends BaseProps {
  direction?: "row" | "column";
  gap?: "condensed" | "normal" | "spacious";
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
}

export interface CardProps extends BaseProps {
  title?: string;
  footer?: ReactNode;
}

export interface BannerProps extends BaseProps {
  variant?: "info" | "success" | "warning" | "critical";
  title?: string;
}

export interface HeadingProps extends BaseProps {
  level?: 1 | 2 | 3 | 4;
}

export interface FormProps extends BaseProps {
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
}

export interface SpinnerProps {
  size?: "small" | "medium" | "large";
  label?: string;
}

export interface LinkProps extends BaseProps {
  href: string;
  onClick?: (e: React.MouseEvent) => void;
}

export interface BadgeProps extends BaseProps {
  variant?: "default" | "primary" | "success" | "danger" | "attention";
}

export interface TextProps extends BaseProps {
  muted?: boolean;
}

// Value is an absolute epoch (ms). The component converts to/from a local
// wall-clock string in `timeZone` (defaults to the viewer's browser local).
export interface DateTimeProps {
  id?: string;
  name?: string;
  label?: string;
  value: number;
  onChange: (ms: number) => void;
  /** IANA timezone (e.g. "Europe/Berlin") to interpret the wall clock in. */
  timeZone?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  block?: boolean;
  min?: number;
  max?: number;
}

export interface SheetProps extends BaseProps {
  /** Whether the sheet is shown. When false, the component renders nothing. */
  open: boolean;
  /** Called when the backdrop is clicked, ESC pressed, or the close button used. */
  onClose: () => void;
  /** Optional sheet title rendered in the header. */
  title?: string;
}

export type ColorMode = "auto" | "light" | "dark";

// What every design-system plugin must export.
export interface DesignSystem {
  // Plugin metadata
  id: string;
  label: string;

  // Top-level providers (theme + page chrome). `colorMode` overrides the
  // OS preference: "auto" follows `prefers-color-scheme`, otherwise force.
  ThemeProvider: React.ComponentType<{ children: ReactNode; colorMode?: ColorMode }>;
  PageLayout: React.ComponentType<BaseProps>;

  // Components
  Heading: React.ComponentType<HeadingProps>;
  Text: React.ComponentType<TextProps>;
  Link: React.ComponentType<LinkProps>;
  Button: React.ComponentType<ButtonProps>;
  TextInput: React.ComponentType<TextInputProps>;
  Textarea: React.ComponentType<TextareaProps>;
  Select: React.ComponentType<SelectProps>;
  Card: React.ComponentType<CardProps>;
  Stack: React.ComponentType<StackProps>;
  Banner: React.ComponentType<BannerProps>;
  Form: React.ComponentType<FormProps>;
  Spinner: React.ComponentType<SpinnerProps>;
  Badge: React.ComponentType<BadgeProps>;
  Sheet: React.ComponentType<SheetProps>;
  DateTime: React.ComponentType<DateTimeProps>;
}
