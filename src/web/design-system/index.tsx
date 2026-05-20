// Design-system bridge.
//
// `<DesignSystemProvider pluginId="...">` loads the named plugin via a
// dynamic import() (so unused plugins stay out of the initial chunk) and
// publishes it through context, wrapped in the plugin's own ThemeProvider.
//
// The plugin id is supplied by the caller — typically driven by the current
// conference (a per-conference brand). For unscoped routes (login, conference
// list) a default is passed.

import {
  createContext, useContext, useEffect, useState,
  type ReactNode,
} from "react";
import type {
  DesignSystem, ButtonProps, TextInputProps, TextareaProps, SelectProps,
  StackProps, CardProps, BannerProps, HeadingProps, FormProps, SpinnerProps,
  LinkProps, BadgeProps, TextProps, BaseProps, ColorMode, SheetProps, DateTimeProps,
} from "./core/contract";
import { plugins, loadPlugin, type PluginEntry } from "./core/registry";

interface CtxValue {
  ds: DesignSystem;
  pluginId: string;
  available: PluginEntry[];
}

const Ctx = createContext<CtxValue | null>(null);

export function useDesignSystem(): CtxValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("DesignSystemProvider missing from tree");
  return v;
}

interface ProviderProps {
  pluginId: string;
  /** "auto" | "light" | "dark". Defaults to "auto" (follow OS). */
  colorMode?: ColorMode;
  children: ReactNode;
  /** Optional fallback while the plugin loads. */
  fallback?: ReactNode;
}

export function DesignSystemProvider({ pluginId, colorMode, children, fallback }: ProviderProps) {
  const [ds, setDs] = useState<DesignSystem | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDs(null);
    loadPlugin(pluginId).then((impl) => {
      if (!cancelled) setDs(impl);
    });
    return () => { cancelled = true; };
  }, [pluginId]);

  if (!ds) {
    return (
      <>{fallback ?? (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          minHeight: "100vh", color: "#777", fontFamily: "system-ui",
        }}>
          Loading design system…
        </div>
      )}</>
    );
  }

  return (
    <Ctx.Provider value={{ ds, pluginId, available: plugins }}>
      <ds.ThemeProvider colorMode={colorMode ?? "auto"}>{children}</ds.ThemeProvider>
    </Ctx.Provider>
  );
}

// ----- Component wrappers (delegate to the active plugin) ---------------

export const PageLayout = (p: BaseProps) => { const { ds } = useDesignSystem(); return <ds.PageLayout {...p} />; };
export const Heading    = (p: HeadingProps) => { const { ds } = useDesignSystem(); return <ds.Heading {...p} />; };
export const Text       = (p: TextProps) => { const { ds } = useDesignSystem(); return <ds.Text {...p} />; };
export const Link       = (p: LinkProps) => { const { ds } = useDesignSystem(); return <ds.Link {...p} />; };
export const Button     = (p: ButtonProps) => { const { ds } = useDesignSystem(); return <ds.Button {...p} />; };
export const TextInput  = (p: TextInputProps) => { const { ds } = useDesignSystem(); return <ds.TextInput {...p} />; };
export const Textarea   = (p: TextareaProps) => { const { ds } = useDesignSystem(); return <ds.Textarea {...p} />; };
export const Select     = (p: SelectProps) => { const { ds } = useDesignSystem(); return <ds.Select {...p} />; };
export const Card       = (p: CardProps) => { const { ds } = useDesignSystem(); return <ds.Card {...p} />; };
export const Stack      = (p: StackProps) => { const { ds } = useDesignSystem(); return <ds.Stack {...p} />; };
export const Banner     = (p: BannerProps) => { const { ds } = useDesignSystem(); return <ds.Banner {...p} />; };
export const Form       = (p: FormProps) => { const { ds } = useDesignSystem(); return <ds.Form {...p} />; };
export const Spinner    = (p: SpinnerProps) => { const { ds } = useDesignSystem(); return <ds.Spinner {...p} />; };
export const Badge      = (p: BadgeProps) => { const { ds } = useDesignSystem(); return <ds.Badge {...p} />; };
export const Sheet      = (p: SheetProps) => { const { ds } = useDesignSystem(); return <ds.Sheet {...p} />; };
export const DateTime   = (p: DateTimeProps) => { const { ds } = useDesignSystem(); return <ds.DateTime {...p} />; };

export type { DesignSystem } from "./core/contract";
