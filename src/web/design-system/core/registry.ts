// Plugin registry. Each plugin is loaded lazily via dynamic import() so that
// unused implementations don't ship in the initial JS bundle. Vite emits one
// chunk per import() boundary.

import type { DesignSystem } from "./contract";

export interface PluginEntry {
  id: string;
  label: string;
  load: () => Promise<DesignSystem>;
}

export const plugins: PluginEntry[] = [
  {
    id: "github",
    label: "GitHub Primer",
    load: () => import("../github").then((m) => m.github),
  },
  {
    id: "minimal",
    label: "Minimal",
    load: () => import("../minimal").then((m) => m.minimal),
  },
];

const cache = new Map<string, Promise<DesignSystem>>();

export function loadPlugin(id: string): Promise<DesignSystem> {
  const entry = plugins.find((p) => p.id === id) ?? plugins[0]!;
  const cached = cache.get(entry.id);
  if (cached) return cached;
  const promise = entry.load();
  cache.set(entry.id, promise);
  return promise;
}

export const DEFAULT_PLUGIN_ID = plugins[0]!.id;
