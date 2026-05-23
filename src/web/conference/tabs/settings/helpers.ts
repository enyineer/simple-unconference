import { useMemo } from "react";
import { listTimeZones } from "../../../../shared/tz";

// One-shot memoization for the IANA timezone list inside SettingsTab.
export function useMemoTimezones() {
  return useMemo(() => listTimeZones().map((tz) => ({ value: tz, label: tz })), []);
}

export function absoluteUrl(relative: string): string {
  return `${window.location.origin}/#${relative}`;
}

export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes())
  );
}

export function fromDatetimeLocal(s: string): number {
  return new Date(s).getTime();
}

export function parsePositiveInt(s: string): number | null {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
