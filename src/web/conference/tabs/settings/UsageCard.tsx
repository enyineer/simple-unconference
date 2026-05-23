import { Stack, Text } from "../../../design-system";
import { SettingsSection } from "../../ui/SettingsSection";
import type { UsageCounters } from "./types";

// ----- usage card ----------------------------------------------------------

// Mod-only "how full is this conference" surface. Reads the snapshot baked
// into `conferences.get` (refreshed on tab focus via the parent). Bars go
// yellow at >=80% (matching the server's quota_threshold notification
// trigger) and red at the cap.
export function UsageCard({ usage }: { usage: UsageCounters }) {
  const rows: Array<{ label: string; current: number; limit: number | null }> = [
    { label: "Participants",    current: usage.participants.current,    limit: usage.participants.limit },
    { label: "Pending invites", current: usage.pending_invites.current, limit: usage.pending_invites.limit },
    { label: "Rooms",           current: usage.rooms.current,           limit: usage.rooms.limit },
    { label: "Total sessions",  current: usage.total_sessions.current,  limit: usage.total_sessions.limit },
  ];

  return (
    <SettingsSection
      title="Usage"
      description="How close this conference is to the instance's per-conference caps. Bars highlight at 80% and turn red at the cap; mods get a notification at the same thresholds."
      saved={false}
    >
      <Stack gap="condensed">
        {rows.map((r) => (
          <UsageRow key={r.label} {...r} />
        ))}
      </Stack>
    </SettingsSection>
  );
}

function UsageRow({ label, current, limit }: { label: string; current: number; limit: number | null }) {
  // When limit is null we still show the count (useful situational signal)
  // but skip the bar — there's no scale to draw against.
  const ratio = limit && limit > 0 ? Math.min(1, current / limit) : null;
  const pct = ratio === null ? null : Math.round(ratio * 100);
  const state: "ok" | "warn" | "full" =
    ratio === null
      ? "ok"
      : ratio >= 1
        ? "full"
        : ratio >= 0.8
          ? "warn"
          : "ok";
  const barColor =
    state === "full" ? "var(--fgColor-danger, #cf222e)"
      : state === "warn" ? "var(--fgColor-attention, #9a6700)"
        : "var(--fgColor-accent, #2563eb)";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <Text>{label}</Text>
        <Text muted>
          {limit === null ? `${current} (no cap)` : `${current} / ${limit}${pct !== null ? ` · ${pct}%` : ""}`}
        </Text>
      </div>
      {ratio !== null && (
        <div
          style={{
            marginTop: 4,
            height: 6,
            borderRadius: 3,
            background: "var(--bgColor-muted, rgba(127,127,127,0.18))",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${ratio * 100}%`,
              height: "100%",
              background: barColor,
              transition: "width 200ms ease",
            }}
          />
        </div>
      )}
    </div>
  );
}
