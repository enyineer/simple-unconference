// Keys identify which SettingsSection just saved successfully, so its
// checkmark animation runs (and adjacent sections stay quiet).
export type SavedKey =
  | "name"
  | "timezone"
  | "design"
  | "mixer"
  | "participant_submissions"
  | "session_reuse";

// Mod-only quota counters surfaced by the server in `conferences.get`. Each
// resource carries `limit: null` when the corresponding cap is disabled
// (env var = 0); the UsageCard hides those rows.
export interface UsageCounters {
  participants:    { current: number; limit: number | null };
  pending_invites: { current: number; limit: number | null };
  rooms:           { current: number; limit: number | null };
  total_sessions:  { current: number; limit: null };
}

export interface JoinLink {
  enabled: boolean;
  token: string | null;
  url: string | null;
  expires_at: number | null;
  max_uses: number | null;
  used_count: number;
}
