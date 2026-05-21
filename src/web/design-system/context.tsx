// Design-system context + hook. Kept in its own file (separate from
// design-system/index.tsx which holds the React components) so that the
// component file stays Fast-Refresh-friendly — react-refresh/only-export-
// components fires when a file mixes component and non-component exports.

import { createContext, useContext } from "react";
import type { DesignSystem } from "./core/contract";
import type { PluginEntry } from "./core/registry";

export interface CtxValue {
  ds: DesignSystem;
  pluginId: string;
  available: PluginEntry[];
}

export const DesignSystemCtx = createContext<CtxValue | null>(null);

export function useDesignSystem(): CtxValue {
  const v = useContext(DesignSystemCtx);
  if (!v) throw new Error("DesignSystemProvider missing from tree");
  return v;
}
